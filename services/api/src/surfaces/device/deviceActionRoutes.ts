import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEVICE_ACTION_LIMITS, DEVICE_ACTION_SCHEMA_VERSION, DEVICE_ACTIONS_PATH, DEVICE_MUSIC_PLAYS_PATH, deviceActionResultId, isDeviceActionPath,
  validatedDeviceReport, validatedMusicPlay, validatedPollState,
} from '../../contracts/deviceActionContract.js';
import { consumeDeviceAllowance, readJson, sendJson } from '../../infra/http/serverHttp.js';
import type { DeviceActions } from './deviceActions.js';

type Principal = { scopeKey: string; deviceId: string } | null;

/**
 * The owner's app and the device-action outbox (`docs/device-actions-contract.md`):
 * - `GET /v1/device/actions?platform=&foreground=&call=&kinds=&wait=`: the actions this device may take now (it holds them from
 *   then on); with `wait=1` the answer is held up to 15 s until one arrives.
 * - `POST /v1/device/actions/{id}/result`: the device's one report of an action (`done`, `failed` or `denied`, a closed code, a
 *   small result). A repeated report is answered with what was recorded.
 * - `POST /v1/device/music/plays`: a play outcome the device saw (started, skipped, finished, stopped).
 * Only a paired device of the owner's scope gets in. Nothing here calls a model or writes as Shannon.
 */
export function createDeviceActionRoute(actions: DeviceActions | null, ownerScopeKey: string) {
  const usage = new Map<string, { startedAt: number; count: number }>();
  return async (request: IncomingMessage, response: ServerResponse, principal: Principal, url: URL): Promise<boolean> => {
    if (!isDeviceActionPath(url.pathname)) return false;
    if (!principal) return reply(response, 403, 'PAIRED_DEVICE_REQUIRED', 'Only a paired device of the owner may use device actions.');
    if (principal.scopeKey !== ownerScopeKey) return reply(response, 403, 'DEVICE_ACTIONS_OWNER_ONLY', 'Only the owner\'s devices take device actions.');
    if (!actions?.available(principal.scopeKey)) return reply(response, 403, 'DEVICE_ACTIONS_DISABLED', 'Device actions are switched off on the server.');
    if (!consumeDeviceAllowance(usage, principal.deviceId, DEVICE_ACTION_LIMITS.pollsPerMinute)) {
      return reply(response, 429, 'RATE_LIMITED', 'Too many requests; retry after a minute.');
    }
    if (url.pathname === DEVICE_ACTIONS_PATH) return poll(actions, request, response, principal, url);
    if (request.method !== 'POST') return reply(response, 405, 'METHOD_NOT_ALLOWED');
    const body = await readJson(request, DEVICE_ACTION_LIMITS.resultBytes + 2_048);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(response, 400, 'INVALID_REQUEST', 'JSON object body is required');
    return url.pathname === DEVICE_MUSIC_PLAYS_PATH ? play(actions, response, principal, body as Record<string, unknown>)
      : result(actions, response, principal, deviceActionResultId(url.pathname)!, body as Record<string, unknown>);
  };
}

type Owner = NonNullable<Principal>;

async function poll(actions: DeviceActions, request: IncomingMessage, response: ServerResponse, principal: Owner, url: URL): Promise<true> {
  if (request.method !== 'GET') return reply(response, 405, 'METHOD_NOT_ALLOWED');
  const state = validatedPollState(url.searchParams);
  if (typeof state === 'string') return reply(response, 400, 'INVALID_REQUEST', state);
  const closed = new AbortController();
  response.once('close', () => closed.abort());
  const handed = await actions.poll(principal.scopeKey, principal.deviceId, state, closed.signal);
  if (!response.writableEnded && !closed.signal.aborted) {
    sendJson(response, 200, { schemaVersion: DEVICE_ACTION_SCHEMA_VERSION, actions: handed, pollSeconds: state.foreground || state.inCall ? 2 : 20 });
  }
  return true;
}

function play(actions: DeviceActions, response: ServerResponse, principal: Owner, body: Record<string, unknown>): true {
  const reported = validatedMusicPlay(body);
  if (typeof reported === 'string') return reply(response, 400, 'INVALID_REQUEST', reported);
  actions.recordPlay(principal.scopeKey, principal.deviceId, reported);
  sendJson(response, 200, { schemaVersion: DEVICE_ACTION_SCHEMA_VERSION, recorded: true });
  return true;
}

function result(actions: DeviceActions, response: ServerResponse, principal: Owner, id: string, body: Record<string, unknown>): true {
  const report = validatedDeviceReport(body);
  if (typeof report === 'string') return reply(response, 400, 'INVALID_REQUEST', report);
  const outcome = actions.report(principal.scopeKey, principal.deviceId, id, report);
  if (outcome.kind === 'not_found') return reply(response, 404, 'DEVICE_ACTION_NOT_FOUND', 'No such action.');
  if (outcome.kind === 'not_yours') return reply(response, 403, 'DEVICE_ACTION_NOT_YOURS', 'Another device holds this action.');
  sendJson(response, 200, { schemaVersion: DEVICE_ACTION_SCHEMA_VERSION, id, status: outcome.action.status, accepted: outcome.kind === 'accepted' });
  return true;
}

function reply(response: ServerResponse, status: number, error: string, message?: string): true {
  sendJson(response, status, { error, ...(message ? { message } : {}) });
  return true;
}
