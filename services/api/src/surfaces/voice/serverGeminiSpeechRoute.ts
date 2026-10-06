import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import {
  createConfiguredGeminiSpeechGateway,
  GeminiSpeechError,
  normalizedSpeechText,
} from '../../infra/models/geminiSpeech.js';
import type { LlmUsageStore } from '../../infra/models/llmUsage.js';
import type { GeminiSpeechGateway } from '../../infra/models/geminiSpeech.js';
import { createConfiguredElevenSpeechGateway, ElevenSpeechError, validatedElevenTags } from '../../infra/models/elevenSpeech.js';
import { readJson, sendJson } from '../../infra/http/serverHttp.js';

type ConsumeAllowance = (deviceId: string) => boolean;

export class SpeechScopeConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly maximumConcurrentRequests = 2) {
    if (!Number.isInteger(maximumConcurrentRequests) || maximumConcurrentRequests < 1) {
      throw new Error('maximumConcurrentRequests must be a positive integer');
    }
  }

  acquire(scopeKey: string): boolean {
    const count = this.active.get(scopeKey) ?? 0;
    if (count >= this.maximumConcurrentRequests) return false;
    this.active.set(scopeKey, count + 1);
    return true;
  }

  release(scopeKey: string): void {
    const count = this.active.get(scopeKey) ?? 0;
    if (count <= 1) this.active.delete(scopeKey);
    else this.active.set(scopeKey, count - 1);
  }
}

/**
 * A sentence refused before synthesis. Each refusal leaves one line in the service log (the
 * code and the provider, never the text or the device), so a client that went silent can be traced.
 */
export function refuseSpeech(response: ServerResponse, code: 'BUSY' | 'RATE_LIMITED', provider: 'gemini' | 'eleven'): void {
  console.warn('Shannon speech refused', { code, provider });
  sendJson(response, 429, code === 'BUSY'
    ? { error: 'BUSY', message: 'いまの返答を音声にしています。' }
    : { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
}

export function createGeminiSpeechRoute(
  environment: Readonly<Record<string, string | undefined>>,
  usageStore: LlmUsageStore,
  consumeAllowance: ConsumeAllowance,
) {
  const gateway = createConfiguredGeminiSpeechGateway(environment, usageStore);
  const elevenGateway = createConfiguredElevenSpeechGateway(environment);
  const activeScopes = new SpeechScopeConcurrencyLimiter(2);

  return async function handleGeminiSpeech(
    request: IncomingMessage,
    response: ServerResponse,
    principal: ShannonDevicePrincipal | null,
    mode: 'unary' | 'stream' = 'unary',
  ): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    try {
      const body = await readJson(request, 32 * 1024);
      const values = body && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      const text = normalizedSpeechText(values.text);
      const style = typeof values.style === 'string' ? values.style : undefined;
      const provider = values.provider ?? 'gemini';
      if (provider !== 'gemini' && provider !== 'eleven') {
        return sendJson(response, 400, { error: 'SPEECH_INVALID_PROVIDER' });
      }
      const selectedGateway = provider === 'eleven' ? elevenGateway : gateway;
      if (!selectedGateway) {
        return sendJson(response, 503, {
          error: provider === 'eleven' ? 'ELEVEN_SPEECH_NOT_CONFIGURED' : 'GEMINI_SPEECH_NOT_CONFIGURED',
          message: '選択した音声は現在利用できません。',
        });
      }
      if (style !== undefined && style.length > 500) {
        return sendJson(response, 400, { error: 'GEMINI_SPEECH_INVALID_STYLE' });
      }
      if (provider === 'eleven') validatedElevenTags(style);
      if (!activeScopes.acquire(principal.scopeKey)) return refuseSpeech(response, 'BUSY', provider);
      try {
        if (!consumeAllowance(principal.deviceId)) return refuseSpeech(response, 'RATE_LIMITED', provider);
        if (mode === 'stream') {
          await streamSpeech(request, response, selectedGateway, { scopeKey: principal.scopeKey, text, style }, provider);
          return;
        }
        if (provider === 'eleven') return sendJson(response, 400, { error: 'ELEVEN_SPEECH_STREAM_REQUIRED' });
        if (!gateway) throw new ElevenSpeechError('ELEVEN_SPEECH_NOT_CONFIGURED');
        const result = await gateway.synthesize({ scopeKey: principal.scopeKey, text, style });
        response.writeHead(200, {
          'content-type': result.contentType,
          'content-length': String(result.audio.byteLength),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-shannon-voice-engine': 'gemini',
          'x-shannon-gemini-model': result.model,
          'x-shannon-gemini-voice': result.voice,
          'x-shannon-audio-duration-seconds': result.durationSeconds.toFixed(3),
          'x-shannon-estimated-cost-usd': result.estimatedCostUsd.toFixed(8),
        });
        response.end(result.audio);
      } finally {
        activeScopes.release(principal.scopeKey);
      }
    } catch (error) {
      if (!(error instanceof GeminiSpeechError || error instanceof ElevenSpeechError)) throw error;
      console.warn('Shannon speech failed', { code: error.code,
        ...(error instanceof GeminiSpeechError ? {
          upstreamStatus: error.upstreamStatus, upstreamCode: error.upstreamCode,
        } : {}),
      });
      const status = error.code === 'GEMINI_SPEECH_INVALID_TEXT' ||
        error.code === 'ELEVEN_SPEECH_INVALID_STYLE' ? 400 : 502;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, status, {
        error: error.code,
        message: status === 400 ? '読み上げる文章または演技指定が不正です。' : '音声を生成できませんでした。',
      });
    }
  };
}

