import { createMinecraftTaskBody } from '../surfaces/minecraft/minecraftReflexAdapter.js';
import { configuredFcaMinecraft } from './fcaBodyWiring.js';
import { fcaMinecraftTools, combineFcaTools } from './fcaMinecraftTools.js';
import { fcaMinecraftRequests } from './fcaMinecraftRequests.js';
import { createFcaTouchWiring } from './fcaTouchWiring.js';
import { underWriteLock } from '../infra/sqlite/lockWaits.js';
import { JevTouchSelector } from '../mind/action/reflex/fcaTouchPorts.js';
import type { MinecraftBodyConfiguration } from '../contracts/minecraftBodyContract.js';
import { createFcaSharedWiring } from './fcaSharedWiring.js';
import { connectFcaMemoryTools } from './fcaMemoryWiring.js';
import { createFcaVoiceBridge } from '../mind/action/fca/fcaVoicePorts.js';
import type { FcaAffectWriter } from '../mind/emotion/emotionPorts.js';
import type { MemoryProposals } from '../mind/memory/memoryPorts.js';
import type { TurnMemoryRecall } from '../mind/recall/turnMemoryRecall.js';
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

/** Explicit opt-in: owner tasks plus existing foreground text/voice binding; own-time keeps its current path. */
export function configuredServerFca(values: Readonly<Record<string, string | undefined>>, parts: {
  path: string; ownerScope: string; ownerAlone(): boolean; usage: LlmUsageStore;
  state?: Pick<CompanionStateStore, 'snapshot'>; conversations?: ConversationStore; tools?: ShannonToolRunner;
  affect?: FcaAffectWriter; memory?: MemoryProposals | null; enrich?: TurnMemoryRecall | null;
  minecraftConfiguration?: MinecraftBodyConfiguration | null; touchAllowed?(scope: string, device: string, gesture?: string): boolean;
  trace?: DecisionTraceWriter | null; traceSalt?: string;
  readSources?: Omit<FcaReadSourcesOptions, 'ownerScope' | 'ownerAlone' | 'state' | 'conversations'>;
}) {
  const readSourceVisible = parts.state && parts.conversations ? createFcaReadSources({ ...parts.readSources, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone, state: parts.state, conversations: parts.conversations }) : undefined;
  if (parts.conversations) parts.conversations.readSourceVisible = readSourceVisible;
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
    const minecraft = configuredFcaMinecraft(values, { ...parts, db, configuration: parts.minecraftConfiguration, jev });
    let shared: ReturnType<typeof createFcaSharedWiring> | undefined;
    let visible: ReturnType<typeof createFcaSourceGuard> | undefined;
    const runtime = createTaskRuntimeWiring({ db, actions, model,
      scopeKey: parts.ownerScope, ownerAlone: parts.ownerAlone,
      canRunTask: (_runtime, id) => visible?.(parts.ownerScope, id) ?? _runtime.taskSources(parts.ownerScope, id).length === 0, stepPorts: (_runtime, step) => {
        const body = minecraft ? createMinecraftTaskBody({ ...minecraft, evidence: shared?.evidence, runtime: _runtime, step, ownerAlone: parts.ownerAlone, sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? false }) : null;
        return ({ selector, ...(body ? { body: body.body, safeToAcknowledgeStop: body.safeToAcknowledgeStop } : {}), ...(shared ? { recall: shared.recall, evidence: shared.evidence, observeMemory: (ids: readonly string[]) => shared!.observeMemory(step, ids) } : {}),
        sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? []) ?? step.snapshot.sources.length === 0,
        taskVisible: id => id === step.taskId ? visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? []) ?? step.snapshot.sources.length === 0 : visible?.(step.scopeKey, id) ?? _runtime.taskSources(step.scopeKey, id).length === 0,
        observeTasks: ids => { if (!_runtime.inheritTaskSources(step, ids)) return false; step.snapshot.sources = _runtime.taskSources(step.scopeKey, step.taskId, step.messageIds); return true; },
        history: { codec: anthropicFcaHistoryCodec, summarizer },
        ...(parts.tools && parts.state && parts.conversations ? { tools: combineFcaTools(fcaResearchTools({ tools: parts.tools,
          state: parts.state, conversations: parts.conversations, ...(shared ? { observeMemory: (ids: readonly string[]) => shared!.observeMemory(step, ids) } : {}), scopeKey: step.scopeKey, ownerAlone: parts.ownerAlone, sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? step.snapshot.sources.length === 0 }), ...(minecraft ? [fcaMinecraftTools({ control: minecraft.control, step, ownerAlone: parts.ownerAlone, sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? false }), ...(body ? [body.tools] : [])] : [])) } : {}),
      }); } });
    visible = parts.state && parts.conversations ? createFcaSourceGuard({ runtime: runtime.runtime, state: parts.state,
      conversations: parts.conversations, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone,
      readSourceVisible }) : undefined;
    const conversation = visible ? createFcaConversationBridge({ runtime: runtime.runtime, ownerScope: parts.ownerScope, visible, selector }) : null;
    if (visible && parts.state && parts.conversations && readSourceVisible) shared = createFcaSharedWiring({ ...parts, db, runtime: runtime.runtime, state: parts.state, conversations: parts.conversations, visible, readSourceVisible });
    if (conversation && shared && parts.tools) connectFcaMemoryTools({ tools: parts.tools, memory: shared.memory, conversation, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone });
    const voice = conversation && parts.conversations ? createFcaVoiceBridge({ conversation, runtime: runtime.runtime, conversations: parts.conversations, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone }) : null;
    if (conversation && parts.tools) parts.tools.useTaskRuntime({ available: scope => conversation.taskToolsAvailable(scope),
      execute: (name, input, context) => conversation.executeTaskTool(name, input, context),
      observeRead: (scope, receipt) => conversation.observeRead(scope, receipt) });
    const sourceVisible = (scope: string, id: string) => Boolean(shared?.memory.read(scope, [id], { kind: 'owner' }).length);
    const touch = values.SHANNON_FCA_TOUCH === 'on' ? (() => {
      if (!jev || !parts.touchAllowed || !shared) throw new Error('FCA_TOUCH_REQUIRES_BODY_JEV_MEMORY');
      return createFcaTouchWiring({ db, runtime: runtime.runtime, actions, selector: new JevTouchSelector(jev), ownerScope: parts.ownerScope,
        allowed: parts.touchAllowed, sourceVisible, threadId: scope => parts.conversations?.threadId(scope) ?? null });
    })() : null;
    const requests = minecraft && conversation && visible ? fcaMinecraftRequests({ ...parts, control: minecraft.control,
      runtime: runtime.runtime, conversation, visible, stop: runtime.stop, sourceVisible: id => sourceVisible(parts.ownerScope, id),
      atomic: work => underWriteLock(db, null, '', work, 'fca_minecraft_admission') }) : null;
    if (minecraft && !requests) throw new Error('FCA_MINECRAFT_REQUIRES_CONVERSATION');
    if (requests && parts.tools) parts.tools.useMinecraftTasks(requests.tools);
    const wake = () => { void touch?.tick().catch(() => {}); if (!parts.ownerAlone()) void shared?.recall.cancelAll(); try { shared?.evidence?.flush(); } catch { /* Durable evidence remains for retry. */ } void runtime.tick().catch(() => {}); };
    const timer = setInterval(wake, 1000); timer.unref();
    const route = createFcaTaskRoute({ runtime: runtime.runtime, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone, stop: runtime.stop, wake, visible: id => visible?.(parts.ownerScope, id) ?? runtime.runtime.taskSources(parts.ownerScope, id).length === 0 });
    return { route, conversation, voice, touch, minecraft: minecraft && requests ? { control: minecraft.control, intent: requests.intent } : null, async stopActions(target: string | null) {
      if (target === null) { await runtime.stop(runtime.runtime.ensureRoot(parts.ownerScope).id, 'owner_stop_all'); return; }
      const action = await actions.get(parts.ownerScope, target);
      const taskId = action?.kind === 'agentTask' ? /^fca:([^:]+):[0-9]+$/.exec(action.sourceId)?.[1] : null;
      if (taskId) await runtime.stop(taskId, 'owner_stop');
    }, async close() { clearInterval(timer); await Promise.all([runtime.close(), shared?.recall.cancelAll(), touch?.close()]); client.close(); db.close(); } };
  } catch (error) { client.close(); db.close(); throw error; }
}
export async function serveFcaTaskRoute(service: ReturnType<typeof configuredServerFca>, request: IncomingMessage,
  response: ServerResponse, principal: { scopeKey: string } | null, url: URL): Promise<boolean> {
  if (url.pathname !== FCA_TASK_PATH) return false;
  if (!service) sendJson(response, 503, { error: 'FCA_NOT_ENABLED' });
  else await service.route(request, response, principal, url);
  return true;
}
