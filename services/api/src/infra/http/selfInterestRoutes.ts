import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SelfInterestAction, SelfInterestOwnerCommand, SelfInterestSnapshot, SelfInterest, SelfInterestDetail } from '@shannon/cognition';
import { readJson, sendJson } from './serverHttp.js';

export const SELF_INTERESTS_PATH = '/v1/autonomy/interests';
export const isSelfInterestsPath = (path: string) => path === SELF_INTERESTS_PATH || path.startsWith(`${SELF_INTERESTS_PATH}/`);
export interface SelfInterestOwnerRoutePort {
  read(scopeKey: string, cursor?: number): SelfInterestSnapshot;
  detail(scopeKey: string, itemId: string, cursor?: number): SelfInterestDetail | null;
  operation(scopeKey: string, operationId: string): { code: string; item: SelfInterest | null; revision: number } | null;
  mutate(scopeKey: string, command: SelfInterestOwnerCommand): { code: string; item: SelfInterest | null; revision: number };
}
const ACTIONS: readonly SelfInterestAction[] = ['undo', 'pin', 'unpin', 'ban', 'unban', 'forget', 'resume'];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/u;
export function createSelfInterestRoute(dependencies: {
  interests: SelfInterestOwnerRoutePort | null; ownerScopeKey: string;
  /** Current authoritative audience. Missing/unknown/failing context grants no private read or owner mutation. */
  ownerAlone?(scopeKey: string): boolean;
}) {
  return async (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null, path: string): Promise<void> => {
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (principal.scopeKey !== dependencies.ownerScopeKey) return sendJson(response, 403, { error: 'INTERESTS_OWNER_ONLY' });
    const port = dependencies.interests;
    if (!port) return sendJson(response, 403, { error: 'INTERESTS_DISABLED' });
    const scope = principal.scopeKey;
    const allowed = () => { try { return dependencies.ownerAlone?.(scope) === true; } catch { return false; } };
    const send = (status: number, value: unknown): void => allowed() ? sendJson(response, status, value)
      : sendJson(response, 403, { error: 'INTERESTS_OWNER_ALONE_REQUIRED' });
    if (!allowed()) return send(403, { error: 'INTERESTS_OWNER_ALONE_REQUIRED' });
    const operation = /^\/v1\/autonomy\/interests\/operations\/([A-Za-z0-9][A-Za-z0-9_:.-]{0,199})$/u.exec(path);
    if (operation) {
      if (request.method !== 'GET') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      try {
        const result = port.operation(scope, operation[1]!);
        return send(200, { operationId: operation[1], found: result !== null, result, latest: port.read(scope) });
      } catch { return send(503, { error: 'INTEREST_OPERATION_UNAVAILABLE' }); }
    }
    const rawCursor = new URL(request.url ?? path, 'http://local').searchParams.get('cursor');
    const cursor = rawCursor === null ? undefined : Number(rawCursor);
    if (cursor !== undefined && (!/^[1-9][0-9]*$/u.test(rawCursor!) || !Number.isSafeInteger(cursor))) return send(400, { error: 'INVALID_INTEREST_CURSOR' });
    if (path === SELF_INTERESTS_PATH) {
      if (request.method !== 'GET') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      try { return send(200, port.read(scope, cursor)); }
      catch { return send(503, { error: 'INTEREST_READ_UNAVAILABLE' }); }
    }
    const match = /^\/v1\/autonomy\/interests\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,119})(?:\/(undo|pin|unpin|ban|unban|forget|resume))?$/u.exec(path);
    if (!match) return send(404, { error: 'NOT_FOUND' });
    const [, itemId, action] = match;
    if (!action) {
      if (request.method !== 'GET') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      try {
        const detail = port.detail(scope, itemId!, cursor);
        return detail ? send(200, detail) : send(404, { error: 'INTEREST_NOT_FOUND' });
      } catch { return send(503, { error: 'INTEREST_READ_UNAVAILABLE' }); }
    }
    if (request.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
    let body: unknown;
    try { body = await readJson(request, 2_000); } catch { return send(400, { error: 'INVALID_INTEREST_COMMAND' }); }
    if (!allowed()) return send(403, { error: 'INTERESTS_OWNER_ALONE_REQUIRED' });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'INVALID_INTEREST_COMMAND' });
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some(key => !['operationId', 'expectedRevision', 'changeId'].includes(key))
      || typeof value.operationId !== 'string' || !IDENTIFIER.test(value.operationId)
      || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1
      || value.changeId !== undefined && (typeof value.changeId !== 'string' || !IDENTIFIER.test(value.changeId))
      || action === 'undo' && !value.changeId || !ACTIONS.includes(action as SelfInterestAction)) return send(400, { error: 'INVALID_INTEREST_COMMAND' });
    try {
      if (!allowed()) return send(403, { error: 'INTERESTS_OWNER_ALONE_REQUIRED' });
      const result = port.mutate(scope, { operationId: value.operationId, itemId: itemId!, expectedRevision: Number(value.expectedRevision),
        action: action as SelfInterestAction, ...(value.changeId ? { changeId: String(value.changeId) } : {}) });
      const status = result.code === 'changed' ? 200 : result.code === 'not_found' || result.code === 'change_not_found' ? 404 : 409;
      return send(status, { ...result, ...(status === 409 ? { latest: port.read(scope) } : {}) });
    } catch { return send(503, { error: 'INTEREST_OPERATION_UNAVAILABLE' }); }
  };
}
