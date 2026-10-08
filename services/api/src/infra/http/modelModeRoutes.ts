import type { IncomingMessage, ServerResponse } from 'node:http';
import { ModelModeError, type ModelModePort } from '../../contracts/modelModeContract.js';
import { readJson, sendJson } from './serverHttp.js';

export const MODEL_MODE_PATH = '/v1/model-mode';
/** Only the authenticated owner principal supplies scope; neither query nor body grants another scope. */
export function createModelModeRoute(parts: { modes: ModelModePort; ownerScopeKey: string }) {
  return async (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null): Promise<void> => {
    if (!principal || principal.scopeKey !== parts.ownerScopeKey) return sendJson(response, 403, { error: 'MODEL_MODE_OWNER_ONLY' });
    if (request.method !== 'GET' && request.method !== 'PUT') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    try {
      if (request.method === 'GET') return sendJson(response, 200, parts.modes.snapshot(principal.scopeKey));
      let body: unknown;
      try { body = await readJson(request, 2048); }
      catch { return sendJson(response, 400, { error: 'MODEL_MODE_INVALID' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(response, 400, { error: 'MODEL_MODE_INVALID' });
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some(key => !['mode', 'expectedRevision', 'scopeKey'].includes(key))
        || input.scopeKey !== undefined && input.scopeKey !== principal.scopeKey
        || (input.mode !== 'haiku' && input.mode !== 'sonnet')
        || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) return sendJson(response, 400, { error: 'MODEL_MODE_INVALID' });
      return sendJson(response, 200, parts.modes.change(principal.scopeKey, Number(input.expectedRevision), input.mode as 'haiku' | 'sonnet'));
    } catch (error) {
      let current;
      try { current = parts.modes.snapshot(principal.scopeKey); } catch { /* A read failure is never a fabricated default. */ }
      return sendJson(response, error instanceof ModelModeError ? 409 : 503,
        { error: error instanceof ModelModeError ? error.code : 'MODEL_MODE_STORE_UNAVAILABLE', ...(current ? { current } : {}) });
    }
  };
}
