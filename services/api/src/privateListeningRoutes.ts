import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import {
  PRIVATE_LISTENING_LIMITS, PRIVATE_LISTENING_PATH, PRIVATE_LISTENING_SCHEMA_VERSION, PRIVATE_REACH_OUT_PREFIX,
  privateReachOutRoute, validatedPrivateListeningReport, validatedPrivateReachOutReport,
} from './privateListeningContract.js';
import type { SQLitePrivateListeningStore } from './privateListeningStore.js';
import type { PrivateReachOuts } from './privateReachOuts.js';

export interface PrivateListeningDependencies {
  store: SQLitePrivateListeningStore;
  /** `SHANNON_PRIVATE_LISTENING`; off refuses every report. */
  enabled: boolean;
  /** `SHANNON_OWNER_SCOPE_KEY` (default `owner`): only a device paired into that scope may report. */
  ownerScopeKey: string;
  /** Her messages spoken through his earphones (`privateReachOuts.ts`); absent, nothing is offered and the routes answer 404. */
  reachOuts?: PrivateReachOuts | null;
  now: () => string;
}

const PAIRED_ONLY: ApiResponse = { status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED', message: 'Only a paired device may report private listening.' } };
const OWNER_ONLY: ApiResponse = { status: 403, body: { error: 'PRIVATE_LISTENING_OWNER_ONLY', message: 'Only the owner\'s own devices may report private listening.' } };
const DISABLED: ApiResponse = { status: 403, body: { error: 'PRIVATE_LISTENING_DISABLED', message: 'Private listening is switched off on the server.' } };

/**
 * `/v1/private-listening` (`docs/private-listening-contract.md`): one of the owner's apps says whether only he
 * can hear it now, and takes a message she started on her own to say it through his earphones. The device is
 * taken from its token; a caller without a paired device, or paired into another scope, is refused on every
 * route, so a guest can never set the state or take a message. No route here calls a model.
 */
export function dispatchPrivateListeningRequest(request: ApiRequest, dependencies: PrivateListeningDependencies): ApiResponse {
  const reachOut = request.path.startsWith(PRIVATE_REACH_OUT_PREFIX) ? privateReachOutRoute(request.path) : null;
  if (request.path !== PRIVATE_LISTENING_PATH && !reachOut) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (request.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } };
  if (!request.deviceId) return PAIRED_ONLY;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  if (scopeKey !== dependencies.ownerScopeKey) return OWNER_ONLY;
  if (reachOut) return dispatchReachOut(request.body, scopeKey, request.deviceId, reachOut, dependencies);

  const report = validatedPrivateListeningReport(request.body);
  if (typeof report === 'string') return badRequest(report);

  // Saying "no longer" is always accepted, also while the feature is switched off: it only removes this device's row.
  if (!report.listening) {
    dependencies.store.clear(scopeKey, request.deviceId);
    return { status: 200, body: { schemaVersion: PRIVATE_LISTENING_SCHEMA_VERSION, listening: false, pollAfterSeconds: PRIVATE_LISTENING_LIMITS.pollSeconds } };
  }
  if (!dependencies.enabled) return DISABLED;
  const at = dependencies.now();
  const listener = dependencies.store.report(scopeKey, request.deviceId, {
    kind: report.kind, speaks: report.speaks, ...(report.ownerActiveAt ? { ownerActiveAt: report.ownerActiveAt } : {}),
  }, at);
  // A message of hers this app should say now, as an identifier; its words come with the claim.
  let offered: { id: string; createdAt: string } | null = null;
  try { offered = listener.speaks ? dependencies.reachOuts?.offer(scopeKey, request.deviceId, at) ?? null : null; } catch { offered = null; }
  return {
    status: 200,
    body: {
      schemaVersion: PRIVATE_LISTENING_SCHEMA_VERSION, listening: true, kind: listener.kind, since: listener.since,
      expiresAt: new Date(Date.parse(at) + PRIVATE_LISTENING_LIMITS.freshMilliseconds).toISOString(),
      pollAfterSeconds: PRIVATE_LISTENING_LIMITS.pollSeconds,
      ...(dependencies.reachOuts?.enabled ? { speaks: listener.speaks, reachOut: offered } : {}),
    },
  };
}

const CLAIM_REFUSALS = {
  disabled: [403, 'PRIVATE_REACH_OUTS_DISABLED', 'Speaking her messages through earphones is switched off on the server.'],
  not_found: [404, 'REACH_OUT_NOT_FOUND', 'No such message of hers.'],
  read: [409, 'REACH_OUT_ALREADY_READ', 'The owner already read this message.'],
  expired: [410, 'REACH_OUT_EXPIRED', 'This message is too old to be spoken.'],
  not_listening: [409, 'REACH_OUT_NOT_LISTENING', 'This device is not reported as privately listening and able to speak.'],
  not_chosen: [409, 'REACH_OUT_NOT_YOURS', 'Another of the owner\'s devices speaks now.'],
  answered: [409, 'REACH_OUT_ANSWERED', 'The owner already wrote or spoke after this message.'],
  taken: [409, 'REACH_OUT_TAKEN', 'Another surface already took this message.'],
} as const;

const REPORT_REFUSALS = {
  disabled: [403, 'PRIVATE_REACH_OUTS_DISABLED', 'Speaking her messages through earphones is switched off on the server.'],
  not_claimed: [409, 'REACH_OUT_NOT_CLAIMED', 'This device does not hold this message.'],
  already_spoken: [409, 'REACH_OUT_ALREADY_REPORTED', 'This device already reported that it spoke this message.'],
  not_found: [404, 'REACH_OUT_NOT_FOUND', 'No such message of hers.'],
  expired: [410, 'REACH_OUT_EXPIRED', 'This message is too old to report on.'],
  conflict: [409, 'REACH_OUT_ALREADY_REPORTED', 'This device already reported another outcome for this message.'],
} as const;

function dispatchReachOut(
  body: Record<string, unknown>, scopeKey: string, deviceId: string,
  route: { id: string; action: 'claim' | 'delivery' }, dependencies: PrivateListeningDependencies,
): ApiResponse {
  const reachOuts = dependencies.reachOuts;
  if (!reachOuts) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (route.action === 'claim') {
    const unknown = Object.keys(body).find(key => key !== 'scopeKey');
    if (unknown) return badRequest(`${unknown.slice(0, 40)} is not allowed`);
    const claim = reachOuts.claim(scopeKey, deviceId, route.id);
    if (claim.kind !== 'claimed') {
      const [status, error, message] = CLAIM_REFUSALS[claim.kind];
      return { status, body: { error, message } };
    }
    return {
      status: 200,
      body: {
        schemaVersion: PRIVATE_LISTENING_SCHEMA_VERSION, id: route.id, status: claim.status, surface: claim.surface, spoken: claim.spoken,
        listenSeconds: claim.listenSeconds, message: claim.message,
      },
    };
  }
  const report = validatedPrivateReachOutReport(body);
  if (typeof report === 'string') return badRequest(report);
  const result = reachOuts.report(scopeKey, deviceId, route.id, report.outcome);
  if (result.kind === 'done') return { status: 200, body: { schemaVersion: PRIVATE_LISTENING_SCHEMA_VERSION, id: route.id, status: result.status } };
  const [status, error, message] = REPORT_REFUSALS[result.kind];
  return { status, body: { error, message } };
}
