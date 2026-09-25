import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from './apiKernel.js';
import type { ShannonDevicePrincipal } from './deviceAuth.js';
import {
  createConfiguredGeminiLiveGateway,
  GeminiLiveError,
} from './geminiLive.js';
import { readJson, sendJson } from './serverHttp.js';

type ConsumeAllowance = (deviceId: string) => boolean;

export function createGeminiLiveRoute(
  environment: Readonly<Record<string, string | undefined>>,
  kernel: Pick<ShannonApiKernel, 'realtimeVoiceSession'>,
  consumeAllowance: ConsumeAllowance,
) {
  const gateway = createConfiguredGeminiLiveGateway(environment);

  return async function handleGeminiLiveSession(
    request: IncomingMessage,
    response: ServerResponse,
    principal: ShannonDevicePrincipal | null,
  ): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (!gateway) {
      return sendJson(response, 503, {
        error: 'GEMINI_LIVE_NOT_CONFIGURED',
        message: 'Gemini音声会話は現在利用できません。',
      });
    }
    if (!consumeAllowance(principal.deviceId)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    }

    const body = await readJson(request, 4 * 1024);
    const requestBody = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const requestedThreadId = typeof requestBody.threadId === 'string' && requestBody.threadId.length <= 200
      ? requestBody.threadId
      : undefined;
    const participantMode = requestBody.participantMode ?? 'owner';
    if (participantMode !== 'owner' && participantMode !== 'guest') {
      return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'participant mode is invalid' });
    }
    const session = kernel.realtimeVoiceSession(principal.scopeKey, requestedThreadId, {
      clientDelegation: true,
      participantMode,
    });

    try {
      const result = await gateway.createSession({
        scopeKey: principal.scopeKey,
        threadId: session.threadId,
        instructions: session.instructions,
      });
      response.setHeader('cache-control', 'no-store');
      response.setHeader('pragma', 'no-cache');
      sendJson(response, 200, result);
    } catch (error) {
      if (!(error instanceof GeminiLiveError)) throw error;
      console.warn('Shannon Gemini transcription token failed', {
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        upstreamCode: error.upstreamCode,
      });
      sendJson(response, 502, {
        error: error.code,
        message: 'Gemini音声認識へ接続できませんでした。少し待ってもう一度お試しください。',
      });
    }
  };
}
