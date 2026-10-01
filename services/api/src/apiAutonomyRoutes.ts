import type { ApiRequest, ApiResponse } from './contracts.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { AutonomyOwnerError, ShannonAutonomyService } from './autonomyService.js';

/**
 * Owner-facing routes of bounded autonomy. They read the ledgers and carry the
 * owner's decisions (stop switch, budget request, proposal, rest/drop a pursuit).
 * None of them lets a client write as Shannon: her side has no HTTP entrance.
 */
export function dispatchAutonomyRequest(request: ApiRequest, autonomy: ShannonAutonomyService): ApiResponse | undefined {
  if (!request.path.startsWith('/v1/autonomy')) return undefined;

  if (request.method === 'GET' && request.path === '/v1/autonomy') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: autonomy.overview(scopeKey) };
  }

  if (request.method === 'GET' && request.path === '/v1/autonomy/activity') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    const days = Number(request.query?.get('days') ?? '14');
    if (!Number.isInteger(days) || days < 1 || days > 90) return badRequest('days must be 1..90');
    return { status: 200, body: { control: autonomy.overview(scopeKey).control, days: autonomy.activityDays(scopeKey, days) } };
  }

  if (request.method !== 'POST') return undefined;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');

  if (request.path === '/v1/autonomy/pause') {
    if (typeof request.body.paused !== 'boolean') return badRequest('paused must be a boolean');
    return { status: 200, body: autonomy.setPaused(scopeKey, request.body.paused) };
  }

  const budgetMatch = request.path.match(/^\/v1\/autonomy\/budget-requests\/([^/]+)\/decision$/u);
  if (budgetMatch) {
    const decision = request.body.decision;
    if (decision !== 'approve' && decision !== 'decline') return badRequest('decision is invalid');
    const amountYen = request.body.amountYen;
    if (amountYen !== undefined && (typeof amountYen !== 'number' || !Number.isFinite(amountYen))) return badRequest('amountYen is invalid');
    return ownerResult(autonomy.decideBudgetRequest(scopeKey, decodeURIComponent(budgetMatch[1] ?? ''), decision, amountYen));
  }

  const pursuitMatch = request.path.match(/^\/v1\/autonomy\/pursuits\/([^/]+)\/status$/u);
  if (pursuitMatch) {
    const status = request.body.status;
    if (status !== 'resting' && status !== 'dropped') return badRequest('status must be resting or dropped');
    return ownerResult(autonomy.setPursuitStatusByOwner(scopeKey, decodeURIComponent(pursuitMatch[1] ?? ''), status));
  }

  const proposalMatch = request.path.match(/^\/v1\/autonomy\/proposals\/([^/]+)\/decision$/u);
  if (proposalMatch) {
    const decision = request.body.decision;
    if (decision !== 'start' && decision !== 'decline') return badRequest('decision is invalid');
    const result = autonomy.decideProposal(scopeKey, decodeURIComponent(proposalMatch[1] ?? ''), decision);
    return typeof result === 'string' ? ownerResult(result) : { status: 200, body: { ...result.overview, ...(result.task ? { task: result.task } : {}) } };
  }
  return undefined;
}

function ownerResult(result: object | AutonomyOwnerError): ApiResponse {
  if (typeof result !== 'string') return { status: 200, body: result };
  if (result.endsWith('_NOT_FOUND')) return { status: 404, body: { error: result } };
  if (result === 'BUDGET_AMOUNT_INVALID' || result === 'PURSUIT_INVALID') return { status: 400, body: { error: result } };
  if (result === 'AGENT_TASKS_UNAVAILABLE') return { status: 503, body: { error: result } };
  return { status: 409, body: { error: result } };
}
