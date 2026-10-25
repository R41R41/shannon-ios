import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerAuthorized } from '../../infra/auth/apiAuth.js';
import { consumeDeviceAllowance, readJson, sendJson } from '../../infra/http/serverHttp.js';
import { startStream, writeEvent } from '../../infra/http/ndjsonStream.js';
import { PlatformBridgeError } from '../../mind/memory/platformMemoryPorts.js';
import { ElevenSpeechError, validatedElevenTags, type ElevenSpeechGateway } from '../../infra/models/elevenSpeech.js';
import { GeminiSpeechError, normalizedSpeechText } from '../../infra/models/geminiSpeech.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { switchOn, type SwitchValues } from '@shannon/switches';
import { SHANNON_PLATFORM_VOICE_PREFIX, platformVoiceEnabled, type VoiceTurnLine } from './platformVoiceRequest.js';
import type { PlatformVoiceService } from './platformVoice.js';
import { VOICE_FILLERS } from './voiceFillers.js';
import { VOICE_MOUTH_LIMITS, VOICE_MOUTH_RESULTS, type VoiceMouthQueue, type VoiceMouthSay } from './voiceMouth.js';
import { wavDurationMs } from '../../infra/models/groqTranscription.js';
import { decodedAudio, LISTEN_MAXIMUM_MS, type Listening } from '../voice/listening.js';

/**
 * `/v1/platform/voice/*` (dc-voice, 2026-10-20): what a platform runtime in a voice channel asks of her one mind. The bridge's service
 * token only, like the rest of `/v1/platform/*`; every route answers 503 `PLATFORM_VOICE_DISABLED` while `SHANNON_DC_VOICE` is off.
 *
 * - `POST turn` (NDJSON): the reply to what was said (`PlatformVoiceService.turn`).
 * - `POST speech`: PCM audio (24 kHz, mono, s16le) of a line in her ElevenLabs voice, streamed as it is made.
 * - `GET fillers`: the short sounds a `decision` line may name, for the body to keep as audio.
 * - `POST say` / `POST mouth/poll` / `POST mouth/result`: her mouth (`voiceMouth.ts`, `dc-speak-interface.md`).
 * - `POST wording`: event facts put into her words. `POST said`: what she said by herself, or was heard saying before being talked over.
 * - `POST transcribe`: one utterance (base64 WAV, 16 kHz mono, 30 s at most) to text through the listening transcriber the Windows
 *   resident uses (Groq, one shared allowance; owner 2026-10-26, docs/listening-contract.md). 503 `LISTEN_NOT_CONFIGURED` without
 *   `GROQ_API_KEY`. Whether it is answered is still decided by `turn`.
 */
export interface PlatformVoiceRoutes {
  service: PlatformVoiceService;
  mouth: VoiceMouthQueue;
  /** The ElevenLabs gateway of this server; null while its key or voice is not configured (speech answers 503). */
  speech: Pick<ElevenSpeechGateway, 'stream'> | null;
  scopeKey: string;
  environment?: () => SwitchValues;
  /** Listening transcription (`listening.ts`); null without `GROQ_API_KEY` (transcribe answers 503). */
  listening?: Listening | null;
}

const MAXIMUM_SPEECH_CHARACTERS = 400;
const SPEECH_PER_MINUTE = 180;
/** Two sentences are made ahead while one is played, and a filler besides. */
const SPEECH_AT_ONCE = 4;
const speechUsage = new Map<string, { startedAt: number; count: number }>();
let speechActive = 0;

export function isPlatformVoicePath(path: string): boolean {
  return path.startsWith(SHANNON_PLATFORM_VOICE_PREFIX);
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof PlatformBridgeError) return sendJson(response, error.status, { error: error.code, message: error.message });
  if (error instanceof SyntaxError) return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'JSON body is invalid.' });
  throw error;
}

function sendEmpty(response: ServerResponse): void {
  response.writeHead(204);
  response.end();
}

const MOUTH_ROUTES: readonly string[] = ['say', 'mouth/poll', 'mouth/result'];

