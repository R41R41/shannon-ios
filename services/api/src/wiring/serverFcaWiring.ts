import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { configuredResponseModel } from '../infra/models/anthropic/haikuConfig.js';
import { createAnthropicFcaModel } from '../infra/models/anthropic/anthropicFcaModel.js';
import { stage4Enabled, mindSocketPath } from '../infra/config/stage4.js';
import { MindSocketClient } from '../infra/ipc/mindSocket.js';
import { createFcaTaskRoute, FCA_TASK_PATH } from '../infra/http/fcaTaskRoutes.js';
import { sendJson } from '../infra/http/serverHttp.js';
import { actionThreadsClient } from './actionThreadsWiring.js';
import { createTaskRuntimeWiring } from './taskRuntimeWiring.js';

/** First slice is explicit opt-in. It admits owner requests only; ordinary conversation and own-time stay on their current path. */
export function configuredServerFca(values: Readonly<Record<string, string | undefined>>, parts: {
  path: string; ownerScope: string; ownerAlone(): boolean; usage: LlmUsageStore;
}) {
  if (values.SHANNON_FCA_RUNTIME !== 'on') return null;
  if (!stage4Enabled(values)) throw new Error('FCA_ACTION_THREADS_REQUIRED');
  const provider = configuredResponseModel(values, 'SHANNON_FCA_MODEL');
  if (!provider) throw new Error('FCA_PROVIDER_REQUIRED');
  const db = new DatabaseSync(parts.path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const client = new MindSocketClient(mindSocketPath(values, parts.path));
  try {
    const model = createAnthropicFcaModel({ ...provider, recordUsage: usage => {
      parts.usage.recordLlmUsage({ scopeKey: parts.ownerScope, lane: 'chat', model: usage.model,
        inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens, estimatedCostUsd: usage.estimatedCostUsd, occurredAt: new Date().toISOString() });
    } });
    const actions = actionThreadsClient(client.call);
    const runtime = createTaskRuntimeWiring({ db, actions, model,
      scopeKey: parts.ownerScope, ownerAlone: parts.ownerAlone });
    const wake = () => { void runtime.tick().catch(() => {}); };
    const timer = setInterval(wake, 1000); timer.unref();
    const route = createFcaTaskRoute({ runtime: runtime.runtime, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone, stop: runtime.stop, wake });
    return { route, async stopActions(target: string | null) {
      if (target === null) { await runtime.stop(runtime.runtime.ensureRoot(parts.ownerScope).id, 'owner_stop_all'); return; }
      const action = await actions.get(parts.ownerScope, target);
      const taskId = action?.kind === 'agentTask' ? /^fca:([^:]+):[0-9]+$/.exec(action.sourceId)?.[1] : null;
      if (taskId) await runtime.stop(taskId, 'owner_stop');
    }, async close() { clearInterval(timer); await runtime.close(); client.close(); db.close(); } };
  } catch (error) { client.close(); db.close(); throw error; }
}
export async function serveFcaTaskRoute(service: ReturnType<typeof configuredServerFca>, request: IncomingMessage,
  response: ServerResponse, principal: { scopeKey: string } | null, url: URL): Promise<boolean> {
  if (url.pathname !== FCA_TASK_PATH) return false;
  if (!service) sendJson(response, 503, { error: 'FCA_NOT_ENABLED' });
  else await service.route(request, response, principal, url);
  return true;
}
