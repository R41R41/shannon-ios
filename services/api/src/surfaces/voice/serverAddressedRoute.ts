import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { readJson, sendJson } from '../../infra/http/serverHttp.js';
import type { AddressedInput, AddressedJudge } from '../../mind/perception/addressed.js';

/**
 * `POST /v1/voice/addressed` (owner 2026-10-21, 「話しかけられたか」, `SHANNON_ADDRESSED`): the Windows resident's name call asks the head whether
 * the words that had her name in them were said to her. The judge is the one the Discord voice channel uses (`mind/perception/addressed.ts`).
 *
 * Request: `{ text, shannonSpokeMsAgo?, lastLine?, guest?, speaking? }`. `text` is the transcript (1,000 characters); `shannonSpokeMsAgo` how
 * long ago she last finished speaking to him (absent: she has not lately); `guest`: others are listening (a guest call, a stream);
 * `speaking`: she is speaking now.
 * Answer: `{ addressed, reason, source, asked, ms }`. 503 `ADDRESSED_DISABLED` while the switch is off: the resident then goes on as it did.
 * The words are judged and dropped (owner 2026-10-21): they are used for this one judgement only and are written nowhere here: not to her
 * conversation, not to her memory, not to a trace (a trace holds the target, the probability and a salted digest, never the words). Jev's cache
 * is keyed by the digest. Stop words (止めて, 待って...) pass without her name from the owner (not `guest`) while she speaks or her body works.
 */
export const ADDRESSED_PATH = '/v1/voice/addressed';

interface Asked {
  text: string;
  spokeAgoMs: number | null;
  lastLine: string;
  guest: boolean;
  speaking: boolean;
}

const isMilliseconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 3_600_000;
const isText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && !value.includes('\0');

/** The optional fields, when present, are of the right kind. */
function optionalFieldsValid(row: Record<string, unknown>): boolean {
  const flag = (value: unknown) => value === undefined || typeof value === 'boolean';
  return (row.shannonSpokeMsAgo === undefined || isMilliseconds(row.shannonSpokeMsAgo))
    && (row.lastLine === undefined || isText(row.lastLine, 400)) && flag(row.guest) && flag(row.speaking);
}

/** The request body, or null when it is not one: `text` 1-1,000 characters, the other three optional and of the right kind. */
function validatedAsk(body: unknown): Asked | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  const text = isText(row.text, 1_000) ? row.text.trim() : '';
  if (!text) return null;
  if (!optionalFieldsValid(row)) return null;
  return {
    text, spokeAgoMs: isMilliseconds(row.shannonSpokeMsAgo) ? row.shannonSpokeMsAgo : null,
    lastLine: isText(row.lastLine, 400) ? row.lastLine.trim() : '', guest: row.guest === true, speaking: row.speaking === true,
  };
}
/** What the judge is shown: the owner alone (two people for a guest call), and the owner's voice only when it is not a guest call. */
function judgedInput(asked: Asked, scopeKey: string, bodyRunning: boolean): AddressedInput {
  const { spokeAgoMs } = asked;
  return {
    scopeKey, transcript: asked.text, speaker: { id: 'owner', name: 'owner' }, humans: asked.guest ? 2 : 1,
    owner: !asked.guest, shannonSpeaking: asked.speaking || spokeAgoMs === 0, bodyRunning,
    shannon: { spokeAgoMs, toSpeaker: spokeAgoMs === null ? null : true, ...(asked.lastLine ? { line: asked.lastLine } : {}) },
  };
}
const PER_MINUTE = 30;

/** `bodyRunning`: her Minecraft body has a task running now (read at each request). */
export function createAddressedRoute(judge: AddressedJudge | null, now: () => number = Date.now, bodyRunning: () => boolean = () => false) {
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
    const asked = validatedAsk(await readJson(request, 8 * 1024));
    if (!asked) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'text is required.' });
    const verdict = await judge.judge(judgedInput(asked, principal.scopeKey, bodyRunning()));
    sendJson(response, 200, verdict);
  };
}