export async function handlePlatformVoiceRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  authorization: { token: string } | null,
  routes: PlatformVoiceRoutes | null,
): Promise<void> {
  const name = path.slice(SHANNON_PLATFORM_VOICE_PREFIX.length);
  if (request.method !== (name === 'fillers' ? 'GET' : 'POST')) return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!authorization) return sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
  if (!bearerAuthorized(request.headers.authorization, authorization.token)) return sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
  const environment = routes?.environment?.() ?? serverEnvironment();
  if (!routes || !platformVoiceEnabled(environment)) {
    return sendJson(response, 503, { error: 'PLATFORM_VOICE_DISABLED', message: 'Voice channel replies are switched off on the server.' });
  }
  if (MOUTH_ROUTES.includes(name) && !switchOn(environment, 'SHANNON_DC_VOICE_MOUTH')) {
    return sendJson(response, 503, { error: 'PLATFORM_VOICE_MOUTH_DISABLED', message: 'Her mouth in the voice channel is switched off on the server.' });
  }
  try {
    await dispatch(name, request, response, routes);
  } catch (error) {
    sendFailure(response, error);
  }
}

async function dispatch(name: string, request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  if (name === 'turn') return turn(request, response, routes);
  if (name === 'transcribe') return transcribe(request, response, routes);
  if (name === 'speech') return speech(request, response, routes);
  if (name === 'fillers') return sendJson(response, 200, { items: VOICE_FILLERS.map(({ id, text, style }) => ({ id, text, style })) });
  if (name === 'wording') return sendJson(response, 200, await routes.service.wording(await readJson(request, 8 * 1024)));
  if (name === 'said') {
    routes.service.said(await readJson(request, 8 * 1024));
    return sendEmpty(response);
  }
  if (MOUTH_ROUTES.includes(name)) return mouth(name, request, response, routes);
  return sendJson(response, 404, { error: 'NOT_FOUND' });
}

/** The turn's lines are queued and written in order; the turn never waits for the reader and is never stopped by it. */
async function turn(request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  const body = await readJson(request, 32 * 1024);
  let queue = Promise.resolve();
  let failed = false;
  const write = (line: VoiceTurnLine): void => {
    queue = queue.then(async () => {
      if (failed || response.destroyed) return;
      try {
        startStream(response);
        await writeEvent(response, line);
      } catch {
        failed = true;
      }
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

const MAXIMUM_TRANSCRIBE_BYTES = 16_000 * 2 * 31 + 1_024;

/** One Discord utterance to text (`listening.ts`). The words go back to the body for its turn; nothing is kept here. */
async function transcribe(request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  const listening = routes.listening;
  if (!listening) return sendJson(response, 503, { error: 'LISTEN_NOT_CONFIGURED', message: 'Listening transcription is not configured on the server.' });
  const body = await readJson(request, 1_500_000);
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const audio = row ? decodedAudio(row.audio, MAXIMUM_TRANSCRIBE_BYTES) : null;
  const durationMs = audio ? wavDurationMs(audio) : null;
  if (!audio || durationMs === null || durationMs > LISTEN_MAXIMUM_MS) {
    return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'audio must be a WAV of 30 s at most.' });
  }
  const heard = await listening.transcribe(audio, durationMs, 'discord');
  if (heard.status === 'ok') return sendJson(response, 200, { status: 'ok', text: heard.text, sttMs: heard.sttMs });
  if (heard.status === 'limited') return sendJson(response, 200, { status: 'limited', sttMs: 0, limited: heard.limited });
  return sendJson(response, 200, { status: heard.status, sttMs: heard.sttMs });
}

interface SpeechAsk {
  text: string;
  style?: string;
}

/** The line and its acting tags, or null when either is not one she may be given. */
function validatedSpeech(values: Record<string, unknown>): SpeechAsk | null {
  try {
    const text = normalizedSpeechText(values.text);
    const style = values.style;
    if (Array.from(text).length > MAXIMUM_SPEECH_CHARACTERS || (style !== undefined && typeof style !== 'string')) return null;
    validatedElevenTags(style);
    return { text, ...(style ? { style } : {}) };
  } catch (error) {
    if (error instanceof ElevenSpeechError || error instanceof GeminiSpeechError) return null;
    throw error;
  }
}

async function speech(request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  const body = await readJson(request, 8 * 1024);
  const values = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (!routes.speech) return sendJson(response, 503, { error: 'ELEVEN_SPEECH_NOT_CONFIGURED', message: '声の合成は、いま使えません。' });
  const ask = validatedSpeech(values);
  if (!ask) return sendJson(response, 400, { error: 'SPEECH_INVALID', message: '読み上げる文章または演技指定が不正です。' });
  if (speechActive >= SPEECH_AT_ONCE) return sendJson(response, 429, { error: 'BUSY', message: 'いまの返答を音声にしています。' });
  if (!consumeDeviceAllowance(speechUsage, routes.scopeKey, SPEECH_PER_MINUTE)) {
    return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
  }
  speechActive += 1;
  try {
    await streamPcm(request, response, routes.speech, { scopeKey: routes.scopeKey, ...ask });
  } catch (error) {
    if (!(error instanceof ElevenSpeechError)) throw error;
    console.warn('Shannon voice speech failed', { code: error.code });
    if (response.headersSent) response.destroy();
    else sendJson(response, 502, { error: error.code, message: '音声を生成できませんでした。' });
  } finally {
    speechActive -= 1;
  }
}

async function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained);
      response.off('close', closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new ElevenSpeechError('ELEVEN_SPEECH_FAILED'));
    };
    response.once('drain', drained);
    response.once('close', closed);
  });
}

