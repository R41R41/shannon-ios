import type { ApiResponse } from '../../contracts/contracts.js';

/**
 * The owner's routes of the Executive (Syzygy ADR-0009 stage 2, E1/E2; `docs/executive-ui-contract.md`):
 *
 * - `GET /v1/autonomy/goals`: her goals, open and closed in the last 14 days.
 * - `POST /v1/autonomy/pursuits/{id}/confirm` (`{ "scopeKey" }`): the owner confirms a goal is done; answers the goals view.
 *   Idempotent for a goal already done; a resting goal can be confirmed (coordinator decision 2026-10-13).
 * - `GET /v1/autonomy/capabilities`: the capability catalog, with policy, value and uses.
 * - `GET /v1/autonomy/choices?days=`: the Executive's choices (empty until E5).
 * - `GET /v1/autonomy/inspection?day=`: the day's counts and the seven days ending on it.
 *
 * Owner only: a paired device of the owner's scope, or the developer token with the owner's `scopeKey`. Anyone else: 403.
 */
export interface ExecutiveRouteDependencies {
  ownerScopeKey: string;
  now(): string;
  /** The owner-local day of an instant (`YYYY-MM-DD`). */
  dayKey(at: string): string;
  goals(scopeKey: string, at: string): object;
  /** Confirms; null when it was done (or already was), else the rejection code. */
  confirm(scopeKey: string, pursuitId: string, at: string): string | null;
  capabilities(scopeKey: string, at: string): object;
  choices(scopeKey: string, days: number, at: string): object;
  inspection(scopeKey: string, day: string, at: string): object;
}

export interface ExecutiveRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}

const GET_PATHS = new Set(['/v1/autonomy/goals', '/v1/autonomy/capabilities', '/v1/autonomy/choices', '/v1/autonomy/inspection']);
const CONFIRM = /^\/v1\/autonomy\/pursuits\/([^/]+)\/confirm$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function isExecutivePath(path: string): boolean {
  return GET_PATHS.has(path) || CONFIRM.test(path);
}

const refused = (error: string, status = 403): ApiResponse => ({ status, body: { error } });

/** The scope the request may read: the owner's, from the device or (developer token) from the request; null otherwise. */
function ownerScope(request: ExecutiveRequest, principal: { scopeKey: string } | null, owner: string): string | null {
  const body = request.body && typeof request.body === 'object' ? (request.body as { scopeKey?: unknown }).scopeKey : undefined;
  const asked = request.query.get('scopeKey') ?? (typeof body === 'string' ? body : null);
  const scope = principal?.scopeKey ?? asked;
  if (scope !== owner || (asked !== null && asked !== scope)) return null;
  return scope;
}

export function dispatchExecutiveRequest(
  request: ExecutiveRequest, principal: { scopeKey: string } | null, dependencies: ExecutiveRouteDependencies,
): ApiResponse {
  const scopeKey = ownerScope(request, principal, dependencies.ownerScopeKey);
  if (!scopeKey) return refused('EXECUTIVE_OWNER_ONLY');
  const at = dependencies.now();
  const confirm = CONFIRM.exec(request.path);
  if (confirm) {
    if (request.method !== 'POST') return refused('METHOD_NOT_ALLOWED', 405);
    const rejection = dependencies.confirm(scopeKey, decodeURIComponent(confirm[1] ?? ''), at);
    if (rejection) return refused(rejection, rejection.endsWith('_NOT_FOUND') ? 404 : 409);
    return { status: 200, body: dependencies.goals(scopeKey, at) };
  }
  if (request.method !== 'GET') return refused('METHOD_NOT_ALLOWED', 405);
  return answerRead(request, scopeKey, at, dependencies);
}

function answerRead(request: ExecutiveRequest, scopeKey: string, at: string, dependencies: ExecutiveRouteDependencies): ApiResponse {
  if (request.path === '/v1/autonomy/goals') return { status: 200, body: dependencies.goals(scopeKey, at) };
  if (request.path === '/v1/autonomy/capabilities') return { status: 200, body: dependencies.capabilities(scopeKey, at) };
  if (request.path === '/v1/autonomy/choices') {
    const days = Number(request.query.get('days') ?? '7');
    if (!Number.isInteger(days) || days < 1 || days > 30) return refused('days must be 1..30', 400);
    return { status: 200, body: dependencies.choices(scopeKey, days, at) };
  }
  const day = request.query.get('day') ?? dependencies.dayKey(at);
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return refused('day must be YYYY-MM-DD', 400);
  return { status: 200, body: dependencies.inspection(scopeKey, day, at) };
}