export async function streamSpeech(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: Pick<GeminiSpeechGateway, 'stream'>,
  speechRequest: { scopeKey: string; text: string; style?: string },
  provider: 'gemini' | 'eleven' = 'gemini',
): Promise<void> {
  const controller = new AbortController();
  let iterator: AsyncIterator<Uint8Array> | undefined;
  const abort = () => controller.abort();
  request.once('aborted', abort);
  response.once('close', abort);
  try {
    const stream = await gateway.stream(speechRequest, controller.signal);
    iterator = stream.chunks[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw provider === 'eleven'
      ? new ElevenSpeechError('ELEVEN_SPEECH_FAILED') : new GeminiSpeechError('GEMINI_SPEECH_FAILED');
    response.writeHead(200, {
      'content-type': `${stream.contentType};rate=${stream.sampleRate};channels=${stream.channels}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
      'x-shannon-voice-engine': provider,
      'x-shannon-voice-model': stream.model,
      'x-shannon-voice-name': provider === 'eleven' ? 'Shannon Clone 02' : stream.voice,
      ...(provider === 'gemini' ? {
        'x-shannon-gemini-model': stream.model,
        'x-shannon-gemini-voice': stream.voice,
      } : {}),
      'x-shannon-audio-sample-rate': String(stream.sampleRate),
      'x-shannon-audio-channels': String(stream.channels),
      'x-shannon-audio-bits-per-sample': String(stream.bitsPerSample),
      'x-shannon-output-usd-per-10-seconds': stream.outputUsdPerTenSeconds.toFixed(8),
      'x-shannon-cost-estimate-available': provider === 'gemini' ? 'true' : 'false',
    });
    await writeChunk(response, first.value);
    while (!controller.signal.aborted) {
      const next = await iterator.next();
      if (next.done) break;
      await writeChunk(response, next.value);
    }
    if (!controller.signal.aborted) response.end();
  } catch (error) {
    // Caller cancellation (barge-in/closing the session) is not a provider failure.
    // Provider timeouts use a separate gateway controller and still propagate.
    if (!controller.signal.aborted) throw error;
  } finally {
    request.off('aborted', abort);
    response.off('close', abort);
    try { await iterator?.return?.(); } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }
}

async function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained);
      response.off('error', failed);
      response.off('close', closed);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => { cleanup(); reject(new GeminiSpeechError('GEMINI_SPEECH_FAILED')); };
    response.once('drain', drained);
    response.once('error', failed);
    response.once('close', closed);
  });
}
