import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizePairingCode, type SQLiteDeviceAuthStore } from './deviceAuth.js';
import { readJson, sendJson } from './serverHttp.js';

export function createPairingRoute(authMode: string, deviceAuth: SQLiteDeviceAuthStore | null) {
  let window = { startedAt: 0, count: 0 };
  return async function handlePairing(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!deviceAuth || authMode !== 'paired') return sendJson(response, 404, { error: 'NOT_FOUND' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    const timestamp = Date.now();
    if (timestamp - window.startedAt >= 60_000) window = { startedAt: timestamp, count: 0 };
    window.count += 1;
    if (window.count > 20) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    }
    const body = await readJson(request, 1_024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST' });
    }
    const requestBody = body as Record<string, unknown>;
    const normalizedCode = normalizePairingCode(requestBody.code);
    if (!normalizedCode) {
      return sendJson(response, 400, { error: 'INVALID_PAIRING_CODE', message: '12桁の接続コードを入力してください。' });
    }
    const deviceName = typeof requestBody.deviceName === 'string' ? requestBody.deviceName : 'iPhone';
    const result = deviceAuth.pair(normalizedCode, deviceName);
    if (!result) {
      return sendJson(response, 401, { error: 'PAIRING_REJECTED', message: '接続コードが無効・期限切れです。' });
    }
    sendJson(response, 200, result);
  };
}
