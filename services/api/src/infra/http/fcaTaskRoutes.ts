import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TaskRuntime } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import { readJson, sendJson } from './serverHttp.js';
export const FCA_TASK_PATH = '/v1/fca/tasks';
export function createFcaTaskRoute(parts: {
  runtime: TaskRuntime; ownerScope: string; ownerAlone(): boolean;
  stop(id: string, reason: string): Promise<unknown>; wake(): void;
}) {
  return async (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null, url: URL) => {
    response.setHeader('cache-control', 'no-store');
    if (!principal || principal.scopeKey !== parts.ownerScope || !parts.ownerAlone()) return sendJson(response, 403, { error: 'FCA_OWNER_ALONE_REQUIRED' });
    const scope = principal.scopeKey;
    try {
      if (request.method === 'GET') {
        const id = url.searchParams.get('id');
        const value = id ? parts.runtime.get(scope, id) : parts.runtime.list(scope, { offset: Number(url.searchParams.get('offset') ?? 0), limit: 50 });
        return sendJson(response, value ? 200 : 404, value ?? { error: 'FCA_TASK_NOT_FOUND' });
      }
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      const input = await readJson(request, 16_384) as Record<string, unknown>;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('FCA_INPUT');
      const allowed = ['command', 'requestId', 'id', 'title', 'goal', 'completionCriteria', 'message'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('FCA_INPUT');
      const string = (key: string) => { const value = input[key]; if (typeof value !== 'string' || !value.trim()) throw new Error('FCA_INPUT'); return value; };
      // Recheck after asynchronous body read; caller-controlled audience/scope are never accepted.
      if (!parts.ownerAlone()) return sendJson(response, 403, { error: 'FCA_OWNER_ALONE_REQUIRED' });
      let result: unknown;
      switch (input.command) {
        case 'create': {
          const root = parts.runtime.ensureRoot(scope);
          result = parts.runtime.createChild(scope, root.id, { title: string('title'), goal: string('goal'), completionCriteria: string('completionCriteria') }, string('requestId'));
          break;
        }
        case 'send': {
          const root = parts.runtime.ensureRoot(scope);
          result = parts.runtime.send(scope, root.id, string('id'), string('message'), string('requestId')); break;
        }
        case 'stop': result = await parts.stop(string('id'), 'owner_request'); break;
        case 'resume': result = parts.runtime.resume(scope, string('id')); break;
        default: throw new Error('FCA_INPUT');
      }
      if (!parts.ownerAlone()) return sendJson(response, 403, { error: 'FCA_OWNER_ALONE_REQUIRED' });
      parts.wake();
      return sendJson(response, result ? 202 : 409, result ?? { error: 'FCA_NOT_RESUMABLE' });
    } catch (error) {
      const code = error instanceof Error && /^FCA_[A-Z_]+$/.test(error.message) ? error.message : 'FCA_UNAVAILABLE';
      return sendJson(response, code === 'FCA_UNAVAILABLE' ? 503 : 409, { error: code });
    }
  };
}
