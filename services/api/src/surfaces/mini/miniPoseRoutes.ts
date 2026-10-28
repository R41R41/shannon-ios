import { createReadStream, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from '../../infra/http/serverHttp.js';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import type { MiniPoseChooser } from './miniPoseChooser.js';
import { MINI_CONTACTS, MINI_LIMITS, MINI_VARIANTS, type MiniChooseRequest, type MiniContact, type MiniPoseEntry } from './miniPoseContract.js';
import { miniStats, type MiniPoseLibrary } from './miniPoseLibrary.js';

/**
 * The mini poses over HTTP, for a paired device (the Windows and Mac residents):
 * - `GET /v1/mini/library`: the entries (no embeddings) and the library's version;
 * - `GET /v1/mini/image?id=&variant=`: one picture (immutable: a pose's pictures never change, a new picture is a new pose);
 * - `POST /v1/mini/choose`: which picture fits a reply (`MiniChooseRequest`); only the owner's replies may start a drawing;
 * - `POST /v1/mini/retire` `{ id }`: the owner takes a picture out;
 * - `GET /v1/mini/stats?since=`: the hit rate and the drawing times.
 */
export const MINI_PATH_PREFIX = '/v1/mini/';
const ID = /^[A-Za-z0-9_]{1,64}$/u;
const ACTIVITIES: readonly MiniPoseEntry['activity'][] = ['rest', 'walk', 'jump', 'fall', 'carried', 'sleep', 'poke', 'startle', 'rummage', 'found', 'getup', 'stretch', 'crouch'];

export function parsedChooseRequest(raw: unknown): MiniChooseRequest | null {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!body || typeof body.text !== 'string' || typeof body.expression !== 'string' || !/^[A-Za-z]{1,40}$/u.test(body.expression)) return null;
  if (typeof body.requestKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/u.test(body.requestKey)) return null;
  const contacts = Array.isArray(body.contacts) ? body.contacts.filter((c): c is MiniContact => MINI_CONTACTS.includes(c as MiniContact)) : [];
  if (!contacts.length) return null;
  const feeling = body.feeling && typeof body.feeling === 'object' ? body.feeling as { primary?: unknown; intensity?: unknown } : null;
  return {
    text: body.text.slice(0, MINI_LIMITS.textCharacters), expression: body.expression, contacts: [...new Set(contacts)], requestKey: body.requestKey,
    feeling: feeling && typeof feeling.primary === 'string' && typeof feeling.intensity === 'number'
      ? { primary: feeling.primary.slice(0, 40), intensity: Math.max(0, Math.min(1, feeling.intensity)) } : null,
    ...(ACTIVITIES.includes(body.activity as MiniPoseEntry['activity']) ? { activity: body.activity as MiniPoseEntry['activity'] } : {}),
  };
}

export function createMiniPoseRoute(parts: { library: MiniPoseLibrary; chooser: MiniPoseChooser; ownerScope: string; now?: () => string }) {
  const now = parts.now ?? (() => new Date().toISOString());
  return async (request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null, url: URL): Promise<void> => {
    if (!principal) return sendJson(response, 401, { error: 'MINI_PAIRING_REQUIRED' });
    const owner = principal.scopeKey === parts.ownerScope;
    try {
      const path = url.pathname.slice(MINI_PATH_PREFIX.length);
      if (path === 'library' && request.method === 'GET') return sendJson(response, 200, parts.library.view());
      if (path === 'image' && request.method === 'GET') {
        const id = url.searchParams.get('id') ?? '', variant = url.searchParams.get('variant') ?? 'base';
        if (!ID.test(id) || !MINI_VARIANTS.includes(variant as typeof MINI_VARIANTS[number])) return sendJson(response, 400, { error: 'MINI_INPUT_INVALID' });
        const entry = parts.library.get(id), file = parts.library.imagePath(id, variant as typeof MINI_VARIANTS[number]);
        if (!entry || !entry.variants.includes(variant as typeof MINI_VARIANTS[number]) || !existsSync(file)) return sendJson(response, 404, { error: 'MINI_NOT_FOUND' });
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=31536000, immutable' });
        createReadStream(file).pipe(response);
        return;
      }
      if (path === 'choose' && request.method === 'POST') {
        const body = parsedChooseRequest(await readJson(request, 8192));
        if (!body) return sendJson(response, 400, { error: 'MINI_INPUT_INVALID' });
        return sendJson(response, 200, await parts.chooser.choose(principal.scopeKey, body, owner));
      }
      if (path === 'retire' && request.method === 'POST') {
        if (!owner) return sendJson(response, 403, { error: 'MINI_OWNER_ONLY' });
        const body = await readJson(request, 1024) as { id?: unknown };
        if (typeof body?.id !== 'string' || !ID.test(body.id)) return sendJson(response, 400, { error: 'MINI_INPUT_INVALID' });
        return sendJson(response, parts.library.retire(body.id, now()) ? 200 : 404, { libraryVersion: parts.library.libraryVersion });
      }
      if (path === 'stats' && request.method === 'GET') {
        if (!owner) return sendJson(response, 403, { error: 'MINI_OWNER_ONLY' });
        const since = url.searchParams.get('since');
        return sendJson(response, 200, miniStats(parts.library, since && /^\d{4}-\d{2}-\d{2}/u.test(since) ? since : undefined));
      }
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch {
      return sendJson(response, 503, { error: 'MINI_UNAVAILABLE' });
    }
  };
}
