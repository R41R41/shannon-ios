import type { ApiRequest, ApiResponse } from './contracts.js';
import { badRequest, objectBody, validBoundedString, validScopeKey } from './apiValidation.js';
import {
  PersonIdentityError,
  type PersonIdentityStore,
  type PersonPlatform,
} from './personIdentity.js';

export interface ApiPersonRouteDependencies {
  personIdentities: PersonIdentityStore;
  now: () => string;
}

export function dispatchPersonRequest(
  request: ApiRequest,
  dependencies: ApiPersonRouteDependencies,
): ApiResponse | undefined {
  if (!request.path.startsWith('/v1/people')) return undefined;

  if (request.method === 'GET' && request.path === '/v1/people') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: { people: dependencies.personIdentities.list(scopeKey) } };
  }

  if (request.method === 'GET' && request.path === '/v1/people/audit') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const rawLimit = request.query?.get('limit');
    const limit = rawLimit === null || rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return badRequest('limit is invalid');
    return { status: 200, body: { events: dependencies.personIdentities.audit(scopeKey, limit) } };
  }

  if (request.method === 'POST' && request.path === '/v1/people/candidates') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const displayName = request.body.displayName;
    const platform = request.body.platform;
    const externalUserId = request.body.externalUserId;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!validDisplayName(displayName)) return badRequest('displayName is invalid');
    if (!isPersonPlatform(platform)) return badRequest('platform is invalid');
    if (!validExternalUserId(platform, externalUserId)) {
      return badRequest('externalUserId is invalid');
    }
    return handlePersonAction(() => ({
      status: 201,
      body: dependencies.personIdentities.createCandidate(scopeKey, {
        displayName: displayName.trim(),
        platform,
        externalUserId: externalUserId.trim(),
      }, dependencies.now()),
    }));
  }

  if (request.method === 'POST' && request.path === '/v1/people/identities/confirm') {
    const action = validatedIdentityAction(request);
    if ('status' in action) return action;
    return handlePersonAction(() => ({
      status: 200,
      body: dependencies.personIdentities.confirm(
        action.scopeKey,
        action.personId,
        action.platform,
        action.expectedRevision,
        dependencies.now(),
      ),
    }));
  }

  if (request.method === 'POST' && request.path === '/v1/people/identities/correct') {
    const action = validatedIdentityAction(request);
    if ('status' in action) return action;
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const displayName = request.body.displayName;
    const externalUserId = request.body.externalUserId;
    if (displayName === undefined && externalUserId === undefined) {
      return badRequest('displayName or externalUserId is required');
    }
    if (displayName !== undefined && !validDisplayName(displayName)) return badRequest('displayName is invalid');
    if (externalUserId !== undefined && !validExternalUserId(action.platform, externalUserId)) {
      return badRequest('externalUserId is invalid');
    }
    return handlePersonAction(() => ({
      status: 200,
      body: dependencies.personIdentities.correct(
        action.scopeKey,
        action.personId,
        action.platform,
        action.expectedRevision,
        {
          ...(typeof displayName === 'string' ? { displayName: displayName.trim() } : {}),
          ...(typeof externalUserId === 'string' ? { externalUserId: externalUserId.trim() } : {}),
        },
        dependencies.now(),
      ),
    }));
  }

  if (request.method === 'POST' && request.path === '/v1/people/identities/revoke') {
    const action = validatedIdentityAction(request);
    if ('status' in action) return action;
    return handlePersonAction(() => ({
      status: 200,
      body: dependencies.personIdentities.revoke(
        action.scopeKey,
        action.personId,
        action.platform,
        action.expectedRevision,
        dependencies.now(),
      ),
    }));
  }

  if (request.method === 'POST' && request.path === '/v1/people/delete') {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    const personId = request.body.personId;
    const expectedRevision = request.body.expectedRevision;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!validPersonId(personId)) return badRequest('personId is invalid');
    if (!validRevision(expectedRevision)) return badRequest('expectedRevision is invalid');
    return handlePersonAction(() => ({
      status: 200,
      body: dependencies.personIdentities.delete(
        scopeKey,
        personId.trim(),
        expectedRevision,
        dependencies.now(),
      ),
    }));
  }

  return undefined;
}

function validatedIdentityAction(request: ApiRequest): {
  scopeKey: string;
  personId: string;
  platform: PersonPlatform;
  expectedRevision: number;
} | ApiResponse {
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  if (!validScopeKey(request.body.scopeKey)) return badRequest('scopeKey is required');
  if (!validPersonId(request.body.personId)) return badRequest('personId is invalid');
  if (!isPersonPlatform(request.body.platform)) return badRequest('platform is invalid');
  if (!validRevision(request.body.expectedRevision)) return badRequest('expectedRevision is invalid');
  return {
    scopeKey: request.body.scopeKey,
    personId: request.body.personId.trim(),
    platform: request.body.platform,
    expectedRevision: request.body.expectedRevision,
  };
}

function handlePersonAction(operation: () => ApiResponse): ApiResponse {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof PersonIdentityError)) throw error;
    if (error.code === 'PERSON_NOT_FOUND' || error.code === 'PERSON_IDENTITY_NOT_FOUND') {
      return { status: 404, body: { error: error.code } };
    }
    return { status: 409, body: { error: error.code } };
  }
}

function isPersonPlatform(value: unknown): value is PersonPlatform {
  return value === 'discord';
}

function validDisplayName(value: unknown): value is string {
  return validBoundedString(value, 80) && !value.includes('\0');
}

function validExternalUserId(platform: PersonPlatform, value: unknown): value is string {
  return platform === 'discord' && typeof value === 'string' && /^\d{1,32}$/u.test(value.trim());
}

function validPersonId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/u.test(value.trim());
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
