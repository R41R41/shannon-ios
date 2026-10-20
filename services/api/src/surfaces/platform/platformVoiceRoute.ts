import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerAuthorized } from '../../infra/auth/apiAuth.js';
import { consumeDeviceAllowance, readJson, sendJson } from '../../infra/http/serverHttp.js';
import { startStream, writeEvent } from '../../infra/http/ndjsonStream.js';
import { PlatformBridgeError } from '../../mind/memory/platformMemoryPorts.js';
import { ElevenSpeechError, validatedElevenTags, type ElevenSpeechGateway } from '../../infra/models/elevenSpeech.js';
import { GeminiSpeechError, normalizedSpeechText } from '../../infra/models/geminiSpeech.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { switchOn, type SwitchValues } from '@shannon/switches';
import { streamSpeech, SpeechScopeConcurrencyLimiter, refuseSpeech } from '../voice/serverGeminiSpeechRoute.js';
import { SHANNON_PLATFORM_VOICE_PREFIX, platformVoiceEnabled, type PlatformVoiceService, type VoiceTurnLine } from './platformVoice.js';
import { VOICE_FILLERS } from './voiceFillers.js';
import { VOICE_MOUTH_LIMITS, VOICE_MOUTH_RESULTS, type VoiceMouthQueue } from './voiceMouth.js';

/**
 * `/v1/platform/voice/*` (dc-voice, 2026-10-20): what a platform runtime in a voice channel asks of her one mind. The bridge's service
 * token only, like the rest of `/v1/platform/*`; every route answers 503 `PLATFORM_VOICE_DISABLED` while `SHANNON_DC_VOICE` is off.
 *
 * - `POST turn` (NDJSON): the reply to what was said (`PlatformVoiceService.turn`).
 * - `POST speech`: PCM audio (24 kHz, mono, s16le) of a line in her ElevenLabs voice, streamed as it is made.
 * - `GET fillers`: the short sounds a `decision` line may name, for the body to keep as audio.
 * - `POST say` / `POST mouth/poll` / `POST mouth/result`: her mouth (`voiceMouth.ts`, `dc-speak-interface.md`).
 * - `POST wording`: event facts put into her words. `POST said`: what she said by herself, or was heard saying before being talked over.
 */
export interface PlatformVoiceRoutes {
  service: PlatformVoiceService;
  mouth: VoiceMouthQueue;
  /** The ElevenLabs gateway of this server; null while its key or voice is not configured (speech answers 503). */
  speech: Pick<ElevenSpeechGateway, 'stream'> | null;
  scopeKey: string;
  environment?: () => SwitchValues;
}

const MAXIMUM_SPEECH_CHARACTERS = 400;
const MAXIMUM_POLL_BODY_BYTES = 2 * 1024;
const speechUsage = new Map<string, { startedAt: number; count: number }>();
/** Two sentences are made ahead while one is played, and a filler besides: more than the app's own two at once. */
const speechScopes = new SpeechScopeConcurrencyLimiter(4);

export function isPlatformVoicePath(path: string): boolean {
  return path.startsWith(SHANNON_PLATFORM_VOICE_PREFIX);
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  if (error instanceof PlatformBridgeError) return sendJson(response, error.status, { error: error.code, message: error.message });
  if (error instanceof SyntaxError) return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'JSON body is invalid.' });
  throw error;
}

export async function handlePlatformVoiceRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  authorization: { token: string } | null,
  routes: PlatformVoiceRoutes | null,
): Promise<void> {
  const name = path.slice(SHANNON_PLATFORM_VOICE_PREFIX.length);
  const method = name === 'fillers' ? 'GET' : 'POST';
  if (request.method !== method) return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!authorization) return sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
  if (!bearerAuthorized(request.headers.authorization, authorization.token)) return sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
  const environment = routes?.environment?.() ?? serverEnvironment();
  if (!routes || !platformVoiceEnabled(environment)) {
    return sendJson(response, 503, { error: 'PLATFORM_VOICE_DISABLED', message: 'Voice channel replies are switched off on the server.' });
  }
  try {
    switch (name) {
      case 'turn': return await turn(request, response, routes);
      case 'speech': return await speech(request, response, routes);
      case 'fillers': return sendJson(response, 200, { items: VOICE_FILLERS.map(({ id, text, style }) => ({ id, text, style })) });
      case 'wording': return sendJson(response, 200, await routes.service.wording(await readJson(request, 8 * 1024)));
      case 'said': routes.service.said(await readJson(request, 8 * 1024)); response.writeHead(204); response.end(); return;
      case 'say': case 'mouth/poll': case 'mouth/result':
        if (!switchOn(environment, 'SHANNON_DC_VOICE_MOUTH')) {
          return sendJson(response, 503, { error: 'PLATFORM_VOICE_MOUTH_DISABLED', message: 'Her mouth in the voice channel is switched off on the server.' });
        }
        return await mouth(name, request, response, routes);
      default: return sendJson(response, 404, { error: 'NOT_FOUND' });
    }
  } catch (error) {
    sendFailure(response, error);
  }
}

