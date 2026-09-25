import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from './deviceAuth.js';
import {
  createConfiguredGeminiSpeechGateway,
  GeminiSpeechError,
  normalizedSpeechText,
} from './geminiSpeech.js';
import type { LlmUsageStore } from './llmUsage.js';
import { readJson, sendJson } from './serverHttp.js';

type ConsumeAllowance = (deviceId: string) => boolean;

export function createGeminiSpeechRoute(
  environment: Readonly<Record<string, string | undefined>>,
  usageStore: LlmUsageStore,
  consumeAllowance: ConsumeAllowance,
) {
  const gateway = createConfiguredGeminiSpeechGateway(environment, usageStore);
  const activeScopes = new Set<string>();

  return async function handleGeminiSpeech(
    request: IncomingMessage,
    response: ServerResponse,
    principal: ShannonDevicePrincipal | null,
  ): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (!gateway) {
      return sendJson(response, 503, {
        error: 'GEMINI_SPEECH_NOT_CONFIGURED',
        message: 'Gemini音声は現在利用できません。',
      });
    }
    if (!consumeAllowance(principal.deviceId)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    }
    if (activeScopes.has(principal.scopeKey)) {
      return sendJson(response, 429, { error: 'BUSY', message: 'いまの返答を音声にしています。' });
    }

    activeScopes.add(principal.scopeKey);
    try {
      const body = await readJson(request, 32 * 1024);
      const values = body && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      const text = normalizedSpeechText(values.text);
      const style = typeof values.style === 'string' ? values.style : undefined;
      if (style !== undefined && style.length > 500) {
        return sendJson(response, 400, { error: 'GEMINI_SPEECH_INVALID_STYLE' });
      }
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
    } catch (error) {
      if (!(error instanceof GeminiSpeechError)) throw error;
      console.warn('Shannon Gemini speech failed', {
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        upstreamCode: error.upstreamCode,
      });
      const status = error.code === 'GEMINI_SPEECH_INVALID_TEXT' ? 400 : 502;
      sendJson(response, status, {
        error: error.code,
        message: status === 400 ? '読み上げる文章が不正です。' : 'Gemini音声を生成できませんでした。',
      });
    } finally {
      activeScopes.delete(principal.scopeKey);
    }
  };
}