/** Her voice as it is made: raw PCM, 24 kHz mono s16le, chunk by chunk; the first chunk's time in a header. A caller that left stops it. */
async function streamPcm(
  request: IncomingMessage, response: ServerResponse, gateway: Pick<ElevenSpeechGateway, 'stream'>, ask: SpeechAsk & { scopeKey: string },
): Promise<void> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  response.once('close', abort);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    const stream = await gateway.stream(ask, controller.signal);
    iterator = stream.chunks[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new ElevenSpeechError('ELEVEN_SPEECH_FAILED');
    response.writeHead(200, {
      'content-type': `${stream.contentType};rate=${stream.sampleRate};channels=${stream.channels}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
      'x-shannon-voice-engine': 'eleven',
      'x-shannon-first-chunk-ms': String(Math.round(performance.now() - startedAt)),
    });
    await writeChunk(response, first.value);
    for (let next = await iterator.next(); !next.done && !controller.signal.aborted; next = await iterator.next()) {
      await writeChunk(response, next.value);
    }
    if (!controller.signal.aborted) response.end();
  } catch (error) {
    // The caller going away (a person talked over her) is not a failure of the voice.
    if (!controller.signal.aborted) throw error;
  } finally {
    request.off('aborted', abort);
    response.off('close', abort);
    await iterator?.return?.().catch(() => undefined);
  }
}

async function mouth(name: string, request: IncomingMessage, response: ServerResponse, routes: PlatformVoiceRoutes): Promise<void> {
  const body = await readJson(request, name === 'mouth/poll' ? 2 * 1024 : 16 * 1024);
  const values = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (name === 'mouth/result') return mouthResult(values, response, routes);
  if (name === 'say') {
    const accepted = routes.mouth.say(values as unknown as VoiceMouthSay);
    const refused = accepted.reason === 'invalid' ? 400 : accepted.reason === 'rate_limited' ? 429 : 503;
    return sendJson(response, accepted.accepted ? 202 : refused, accepted);
  }
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  const waitMs = typeof values.waitMs === 'number' ? values.waitMs : VOICE_MOUTH_LIMITS.pollMaximumMilliseconds;
  const items = await routes.mouth.poll(waitMs, controller.signal);
  if (!response.destroyed) sendJson(response, 200, { items });
}

function mouthResult(values: Record<string, unknown>, response: ServerResponse, routes: PlatformVoiceRoutes): void {
  const valid = typeof values.id === 'string' && typeof values.status === 'string' && VOICE_MOUTH_RESULTS.includes(values.status as never);
  if (!valid) return sendJson(response, 400, { error: 'BAD_REQUEST', message: 'id and status are required.' });
  routes.mouth.result(values.id as string, values.status as string);
  sendEmpty(response);
}
