import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from '../../apiKernel.js';
import type { ShannonDevicePrincipal } from '../../deviceAuth.js';
import {
  createConfiguredGeminiLiveGateway,
  GeminiLiveError,
} from '../../geminiLive.js';
import {
  createConfiguredOpenAITranscriptionGateway,
  OpenAITranscriptionError,
} from '../../openaiTranscriptionSession.js';
import { readJson, sendJson } from '../../serverHttp.js';
import { OWNER_IN_CALL_ELSEWHERE_RESPONSE } from './ownerCallElsewhere.js';

type ConsumeAllowance = (deviceId: string) => boolean;

export function createGeminiLiveRoute(
  environment: Readonly<Record<string, string | undefined>>,
  kernel: Pick<ShannonApiKernel, 'realtimeVoiceSession' | 'voiceSessions'>,
  consumeAllowance: ConsumeAllowance,
) {
  const gateway = createConfiguredGeminiLiveGateway(environment);
  const openAIGateway = createConfiguredOpenAITranscriptionGateway(environment);
  const speechVoice = configuredSpeechVoice(environment.SHANNON_GEMINI_TTS_VOICE);
  const outputUsdPerMinute = configuredNumber(environment.SHANNON_GEMINI_LIVE_OUTPUT_USD_PER_MINUTE, 0, 10, 0.018);

  return async function handleGeminiLiveSession(
    request: IncomingMessage,
    response: ServerResponse,
    principal: ShannonDevicePrincipal | null,
  ): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (!consumeAllowance(principal.deviceId)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    }

    const body = await readJson(request, 4 * 1024);
    const requestBody = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    // Clients that predate OpenAI transcription omit the field and keep the Gemini session.
    const transcriptionProvider = requestBody.transcriptionProvider ?? 'gemini';
    if (transcriptionProvider !== 'gemini' && transcriptionProvider !== 'openai') {
      return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'transcription provider is invalid' });
    }
    if (transcriptionProvider === 'openai' ? !openAIGateway : !gateway) {
      return sendJson(response, 503, {
        error: transcriptionProvider === 'openai' ? 'OPENAI_TRANSCRIPTION_NOT_CONFIGURED' : 'GEMINI_LIVE_NOT_CONFIGURED',
        message: '音声会話は現在利用できません。',
      });
    }
    const requestedThreadId = typeof requestBody.threadId === 'string' && requestBody.threadId.length <= 200
      ? requestBody.threadId
      : undefined;
    const participantMode = requestBody.participantMode ?? 'owner';
    if (participantMode !== 'owner' && participantMode !== 'guest') {
      return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'participant mode is invalid' });
    }
    // Her body does not start a call while the owner talks with her on one of his apps (docs/body-contract.md).
    if (kernel.voiceSessions.refused(principal.scopeKey, principal.deviceId, participantMode)) {
      return sendJson(response, OWNER_IN_CALL_ELSEWHERE_RESPONSE.status, OWNER_IN_CALL_ELSEWHERE_RESPONSE.body);
    }
    const session = kernel.realtimeVoiceSession(principal.scopeKey, requestedThreadId, {
      clientDelegation: true,
      participantMode,
    });

    try {
      const result = transcriptionProvider === 'openai' && openAIGateway
        ? {
          ...await openAIGateway.createSession(),
          voice: speechVoice,
          threadId: session.threadId,
          instructions: session.instructions,
          outputUsdPerMinute,
          transcriptionProvider: 'openai' as const,
        }
        : await gateway!.createSession({
          scopeKey: principal.scopeKey,
          threadId: session.threadId,
          instructions: session.instructions,
        });
      response.setHeader('cache-control', 'no-store');
      response.setHeader('pragma', 'no-cache');
      // Only a session that was made is this device's voice conversation (`ownerCallElsewhere.ts`).
      kernel.voiceSessions.created(principal.scopeKey, principal.deviceId);
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof OpenAITranscriptionError) {
        console.warn('Shannon OpenAI transcription token failed', {
          code: error.code,
          upstreamStatus: error.upstreamStatus,
          upstreamCode: error.upstreamCode,
        });
        return sendJson(response, 502, {
          error: error.code,
          message: '音声認識へ接続できませんでした。少し待ってもう一度お試しください。',
        });
      }
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

function configuredSpeechVoice(value: string | undefined): string {
  const voice = value?.trim() ?? '';
  return /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(voice) ? voice : 'Aoede';
}

function configuredNumber(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  const number = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}