/** The turn's lines are queued and written in order; the turn never waits for the reader and is never stopped by it. */
async function turn(request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  const body = await readJson(request, 32 * 1024);
  let queue = Promise.resolve();
  let failed = false;
  const write = (line: VoiceTurnLine): void => {
    queue = queue.then(async () => {
      if (failed || response.destroyed) return;
      try { startStream(response); await writeEvent(response, line); } catch { failed = true; }
    });
  };
  try {
    await routes.service.turn(body, write);
  } catch (error) {
    await queue;
    // Before the first line: a JSON error. After it the service has written an `error` line instead of throwing.
    if (!response.headersSent) throw error;
    console.error('Shannon platform voice turn failed', { name: error instanceof Error ? error.name : 'Error' });
  }
  await queue;
  if (!response.destroyed) response.end();
}

async function speech(request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  const body = await readJson(request, 8 * 1024);
  const values = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (!routes.speech) {
    return sendJson(response, 503, { error: 'ELEVEN_SPEECH_NOT_CONFIGURED', message: '声の合成は、いま使えません。' });
  }
  let text: string;
  let style: string | undefined;
  try {
    text = normalizedSpeechText(values.text);
    if (Array.from(text).length > MAXIMUM_SPEECH_CHARACTERS) throw new ElevenSpeechError('ELEVEN_SPEECH_INVALID_STYLE');
    if (values.style !== undefined && typeof values.style !== 'string') throw new ElevenSpeechError('ELEVEN_SPEECH_INVALID_STYLE');
    style = values.style as string | undefined;
    validatedElevenTags(style);
  } catch (error) {
    if (!(error instanceof ElevenSpeechError || error instanceof GeminiSpeechError)) throw error;
    return sendJson(response, 400, { error: 'SPEECH_INVALID', message: '読み上げる文章または演技指定が不正です。' });
  }
  if (!speechScopes.acquire(routes.scopeKey)) return refuseSpeech(response, 'BUSY', 'eleven');
  const startedAt = performance.now();
  try {
    if (!consumeDeviceAllowance(speechUsage, routes.scopeKey, 180)) return refuseSpeech(response, 'RATE_LIMITED', 'eleven');
    // The time to the first chunk is a header, set before `streamSpeech` writes its own.
    const timed: Pick<ElevenSpeechGateway, 'stream'> = {
      async stream(speechRequest, signal) {
        const result = await routes.speech!.stream(speechRequest, signal);
        const chunks = result.chunks;
        return {
          ...result,
          chunks: (async function* () {
            let first = true;
            for await (const chunk of chunks) {
              if (first) { first = false; response.setHeader('x-shannon-first-chunk-ms', String(Math.round(performance.now() - startedAt))); }
              yield chunk;
            }
          })(),
        };
      },
    };
    await streamSpeech(request, response, timed, { scopeKey: routes.scopeKey, text, ...(style ? { style } : {}) }, 'eleven');
  } catch (error) {
    if (!(error instanceof ElevenSpeechError)) throw error;
    console.warn('Shannon voice speech failed', { code: error.code });
    if (response.headersSent) { response.destroy(); return; }
    sendJson(response, 502, { error: error.code, message: '音声を生成できませんでした。' });
  } finally {
    speechScopes.release(routes.scopeKey);
  }
}

async function mouth(name: 'say' | 'mouth/poll' | 'mouth/result', request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  const body = await readJson(request, name === 'mouth/poll' ? MAXIMUM_POLL_BODY_BYTES : 16 * 1024);
  const values = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (name === 'say') {
    const accepted = routes.mouth.say(values as unknown as Parameters<VoiceMouthQueue['say']>[0]);
    return sendJson(response, accepted.accepted ? 202 : accepted.reason === 'invalid' ? 400 : accepted.reason === 'rate_limited' ? 429 : 503, accepted);
  }
  if (name === 'mouth/result') {
    if (typeof values.id !== 'string' || typeof values.status !== 'string' || !VOICE_MOUTH_RESULTS.includes(values.status as never)) {
      return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'id and status are required.' });
    }
    routes.mouth.result(values.id, values.status);
    response.writeHead(204);
    response.end();
    return;
  }
  const waitMs = typeof values.waitMs === 'number' ? values.waitMs : VOICE_MOUTH_LIMITS.pollMaximumMilliseconds;
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  const items = await routes.mouth.poll(waitMs, controller.signal);
  if (response.destroyed) return;
  sendJson(response, 200, { items });
}
