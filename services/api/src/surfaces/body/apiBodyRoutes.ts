import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import { badRequest, objectBody, validScopeKey } from '../../infra/http/apiValidation.js';
import {
  BODY_REACH_OUT_REPORT_PREFIX, BODY_SCHEMA_VERSION, BODY_TOUCH_VOCABULARY, bodyReachOutReportId, validatedBodyCapabilities, validatedBodyEvents, validatedBodyReachOutReport,
} from '../../contracts/bodyContract.js';
import { BODY_LOOK_RESULT_PREFIX, bodyLookResultId, validatedBodyLookResult } from '../../contracts/bodyLookContract.js';
import type { BodyLookAnswer } from './bodyLook.js';
import type { BodyReactionOutcome } from './bodyReaction.js';
import { BODY_REACTION_PATH, validatedBodyReactionRequest } from '../../contracts/bodyReactionContract.js';
import type { ShannonBody } from './shannonBody.js';
import { dispatchAppLookRequest } from './apiAppLookRoutes.js';
import { APP_LOOK_ROUTE_PREFIX } from '../../contracts/appLookContract.js';

export const BODY_ROUTE_PREFIX = '/v1/body/';
export const BODY_CAPABILITIES_PATH = '/v1/body/capabilities';
/** Paths this module answers: her body's routes, and the answer of a look through the owner's app. */
export const isBodyRoute = (path: string): boolean => path.startsWith(BODY_ROUTE_PREFIX) || path.startsWith(APP_LOOK_ROUTE_PREFIX);
/** A fixed-token (local) caller has no paired device. */
const LOCAL_DEVICE = 'local';

/**
 * Routes of Shannon's body (`docs/body-contract.md`). The body reports facts, reads a
 * snapshot, registers what it can express, and reads fixed nudge lines. No route here
 * carries text from the body into a prompt. Two routes call a model: the answer to a look,
 * which writes as Shannon (`bodyLook.ts`), and a touch she may answer with one line
 * (`bodyReaction.ts`), which is kept out of the conversation unless the owner answers it.
 */
export function dispatchBodyRequest(request: ApiRequest, body: ShannonBody): ApiResponse | Promise<ApiResponse> {
  if (request.path.startsWith(APP_LOOK_ROUTE_PREFIX)) return dispatchAppLookRequest(request, body.appLooks);
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

  // When she is touched: her feeling moves, she remembers, and she may say one line.
  if (request.method === 'POST' && request.path === BODY_REACTION_PATH) {
    const reaction = validatedBodyReactionRequest(request.body);
    if (typeof reaction === 'string') return badRequest(reaction);
    return body.reactions.react(scopeKey, deviceId, reaction).then(reactionResponse);
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
    const saved = body.saveCapabilities(scopeKey, deviceId, capabilities);
    // Her Minecraft body is identified by SHANNON_MINECRAFT_BODY_JSON alone and never registers (docs/minecraft-body-contract.md).
    if (saved === 'game_body') return { status: 403, body: { error: 'GAME_BODY_CAPABILITIES_DENIED', message: 'The Minecraft body does not register body capabilities.' } };
    // An app's desktop body (desktopBodyIdentity.ts) is a full body on the Mac and nothing else.
    if (saved === 'desktop_body_shape') return badRequest('a desktop body registers surface "mac" and no touchOnly');
    // The touch vocabulary this server takes: a body sends the fields of vocabulary 2 only once it has seen it here or on presence.
    return { status: 200, body: { ...saved, touchVocabulary: BODY_TOUCH_VOCABULARY } };
  }
  return { status: 404, body: { error: 'NOT_FOUND' } };
}

const REACH_OUT_REPORT_REFUSALS = {
  unavailable: [404, 'NOT_FOUND', 'This server does not take delivery reports.'],
  disabled: [403, 'BODY_INGEST_DISABLED', 'Body events are switched off on the server.'],
  reports_disabled: [403, 'REACH_OUT_REPORTS_DISABLED', 'Delivery reports are switched off on the server.'],
  not_a_body: [403, 'REACH_OUT_NOT_A_BODY', 'Only a device that registered its capabilities as her body may report.'],
  not_found: [404, 'REACH_OUT_NOT_FOUND', 'No such message of hers.'],
  conflict: [409, 'REACH_OUT_ALREADY_REPORTED', 'This device already reported another outcome for this message.'],
  expired: [410, 'REACH_OUT_EXPIRED', 'This message is too old to report on.'],
} as const;

const REACTION_REFUSALS = {
  disabled: [403, 'BODY_REACTIONS_DISABLED', 'Reactions to a touch are switched off on the server.'],
  ingest_disabled: [403, 'BODY_INGEST_DISABLED', 'Body events are switched off on the server.'],
  not_owner: [403, 'BODY_REACTION_OWNER_ONLY', 'Only the body in the owner\'s own scope may ask for a reaction.'],
  not_a_body: [403, 'BODY_REACTION_NOT_A_BODY', 'Only a device that registered its capabilities as her body may ask.'],
  conflict: [409, 'BODY_REACTION_CONFLICT', 'This id was already used for a reaction with different content.'],
  rate_limited: [429, 'RATE_LIMITED', 'Too many reaction requests; retry after a minute.'],
} as const;

function reactionResponse(outcome: BodyReactionOutcome): ApiResponse {
  if (outcome.kind === 'done') return { status: 200, body: outcome.answer };
  const [status, error, message] = REACTION_REFUSALS[outcome.kind];
  return { status, body: { error, message } };
}

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
