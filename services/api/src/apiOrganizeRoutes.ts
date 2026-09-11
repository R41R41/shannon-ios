import type { ApiRequest, ApiResponse } from './contracts.js';
import type { OrganizeDecision, OrganizeStore, VoyagerCatalog, VoyagerTaskDestination } from './organize.js';
import { OrganizeError } from './organize.js';
import { badRequest, objectBody, validBoundedString, validScopeKey, validVoyagerTaskProjection } from './apiValidation.js';

export interface ApiOrganizeRouteDependencies {
  organizeStore: OrganizeStore;
  voyagerCatalog: VoyagerCatalog;
  voyagerDestination: VoyagerTaskDestination;
  now: () => string;
}

export async function dispatchOrganizeRequest(request: ApiRequest, dependencies: ApiOrganizeRouteDependencies): Promise<ApiResponse | undefined> {
  if (request.method === 'GET' && request.path === '/v1/organize/sessions') {
    const scopeKey = request.query?.get('scopeKey');
    const threadId = request.query?.get('threadId')?.trim();
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!threadId) return badRequest('threadId is required');
    return { status: 200, body: { sessions: dependencies.organizeStore.list(scopeKey, threadId) } };
  }

  if (request.method === 'GET' && request.path === '/v1/integrations/voyager/tasks') {
    const scopeKey = request.query?.get('scopeKey');
    const query = request.query?.get('query')?.trim() ?? '';
    const limit = Number(request.query?.get('limit') ?? '8');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!validBoundedString(query, 160)) return badRequest('query is required');
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) return badRequest('limit is invalid');
    try {
      const items = await dependencies.voyagerCatalog.searchTasks(query, limit);
      return { status: 200, body: { items } };
    } catch (error) { return organizeErrorResponse(error); }
  }

  if (request.method === 'GET' && request.path === '/v1/integrations/voyager/projects') {
    const scopeKey = request.query?.get('scopeKey');
    const limit = Number(request.query?.get('limit') ?? '20');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return badRequest('limit is invalid');
    try {
      const items = await dependencies.voyagerCatalog.listProjects(limit);
      return { status: 200, body: { items } };
    } catch (error) { return organizeErrorResponse(error); }
  }

  const organizeSessionMatch = request.path.match(/^\/v1\/organize\/sessions\/([^/]+)$/);
  if (request.method === 'GET' && organizeSessionMatch) {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const session = dependencies.organizeStore.get(scopeKey, decodeURIComponent(organizeSessionMatch[1] ?? ''));
    return session ? { status: 200, body: { session } } : { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
  }

  const organizeDecisionMatch = request.path.match(/^\/v1\/organize\/sessions\/([^/]+)\/items\/([^/]+)\/decision$/);
  if (request.method === 'POST' && organizeDecisionMatch) {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!Number.isInteger(request.body.expectedRevision) || Number(request.body.expectedRevision) < 1) return badRequest('expectedRevision is invalid');
    if (!['accepted', 'rejected', 'deferred'].includes(String(request.body.decision))) return badRequest('decision is invalid');
    if (request.body.title !== undefined && !validBoundedString(request.body.title, 500)) return badRequest('title is invalid');
    if (request.body.details !== undefined && (typeof request.body.details !== 'string' || request.body.details.length > 1_000)) return badRequest('details is invalid');
    if (request.body.operation !== undefined && !['create', 'update'].includes(String(request.body.operation))) return badRequest('operation is invalid');
    if (request.body.projectIds !== undefined && (!Array.isArray(request.body.projectIds) || request.body.projectIds.length > 12 || !request.body.projectIds.every(value => validBoundedString(value, 160)))) return badRequest('projectIds is invalid');
    if (request.body.target !== undefined && !validVoyagerTaskProjection(request.body.target)) return badRequest('target is invalid');
    if (request.body.operation === 'update' && request.body.target === undefined) return badRequest('target is required');
    try {
      const session = dependencies.organizeStore.decide(
        scopeKey,
        decodeURIComponent(organizeDecisionMatch[1] ?? ''),
        decodeURIComponent(organizeDecisionMatch[2] ?? ''),
        Number(request.body.expectedRevision),
        request.body.decision as OrganizeDecision,
        {
          ...(typeof request.body.title === 'string' ? { title: request.body.title } : {}),
          ...(typeof request.body.details === 'string' ? { details: request.body.details } : {}),
          ...(request.body.operation === 'create' || request.body.operation === 'update' ? { operation: request.body.operation } : {}),
          ...(validVoyagerTaskProjection(request.body.target) ? { target: request.body.target } : {}),
          ...(Array.isArray(request.body.projectIds) ? { projectIds: request.body.projectIds as string[] } : {}),
        },
        dependencies.now(),
      );
      return { status: 200, body: { session } };
    } catch (error) { return organizeErrorResponse(error); }
  }

  const organizeApplyMatch = request.path.match(/^\/v1\/organize\/sessions\/([^/]+)\/apply$/);
  if (request.method === 'POST' && organizeApplyMatch) {
    if (!objectBody(request.body)) return badRequest('JSON object body is required');
    const scopeKey = request.body.scopeKey;
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (!Number.isInteger(request.body.expectedRevision) || Number(request.body.expectedRevision) < 1) return badRequest('expectedRevision is invalid');
    const sessionId = decodeURIComponent(organizeApplyMatch[1] ?? '');
    let session = dependencies.organizeStore.get(scopeKey, sessionId);
    if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
    if (session.revision !== Number(request.body.expectedRevision)) return { status: 409, body: { error: 'REVISION_CONFLICT' } };
    if (session.state === 'applied') {
      const applied = session.items.flatMap(item => item.destinationStatus === 'applied' && item.result ? [item.result] : []);
      return { status: 200, body: { session, appliedCount: applied.length, tasks: applied } };
    }
    if (session.items.some(item => item.decision === 'proposed')) {
      return { status: 409, body: { error: 'REVIEW_INCOMPLETE' } };
    }
    for (const item of session.items.filter(value => value.decision === 'accepted' && value.destinationStatus !== 'applied')) {
      try {
        const result = await dependencies.voyagerDestination.apply(session, item);
        session = dependencies.organizeStore.recordAttempt(scopeKey, sessionId, item.id, result, undefined, dependencies.now());
      } catch (error) {
        const code = error instanceof OrganizeError ? error.code : 'DESTINATION_UNAVAILABLE';
        session = dependencies.organizeStore.recordAttempt(scopeKey, sessionId, item.id, undefined, code, dependencies.now());
      }
    }
    session = dependencies.organizeStore.finishApply(scopeKey, sessionId, dependencies.now());
    const applied = session.items.flatMap(item => item.destinationStatus === 'applied' && item.result ? [item.result] : []);
    return {
      status: 200,
      body: { session, appliedCount: applied.length, tasks: applied },
    };
  }
  return undefined;
}

function organizeErrorResponse(error: unknown): ApiResponse {
  if (error instanceof OrganizeError) return { status: error.status, body: { error: error.code, retryable: error.retryable } };
  throw error;
}
