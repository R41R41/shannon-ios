import type { IncomingMessage, ServerResponse } from 'node:http';
import { ON_AIR_LIMITS, validatedOnAirRequest } from '../../contracts/onAirContract.js';
import type { SQLiteOnAirStore } from '../onAir/onAirStore.js';
import { consumeDeviceAllowance, readJson, sendJson } from './serverHttp.js';

export interface OnAirRouteDependencies {
  store: Pick<SQLiteOnAirStore, 'active' | 'set' | 'clear'>;
  /** The owner's scope; a device paired into another scope is a guest here. */
  ownerScopeKey: string;
  now: () => string;
}

/**
 * `GET` and `POST /v1/on-air` (`docs/on-air-contract.md`): the owner's own paired device reads, sets and clears 「収録中」. The scope is the device's
 * own and is never taken from the request. Nothing here calls a model; the note is read into the spoken reply's prompt by `platformVoice.ts`.
 */
export function createOnAirRoute(dependencies: OnAirRouteDependencies) {
  const usage = new Map<string, { startedAt: number; count: number }>();

  return async (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string; deviceId: string } | null): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED', message: 'Only a paired device of the owner may use this.' });
    if (principal.scopeKey !== dependencies.ownerScopeKey) return sendJson(response, 403, { error: 'ON_AIR_OWNER_ONLY', message: 'Only the owner may use this.' });
    if (!consumeDeviceAllowance(usage, principal.deviceId, ON_AIR_LIMITS.requestsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many requests; retry after a minute.' });
    }
    const at = new Date(Date.parse(dependencies.now())).toISOString();
    if (request.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(request, ON_AIR_LIMITS.bodyBytes);
      } catch (error) {
        if (error instanceof SyntaxError) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'The body must be JSON.' });
        if (error instanceof Error && error.message === 'request body too large') return sendJson(response, 413, { error: 'REQUEST_TOO_LARGE' });
        throw error;
      }
      const requested = validatedOnAirRequest(body);
      if ('error' in requested) return sendJson(response, requested.status, { error: requested.error, message: requested.message });
      if (requested.off) dependencies.store.clear(principal.scopeKey);
      else dependencies.store.set(principal.scopeKey, { until: new Date(Date.parse(at) + requested.minutes * 60_000).toISOString(), note: requested.note }, at);
    }
    sendJson(response, 200, { onAir: dependencies.store.active(principal.scopeKey, at) });
  };
}
