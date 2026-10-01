import type { ApiRequest, ApiResponse } from './contracts.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import { validatedBodyCapabilities, validatedBodyEvents } from './bodyContract.js';
import type { ShannonBody } from './shannonBody.js';

export const BODY_ROUTE_PREFIX = '/v1/body/';
export const BODY_CAPABILITIES_PATH = '/v1/body/capabilities';
/** A fixed-token (local) caller has no paired device. */
const LOCAL_DEVICE = 'local';

/**
 * Routes of Shannon's body (`docs/body-contract.md`). The body reports facts, reads a
 * snapshot, registers what it can express, and reads fixed nudge lines. No route here
 * calls a model, writes as Shannon, or carries text from the body into a prompt.
 */
export function dispatchBodyRequest(request: ApiRequest, body: ShannonBody): ApiResponse {
  const deviceId = request.deviceId ?? LOCAL_DEVICE;

  if (request.method === 'GET') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (request.path === '/v1/body/presence') {
      const etag = request.query?.get('etag') ?? undefined;
      if (etag !== undefined && !/^[0-9a-f]{16}$/u.test(etag)) return badRequest('etag is invalid');
      return { status: 200, body: body.presence(scopeKey, deviceId, etag) };
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

  if (request.method === 'PUT' && request.path === BODY_CAPABILITIES_PATH) {
    const capabilities = validatedBodyCapabilities(request.body);
    if (typeof capabilities === 'string') return badRequest(capabilities);
    return { status: 200, body: body.saveCapabilities(scopeKey, deviceId, capabilities) };
  }
  return { status: 404, body: { error: 'NOT_FOUND' } };
}
