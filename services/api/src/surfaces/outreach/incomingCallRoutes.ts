import { badRequest, objectBody, validScopeKey } from '../../infra/http/apiValidation.js';
import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import {
  INCOMING_CALL_LIMITS, INCOMING_CALL_PATH, INCOMING_CALL_REGISTRATION_PATH, INCOMING_CALL_SCHEMA_VERSION,
  incomingCallReportRoute, validatedIncomingCallRegistration, validatedIncomingCallReport,
} from '../../contracts/incomingCallContract.js';
import type { IncomingCalls } from './incomingCalls.js';

export interface IncomingCallRouteDependencies {
  calls: IncomingCalls;
  /** `SHANNON_OWNER_SCOPE_KEY` (default `owner`): only a device paired into that scope may register or report. */
  ownerScopeKey: string;
  /** `SHANNON_APNS_BUNDLE_ID`, when set: a registration for another app is refused. */
  bundleId: string | null;
}

const PAIRED_ONLY: ApiResponse = { status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED', message: 'Only a paired device may register for calls.' } };
const OWNER_ONLY: ApiResponse = { status: 403, body: { error: 'INCOMING_CALLS_OWNER_ONLY', message: 'Only the owner\'s own devices are called.' } };

const REPORT_REFUSALS = {
  not_found: [404, 'CALL_NOT_FOUND', 'No such call.'],
  not_yours: [409, 'CALL_NOT_YOURS', 'Another device was called.'],
  conflict: [409, 'CALL_ALREADY_REPORTED', 'Another outcome was already reported for this call.'],
} as const;

/**
 * `/v1/incoming-calls` (`docs/incoming-call-contract.md`): the owner's iPhone registers its VoIP push token with the
 * owner's switch, and says what became of a call. The device is taken from its token; a caller without a paired
 * device, or paired into another scope, is refused on every route, so a guest can neither be rung nor report.
 * Her words never pass through here: the device that answered takes them through the claim route.
 */
export function dispatchIncomingCallRequest(request: ApiRequest, dependencies: IncomingCallRouteDependencies): ApiResponse {
  const reported = request.path.startsWith(`${INCOMING_CALL_PATH}/`) ? incomingCallReportRoute(request.path) : null;
  if (request.path !== INCOMING_CALL_REGISTRATION_PATH && !reported) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (request.method !== 'POST') return { status: 405, body: { error: 'METHOD_NOT_ALLOWED' } };
  if (!request.deviceId) return PAIRED_ONLY;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  if (scopeKey !== dependencies.ownerScopeKey) return OWNER_ONLY;
  const { calls } = dependencies;

  if (reported) {
    const report = validatedIncomingCallReport(request.body);
    if (typeof report === 'string') return badRequest(report);
    const result = calls.report(scopeKey, request.deviceId, reported, report.outcome);
    if (result.kind === 'done') return { status: 200, body: { schemaVersion: INCOMING_CALL_SCHEMA_VERSION, callId: reported, status: result.status } };
    const [status, error, message] = REPORT_REFUSALS[result.kind];
    return { status, body: { error, message } };
  }

  const registration = validatedIncomingCallRegistration(request.body);
  if (typeof registration === 'string') return badRequest(registration);
  if (dependencies.bundleId && registration.bundleId !== dependencies.bundleId) return badRequest('bundleId is not this server\'s app');
  // Stored whether or not the server can ring yet: when it can, the device is already known. Off, it is kept and never rung.
  calls.register(scopeKey, request.deviceId, registration);
  return {
    status: 200,
    body: {
      schemaVersion: INCOMING_CALL_SCHEMA_VERSION, registered: true, enabled: registration.enabled,
      // The truth for the settings row: false while the kill switch is off or the server holds no APNs key.
      available: calls.available, ringSeconds: INCOMING_CALL_LIMITS.ringSeconds,
    },
  };
}
