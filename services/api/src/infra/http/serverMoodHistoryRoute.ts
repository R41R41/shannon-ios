import type { IncomingMessage, ServerResponse } from 'node:http';
import { downsampleMoodPoints, moodHistoryPoint, type SQLiteMoodHistoryReader } from '../../mind/emotion/store/moodHistoryReader.js';
import { MOOD_HISTORY_LIMITS, MOOD_HISTORY_SCHEMA_VERSION, type MoodHistoryResponse } from '../../contracts/moodHistoryContract.js';
import { consumeDeviceAllowance, sendJson } from './serverHttp.js';

export interface MoodHistoryRouteDependencies {
  reader: Pick<SQLiteMoodHistoryReader, 'points'> & Partial<Pick<SQLiteMoodHistoryReader, 'carryIn'>>;
  /** `SHANNON_MOOD_HISTORY`. */
  enabled: () => boolean;
  /** The owner's scope; a device paired into another scope is a guest here. */
  ownerScopeKey: string;
  now: () => string;
}

/**
 * `GET /v1/shannon/mood-history?hours=…` (`docs/mood-history-contract.md`): the owner's own app reads
 * how her mood went. The same callers as `GET /v1/shannon/now` are refused with the same codes; the
 * scope is the device's own and is never taken from the request. Nothing is stored and no model is called.
 */
export function createMoodHistoryRoute(dependencies: MoodHistoryRouteDependencies) {
  const usage = new Map<string, { startedAt: number; count: number }>();

  return (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string; deviceId: string } | null): void => {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) {
      return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED', message: 'Only a paired device of the owner may read this.' });
    }
    if (principal.scopeKey !== dependencies.ownerScopeKey) {
      return sendJson(response, 403, { error: 'MOOD_HISTORY_OWNER_ONLY', message: 'Only the owner may read this.' });
    }
    if (!dependencies.enabled()) {
      return sendJson(response, 403, { error: 'MOOD_HISTORY_DISABLED', message: 'This read is switched off on the server.' });
    }
    if (!consumeDeviceAllowance(usage, principal.deviceId, MOOD_HISTORY_LIMITS.readsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many requests; retry after a minute.' });
    }
    const hours = requestedHours(new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('hours'));
    if (hours === null) {
      return sendJson(response, 400, { error: 'MOOD_HISTORY_HOURS_INVALID', message: `hours must be a whole number from 1; at most ${MOOD_HISTORY_LIMITS.maxHours} is read.` });
    }
    sendJson(response, 200, moodHistoryResponse(dependencies, principal.scopeKey, hours));
  };
}

/** Absent: the default window. A whole number from 1: that many hours, at most `maxHours`. Anything else: `null`. */
export function requestedHours(value: string | null): number | null {
  if (value === null) return MOOD_HISTORY_LIMITS.defaultHours;
  if (!/^\d{1,6}$/u.test(value.trim())) return null;
  const hours = Number(value.trim());
  return hours >= 1 ? Math.min(hours, MOOD_HISTORY_LIMITS.maxHours) : null;
}

export function moodHistoryResponse(dependencies: Pick<MoodHistoryRouteDependencies, 'reader' | 'now'>, scopeKey: string, hours: number): MoodHistoryResponse {
  const at = dependencies.now();
  const since = new Date(Date.parse(at) - hours * 60 * 60_000).toISOString();
  const stored = dependencies.reader.points(scopeKey, since).filter(point => point.at <= at);
  const points = downsampleMoodPoints(stored);
  const carryIn = dependencies.reader.carryIn?.(scopeKey, since) ?? null;
  const { defaultHours, maxHours, maxPoints, keepDays, everyMinutes, moodStep } = MOOD_HISTORY_LIMITS;
  return {
    schemaVersion: MOOD_HISTORY_SCHEMA_VERSION,
    generatedAt: at,
    hours,
    points: points.map(moodHistoryPoint),
    ...(carryIn ? { carryIn: moodHistoryPoint(carryIn) } : {}),
    downsampled: points.length < stored.length,
    limits: { defaultHours, maxHours, maxPoints, keepDays, everyMinutes, moodStep },
  };
}
