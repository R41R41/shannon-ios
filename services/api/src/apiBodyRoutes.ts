import type { ApiRequest, ApiResponse } from './contracts.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import {
  BODY_REACH_OUT_REPORT_PREFIX, BODY_SCHEMA_VERSION, bodyReachOutReportId, validatedBodyCapabilities, validatedBodyEvents, validatedBodyReachOutReport,
} from './bodyContract.js';
import { BODY_LOOK_RESULT_PREFIX, bodyLookResultId, validatedBodyLookResult } from './bodyLookContract.js';
import type { BodyLookAnswer } from './bodyLook.js';
import type { ShannonBody } from './shannonBody.js';

export const BODY_ROUTE_PREFIX = '/v1/body/';
export const BODY_CAPABILITIES_PATH = '/v1/body/capabilities';
/** A fixed-token (local) caller has no paired device. */
const LOCAL_DEVICE = 'local';

/**
 * Routes of Shannon's body (`docs/body-contract.md`). The body reports facts, reads a
 * snapshot, registers what it can express, and reads fixed nudge lines. No route here
 * carries text from the body into a prompt. Only the answer to a look calls a model and
 * writes as Shannon (`bodyLook.ts`); every other route does neither.
 */
export function dispatchBodyRequest(request: ApiRequest, body: ShannonBody): ApiResponse | Promise<ApiResponse> {
  const deviceId = request.deviceId ?? LOCAL_DEVICE;

  if (request.method === 'GET') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (request.path === '/v1/body/presence') {
      const etag = request.query?.get('etag') ?? undefined;
      if (etag !== undefined && !/^[0-9a-f]{16}$/u.test(etag)) return badRequest('etag is invalid');
      // Optional: who can see or hear the body right now. An older body sends none, and nothing is assumed.
      const audience = request.query?.get('audience') ?? undefined;
      if (audience !== undefined && audience !== 'owner' && audience !== 'others') return badRequest('audience must be owner or others');
      return { status: 200, body: body.presence(scopeKey, deviceId, etag, audience) };
    }
    if (request.path === '/v1/body/nudges') return { status: 200, body: body.nudges(scopeKey) };
    return { status: 404, body: { error: 'NOT_FOUND' } };
  }

  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');

  if (request.method === 'POST' && request.path === '/v1/body/events') {
    const unknown = Object.keys(request.body).find(key => key !== 'scopeKey' && key !== 'events');
    if (unknown) return badRequest(`${unknown.slice(0, 40)} is not allowed`);
    const events = validatedBodyEvents(request.body.events);
    if (typeof events === 'string') return badRequest(events);
    const receipt = body.ingest(scopeKey, deviceId, events);
    return receipt === 'BODY_INGEST_DISABLED'
      ? { status: 403, body: { error: receipt, message: 'Body events are switched off on the server.' } }
      : { status: 200, body: receipt };
  }

  if (request.method === 'POST' && request.path.startsWith(BODY_LOOK_RESULT_PREFIX)) {
    const id = bodyLookResultId(request.path);
    if (!id) return { status: 404, body: { error: 'NOT_FOUND' } };
    const result = validatedBodyLookResult(request.body);
    if (typeof result === 'string') return badRequest(result);
    return body.looks.answer(scopeKey, deviceId, id, result).then(lookResponse);
  }

  // What the body did with a message she started on her own: one closed outcome, no text.
  if (request.method === 'POST' && request.path.startsWith(BODY_REACH_OUT_REPORT_PREFIX)) {
    const id = bodyReachOutReportId(request.path);
    if (!id) return { status: 404, body: { error: 'NOT_FOUND' } };
    const report = validatedBodyReachOutReport(request.body);
    if (typeof report === 'string') return badRequest(report);
    const result = body.reportReachOut(scopeKey, deviceId, id, report.outcome);
    if (result === 'stored' || result === 'duplicate') return { status: 200, body: { schemaVersion: BODY_SCHEMA_VERSION, id, status: result } };
    const [status, error, message] = REACH_OUT_REPORT_REFUSALS[result];
    return { status, body: { error, message } };
  }

  if (request.method === 'PUT' && request.path === BODY_CAPABILITIES_PATH) {
    const capabilities = validatedBodyCapabilities(request.body);
    if (typeof capabilities === 'string') return badRequest(capabilities);
    return { status: 200, body: body.saveCapabilities(scopeKey, deviceId, capabilities) };
  }
  return { status: 404, body: { error: 'NOT_FOUND' } };
}

const REACH_OUT_REPORT_REFUSALS = {
  unavailable: [404, 'NOT_FOUND', 'This server does not take delivery reports.'],
  disabled: [403, 'BODY_INGEST_DISABLED', 'Body events are switched off on the server.'],
  not_a_body: [403, 'REACH_OUT_NOT_A_BODY', 'Only a device that registered its capabilities as her body may report.'],
  not_found: [404, 'REACH_OUT_NOT_FOUND', 'No such message of hers.'],
  conflict: [409, 'REACH_OUT_ALREADY_REPORTED', 'This device already reported another outcome for this message.'],
  expired: [410, 'REACH_OUT_EXPIRED', 'This message is too old to report on.'],
} as const;

const LOOK_REFUSALS = {
  disabled: [403, 'BODY_LOOK_DISABLED', 'Looking is switched off on the server.'],
  not_found: [404, 'LOOK_NOT_FOUND', 'No such look.'],
  wrong_device: [403, 'LOOK_NOT_YOURS', 'This look was given to another device.'],
  answered: [409, 'LOOK_ALREADY_ANSWERED', 'This look was already answered.'],
  expired: [410, 'LOOK_EXPIRED', 'This look expired before it was answered.'],
} as const;

function lookResponse(answer: BodyLookAnswer): ApiResponse {
  if (answer.kind !== 'done') {
    const [status, error, message] = LOOK_REFUSALS[answer.kind];
    return { status, body: { error, message } };
  }
  return { status: 200, body: { schemaVersion: BODY_SCHEMA_VERSION, id: answer.id, status: answer.status, message: answer.message } };
}
