import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { ApiRequest, ApiResponse } from './contracts.js';
import {
  PRIVATE_LISTENING_LIMITS, PRIVATE_LISTENING_PATH, PRIVATE_LISTENING_SCHEMA_VERSION, validatedPrivateListeningReport,
} from './privateListeningContract.js';
import type { SQLitePrivateListeningStore } from './privateListeningStore.js';

export interface PrivateListeningDependencies {
  store: SQLitePrivateListeningStore;
  /** `SHANNON_PRIVATE_LISTENING`; off refuses every report. */
  enabled: boolean;
  /** `SHANNON_OWNER_SCOPE_KEY` (default `owner`): only a device paired into that scope may report. */
  ownerScopeKey: string;
  now: () => string;
}

const PAIRED_ONLY: ApiResponse = { status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED', message: 'Only a paired device may report private listening.' } };
const OWNER_ONLY: ApiResponse = { status: 403, body: { error: 'PRIVATE_LISTENING_OWNER_ONLY', message: 'Only the owner\'s own devices may report private listening.' } };
const DISABLED: ApiResponse = { status: 403, body: { error: 'PRIVATE_LISTENING_DISABLED', message: 'Private listening is switched off on the server.' } };

/**
 * `POST /v1/private-listening` (`docs/private-listening-contract.md`): one of the owner's apps says whether
 * only he can hear it now. The device is taken from its token; a caller without a paired device, or paired
 * into another scope, is refused, so a guest can never set the state. No route here calls a model.
 */
export function dispatchPrivateListeningRequest(request: ApiRequest, dependencies: PrivateListeningDependencies): ApiResponse {
  if (request.path !== PRIVATE_LISTENING_PATH) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (request.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } };
  if (!request.deviceId) return PAIRED_ONLY;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  if (scopeKey !== dependencies.ownerScopeKey) return OWNER_ONLY;
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
    kind: report.kind, ...(report.ownerActiveAt ? { ownerActiveAt: report.ownerActiveAt } : {}),
  }, at);
  return {
    status: 200,
    body: {
      schemaVersion: PRIVATE_LISTENING_SCHEMA_VERSION, listening: true, kind: listener.kind, since: listener.since,
      expiresAt: new Date(Date.parse(at) + PRIVATE_LISTENING_LIMITS.freshMilliseconds).toISOString(),
      pollAfterSeconds: PRIVATE_LISTENING_LIMITS.pollSeconds,
    },
  };
}
