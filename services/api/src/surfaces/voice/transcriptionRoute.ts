import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../../deviceAuth.js';
import { readBytes, sendJson, type VoiceRequestAllowances } from '../../serverHttp.js';
import {
  normalizedVoiceMimeType,
  parsedVoiceDurationSeconds,
  SHANNON_VOICE_MAXIMUM_BYTES,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from '../../voiceTranscription.js';

/**
 * `POST /v1/voice/transcriptions`: a paired device's audio to text, through the configured transcriber and its daily cap
 * (`voiceTranscription.ts`). Moved out of `server.ts` unchanged (Syzygy ADR-0008 §6, surfaces/voice).
 */
export function createVoiceTranscriptionRoute(dependencies: {
  transcriber: VoiceTranscriber | null;
  allowances: Pick<VoiceRequestAllowances, 'consumeControl'>;
}): (request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null) => Promise<void> {
  const { transcriber: voiceTranscriber, allowances: voiceAllowances } = dependencies;
  // One transcription at a time per scope.
  const activeVoiceScopes = new Set<string>();
  return async (request, response, principal) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (!principal) {
      sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
      return;
    }
    if (!voiceTranscriber) {
      sendJson(response, 503, { error: 'VOICE_NOT_CONFIGURED', message: '音声入力は現在利用できません。' });
      return;
    }
    if (!voiceAllowances.consumeControl(principal.deviceId)) {
      sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
      return;
    }
    if (activeVoiceScopes.has(principal.scopeKey)) {
      sendJson(response, 429, { error: 'BUSY', message: 'いまの音声を聞き取っています。少しお待ちください。' });
      return;
    }

    activeVoiceScopes.add(principal.scopeKey);
    try {
      const mimeType = normalizedVoiceMimeType(request.headers['content-type']);
      const durationSeconds = parsedVoiceDurationSeconds(request.headers['x-shannon-audio-duration-ms']);
      const audio = await readBytes(request, SHANNON_VOICE_MAXIMUM_BYTES);
      const result = await voiceTranscriber.transcribe({
        scopeKey: principal.scopeKey,
        audio,
        mimeType,
        durationSeconds,
      });
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) {
        console.warn('Shannon voice transcription failed', {
          code: error.code,
          upstreamStatus: error.upstreamStatus,
          upstreamCode: error.upstreamCode,
        });
        const status = error.code === 'VOICE_DAILY_BUDGET_EXHAUSTED' ? 429
          : error.code === 'VOICE_TRANSCRIPTION_FAILED' ? 502
            : 400;
        const message = error.code === 'VOICE_DAILY_BUDGET_EXHAUSTED'
          ? '今日は音声入力を十分使いました。テキスト入力は引き続き使えます。'
          : '音声を文字にできませんでした。もう一度お試しください。';
        sendJson(response, status, { error: error.code, message });
        return;
      }
      throw error;
    } finally {
      activeVoiceScopes.delete(principal.scopeKey);
    }
  };
}
