import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MessageReactions } from '../../mind/learning/messageReactions.js';
import { readJson, sendJson } from './serverHttp.js';

export const REACTIONS_PATH = '/v1/reactions';
export interface ReactionRouteDependencies {
  reactions: Pick<MessageReactions, 'list' | 'set'> | null;
  ownerScopeKey: string;
  /** Current authoritative audience; unknown/errors deny. Never inferred from the body. */
  ownerAlone(scopeKey: string): boolean;
}
const ID = /^[A-Za-z0-9_.:-]{1,320}$/u;
const REACTION_ERROR_STATUS = Object.freeze({ REACTIONS_NOT_FOUND: 404, REACTIONS_LIMIT: 409, REACTIONS_INPUT_INVALID: 400 } as const);
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

function validCommand(body: Record<string, unknown>): body is { threadId: string; messageId: string; emoji: string; on: boolean } {
  return Object.keys(body).every(key => ['threadId', 'messageId', 'emoji', 'on'].includes(key))
    && id(body.threadId) && id(body.messageId) && typeof body.emoji === 'string' && typeof body.on === 'boolean';
}

function read(reactions: Pick<MessageReactions, 'list'>, response: ServerResponse, scopeKey: string, threadId: string | null, allowed: () => boolean) {
  if (!id(threadId)) return sendJson(response, 400, { error: 'REACTIONS_INPUT_INVALID' });
  const views = reactions.list(scopeKey, threadId);
  if (!allowed()) return sendJson(response, 403, { error: 'REACTIONS_OWNER_ALONE_REQUIRED' });
  return sendJson(response, 200, { reactions: views });
}

function write(reactions: Pick<MessageReactions, 'set'>, response: ServerResponse, scopeKey: string, raw: unknown, allowed: () => boolean) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!body || !validCommand(body)) return sendJson(response, 400, { error: 'REACTIONS_INPUT_INVALID' });
  // Asked again after the body was read, and after the change: a reply never shows what others may not see.
  if (!allowed()) return sendJson(response, 403, { error: 'REACTIONS_OWNER_ALONE_REQUIRED' });
  const changed = reactions.set(scopeKey, body);
  if (!allowed()) return sendJson(response, 403, { error: 'REACTIONS_OWNER_ALONE_REQUIRED' });
  if (typeof changed === 'string') return sendJson(response, REACTION_ERROR_STATUS[changed], { error: changed });
  return sendJson(response, 200, { reaction: changed });
}

/**
 * `GET /v1/reactions?threadId=` and `POST /v1/reactions` (rich chat, `docs/rich-chat-contract.md`), with `/v1/feedback`'s
 * conventions: the owner's scope only, the owner alone (asked again after the body is read and after the change), closed codes.
 */
export function createReactionRoute(dependencies: ReactionRouteDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null): Promise<void> => {
    if (!principal || principal.scopeKey !== dependencies.ownerScopeKey) return sendJson(response, 403, { error: 'REACTIONS_OWNER_ONLY' });
    if (!dependencies.reactions) return sendJson(response, 404, { error: 'REACTIONS_DISABLED' });
    const allowed = () => { try { return dependencies.ownerAlone(principal.scopeKey) === true; } catch { return false; } };
    if (!allowed()) return sendJson(response, 403, { error: 'REACTIONS_OWNER_ALONE_REQUIRED' });
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== REACTIONS_PATH) return sendJson(response, 404, { error: 'NOT_FOUND' });
      if (request.method === 'GET') return read(dependencies.reactions, response, principal.scopeKey, url.searchParams.get('threadId'), allowed);
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return write(dependencies.reactions, response, principal.scopeKey, await readJson(request, 2048), allowed);
    } catch { return sendJson(response, 503, { error: 'REACTIONS_UNAVAILABLE' }); }
  };
}
