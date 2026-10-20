import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { readJson, sendJson } from '../../infra/http/serverHttp.js';
import type { AddressedJudge } from '../../mind/perception/addressed.js';

/**
 * `POST /v1/voice/addressed` (owner 2026-10-21, 「話しかけられたか」, `SHANNON_ADDRESSED`): the Windows resident's name call asks the head whether
 * the words that had her name in them were said to her. The judge is the one the Discord voice channel uses (`mind/perception/addressed.ts`).
 *
 * Request: `{ text, shannonSpokeMsAgo?, lastLine?, guest? }`. `text` is the transcript (1,000 characters); `shannonSpokeMsAgo` how long ago she
 * last finished speaking to him (absent: she has not lately); `guest`: others are listening (a guest call, a stream).
 * Answer: `{ addressed, reason, source, asked, ms }`. 503 `ADDRESSED_DISABLED` while the switch is off: the resident then goes on as it did.
 * The words are judged and dropped: nothing of them is kept here.
 */
export const ADDRESSED_PATH = '/v1/voice/addressed';

const PER_MINUTE = 30;

export function createAddressedRoute(judge: AddressedJudge | null, now: () => number = Date.now) {
  const times = new Map<string, number[]>();
  const allowed = (deviceId: string): boolean => {
    const at = now();
    const recent = (times.get(deviceId) ?? []).filter(time => at - time < 60_000);
    if (recent.length >= PER_MINUTE) return false;
    recent.push(at);
    times.set(deviceId, recent);
    if (times.size > 64) times.delete(times.keys().next().value!);
    return true;
  };

  return async function handleAddressed(request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (!judge) return sendJson(response, 503, { error: 'ADDRESSED_DISABLED', message: '話しかけられたかの判定は切です。' });
    if (!allowed(principal.deviceId)) return sendJson(response, 429, { error: 'RATE_LIMITED', message: '少し待ってからもう一度お試しください。' });
    const body = await readJson(request, 8 * 1024);
    const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const text = typeof row?.text === 'string' ? row.text.trim() : '';
    const spoke = row?.shannonSpokeMsAgo;
    const valid = row !== null && text.length > 0 && text.length <= 1_000 && !text.includes('\0')
      && (spoke === undefined || (typeof spoke === 'number' && Number.isFinite(spoke) && spoke >= 0 && spoke < 3_600_000))
      && (row.lastLine === undefined || (typeof row.lastLine === 'string' && row.lastLine.length <= 400))
      && (row.guest === undefined || typeof row.guest === 'boolean');
    if (!valid) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'text is required.' });
    const spokeAgoMs = typeof spoke === 'number' ? spoke : null;
    const verdict = await judge.judge({
      scopeKey: principal.scopeKey, transcript: text, speaker: { id: 'owner', name: 'owner' }, humans: row.guest === true ? 2 : 1,
      shannon: { spokeAgoMs, toSpeaker: spokeAgoMs === null ? null : true, ...(typeof row.lastLine === 'string' && row.lastLine.trim() ? { line: row.lastLine.trim() } : {}) },
    });
    sendJson(response, 200, verdict);
  };
}
