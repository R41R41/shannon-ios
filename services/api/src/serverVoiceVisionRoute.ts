import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from './apiKernel.js';
import type { ShannonDevicePrincipal } from './deviceAuth.js';
import { consumeDeviceAllowance, readBytes, scalarHeader, sendJson } from './serverHttp.js';
import { VoiceVisionError, type ShannonVisionMimeType, type VoiceVisionGateway } from './voiceVision.js';

const perDeviceUsage = new Map<string, { startedAt: number; count: number }>();
const activeScopes = new Set<string>();

export async function handleVoiceVisionSnapshot(
  request: IncomingMessage,
  response: ServerResponse,
  principal: ShannonDevicePrincipal | null,
  dependencies: { gateway: VoiceVisionGateway | null; kernel: ShannonApiKernel },
): Promise<void> {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
  if (!dependencies.gateway) {
    return sendJson(response, 503, { error: 'VOICE_VISION_NOT_CONFIGURED', message: 'カメラ共有は現在利用できません。' });
  }
  if (!consumeDeviceAllowance(perDeviceUsage, principal.deviceId, 6)) {
    return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
  }
  if (activeScopes.has(principal.scopeKey)) {
    return sendJson(response, 429, { error: 'BUSY', message: 'いまの写真を確認しています。' });
  }
  const contentType = normalizedImageMimeType(request.headers['content-type']);
  if (!contentType) {
    return sendJson(response, 415, { error: 'VOICE_VISION_INVALID_IMAGE', message: '写真の形式が正しくありません。' });
  }

  activeScopes.add(principal.scopeKey);
  try {
    const image = await readBytes(request, 3 * 1_024 * 1_024);
    const requestedThreadId = scalarHeader(request.headers['x-shannon-thread-id']);
    const session = dependencies.kernel.realtimeVoiceSession(principal.scopeKey, requestedThreadId, {
      clientDelegation: true,
    });
    const result = await dependencies.gateway.analyze({
      scopeKey: principal.scopeKey,
      image,
      mimeType: contentType,
      conversationContext: session.instructions,
    });
    sendJson(response, 200, { ...result, threadId: session.threadId });
  } catch (error) {
    if (error instanceof VoiceVisionError) {
      console.warn('Shannon voice vision failed', {
        code: error.code,
        upstreamStatus: error.upstreamStatus,
        safeDetail: error.safeDetail,
      });
      const status = error.code === 'VOICE_VISION_INVALID_IMAGE' ? 400 : 502;
      sendJson(response, status, { error: error.code, message: '写真を確認できませんでした。もう一度お試しください。' });
      return;
    }
    throw error;
  } finally {
    activeScopes.delete(principal.scopeKey);
  }
}

function normalizedImageMimeType(value: string | string[] | undefined): ShannonVisionMimeType | null {
  const normalized = Array.isArray(value) ? value[0] : value;
  const type = normalized?.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'image/jpeg' || type === 'image/png' ? type : null;
}
