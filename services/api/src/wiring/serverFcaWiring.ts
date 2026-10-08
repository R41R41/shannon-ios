import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import { anthropicFcaHistoryCodec } from '../infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../infra/models/anthropic/anthropicFcaSummary.js';
import { createFcaReadSources, type FcaReadSourcesOptions } from './fcaReadSources.js';
import type { CompanionStateStore } from '@shannon/cognition';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { ShannonToolRunner } from '../mind/tools/toolRunnerPorts.js';
import { createFcaConversationBridge, createFcaSourceGuard } from '../mind/action/fca/fcaConversationPorts.js';
import { JevFcaToolSelector, type FcaToolSelector } from '../mind/selectors/selectorsPorts.js';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { configuredJevChooser } from './skillRoutingWiring.js';
import { fcaResearchTools } from './fcaResearchWiring.js';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { configuredResponseModel, replacementModel } from '../infra/models/anthropic/haikuConfig.js';
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
  state?: Pick<CompanionStateStore, 'snapshot'>; conversations?: ConversationStore; tools?: ShannonToolRunner;
  trace?: DecisionTraceWriter | null; traceSalt?: string;
  readSources?: Omit<FcaReadSourcesOptions, 'ownerScope' | 'ownerAlone' | 'state' | 'conversations'>;
}) {
  if (values.SHANNON_FCA_RUNTIME !== 'on') return null;
  if (!stage4Enabled(values)) throw new Error('FCA_ACTION_THREADS_REQUIRED');
  const modelName = replacementModel(values.SHANNON_FCA_MODEL);
  const nativeKey = modelName === 'claude-sonnet-5-5' ? anthropicApiKey(values) : null;
  const provider = modelName === 'claude-sonnet-5-5' ? nativeKey ? { model: modelName, apiKey: nativeKey } : null : configuredResponseModel(values, 'SHANNON_FCA_MODEL');
  if (!provider) throw new Error('FCA_PROVIDER_REQUIRED');
  const db = new DatabaseSync(parts.path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const client = new MindSocketClient(mindSocketPath(values, parts.path));
  try {
    const recordUsage: Parameters<typeof createAnthropicFcaModel>[0]['recordUsage'] = usage => {
      parts.usage.recordLlmUsage({ scopeKey: parts.ownerScope, lane: 'chat', model: usage.model,
        inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens, estimatedCostUsd: usage.estimatedCostUsd, occurredAt: new Date().toISOString() });
    };
    const model = createAnthropicFcaModel({ ...provider, recordUsage });
    const summarizer = createAnthropicFcaSummarizer({ ...provider, recordUsage });
    const actions = actionThreadsClient(client.call);
    const jev = configuredJevChooser(values, { trace: parts.trace ?? null, salt: parts.traceSalt });
    const selector: FcaToolSelector = jev ? new JevFcaToolSelector(jev) : { async select(request) { request.signal.throwIfAborted(); return { names: request.tools.map(tool => tool.name), source: 'fallback' }; } };
    let visible: ReturnType<typeof createFcaSourceGuard> | undefined;
    const runtime = createTaskRuntimeWiring({ db, actions, model,
      scopeKey: parts.ownerScope, ownerAlone: parts.ownerAlone,
      canRunTask: (_runtime, id) => visible?.(parts.ownerScope, id) ?? _runtime.taskSources(parts.ownerScope, id).length === 0, stepPorts: (_runtime, step) => ({ selector,
        sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? []) ?? step.snapshot.sources.length === 0,
        taskVisible: id => id === step.taskId ? visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? []) ?? step.snapshot.sources.length === 0 : visible?.(step.scopeKey, id) ?? _runtime.taskSources(step.scopeKey, id).length === 0,
        observeTasks: ids => { if (!_runtime.inheritTaskSources(step, ids)) return false; step.snapshot.sources = _runtime.taskSources(step.scopeKey, step.taskId, step.messageIds); return true; },
        history: { codec: anthropicFcaHistoryCodec, summarizer },
        ...(parts.tools && parts.state && parts.conversations ? { tools: fcaResearchTools({ tools: parts.tools,
          state: parts.state, conversations: parts.conversations, scopeKey: step.scopeKey, ownerAlone: parts.ownerAlone, sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? step.snapshot.sources.length === 0 }) } : {}),
      }) });
    visible = parts.state && parts.conversations ? createFcaSourceGuard({ runtime: runtime.runtime, state: parts.state,
      conversations: parts.conversations, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone,
      readSourceVisible: createFcaReadSources({ ...parts.readSources, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone,
        state: parts.state, conversations: parts.conversations }) }) : undefined;
    const conversation = visible ? createFcaConversationBridge({ runtime: runtime.runtime, ownerScope: parts.ownerScope, visible, selector }) : null;
    if (conversation && parts.tools) parts.tools.useTaskRuntime({ available: scope => conversation.taskToolsAvailable(scope),
      execute: (name, input, context) => conversation.executeTaskTool(name, input, context),
      observeRead: (scope, receipt) => conversation.observeRead(scope, receipt) });
    const wake = () => { void runtime.tick().catch(() => {}); };
    const timer = setInterval(wake, 1000); timer.unref();
    const route = createFcaTaskRoute({ runtime: runtime.runtime, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone, stop: runtime.stop, wake, visible: id => visible?.(parts.ownerScope, id) ?? runtime.runtime.taskSources(parts.ownerScope, id).length === 0 });
    return { route, conversation, async stopActions(target: string | null) {
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
