import { fcaReportWiring } from './fcaReportWiring.js';
import { timedTick } from '../infra/observer/eventLoopWatch.js';
import { minecraftGoalBinding } from './fcaMinecraftGoalBinding.js';
import { createFcaProgressTools } from '../mind/action/fca/fcaProgressTools.js';
import { createFcaTaskObservationMonitor } from './fcaTaskObservationWiring.js';
import { actionPermit, currentActionExecution } from '../infra/context/actionExecution.js';
import { createFcaSleepWiring } from './fcaSleepWiring.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { createMinecraftTaskBody } from '../surfaces/minecraft/minecraftReflexAdapter.js';
import { configuredFcaMinecraft } from './fcaBodyWiring.js';
import { fcaMinecraftTools, combineFcaTools } from './fcaMinecraftTools.js';
import { admittedMinecraftRequest, fcaMinecraftRequests } from './fcaMinecraftRequests.js';
import { createFcaTouchWiring } from './fcaTouchWiring.js';
import { touchSourcesVisible } from './fcaTouchSources.js';
import { underWriteLock } from '../infra/sqlite/lockWaits.js';
import { JevTouchSelector } from '../mind/action/reflex/fcaTouchPorts.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
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
import { ownTimeBudgetPort, ownTimeStepPorts, ownTimeTaskAllowed, type OwnTimeFcaParts } from './fcaOwnTimeWiring.js';
import { fcaBudget } from './fcaBudgetWiring.js';
import { TaskBudgetStore } from '../mind/action/taskRuntime/store/taskBudgetStore.js';
import { fcaReadReceiptSources } from '../mind/action/fca/fcaConversationSources.js';
import { configureDatabase, openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { switchOn } from '@shannon/switches';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { configuredResponseModel, isHaikuModel, replacementModel } from '../infra/models/anthropic/haikuConfig.js';
import { createAnthropicFcaModel } from '../infra/models/anthropic/anthropicFcaModel.js';
import { fcaCompactAboveTokens } from '../infra/models/anthropic/anthropicFcaCompaction.js';
import { fcaSegmentStaleMinutes } from '../mind/action/fca/store/fcaEvidenceSegments.js';
import { stage4Enabled, mindSocketPath } from '../infra/config/stage4.js';
import { MindSocketClient } from '../infra/ipc/mindSocket.js';
import { createFcaTaskRoute, FCA_TASK_PATH } from '../infra/http/fcaTaskRoutes.js';
import { sendJson } from '../infra/http/serverHttp.js';
import { actionThreadsClient } from './actionThreadsWiring.js';
import { createTaskRuntimeWiring } from './taskRuntimeWiring.js';
import { ActionLeaseReader, fcaTaskIdOf } from '../mind/action/threads/store/actionLeaseReader.js';
import { createSpokenReports, progressWithSpokenReports } from '../mind/action/fca/fcaSpokenReport.js';
import { createConfiguredSpokenReportModel } from '../infra/models/spokenReportModel.js';
import { ownerLocalClock, ownerTimeZone } from '../infra/time/localDate.js';
import { configuredOperatorAudit, operatorRequester, startOperatorMinecraft, type OperatorHostParts } from './operatorServerWiring.js';

/** Explicit opt-in: owner tasks plus existing foreground text/voice binding; own-time keeps its current path. */
export function configuredServerFca(values: Readonly<Record<string, string | undefined>>, parts: {
  path: string; ownerScope: string; ownerAlone(): boolean; now?(): string; usage: LlmUsageStore; sleepStore?: SQLiteShannonStore;
  state?: Pick<CompanionStateStore, 'snapshot'>; conversations?: ConversationStore; tools?: ShannonToolRunner;
  affect?: FcaAffectWriter; memory?: MemoryProposals | null; enrich?: TurnMemoryRecall | null;
  minecraftLifecycle?: MinecraftLifecycle | null; minecraftConfiguration?: MinecraftBodyConfiguration | null; touchAllowed?(scope: string, device: string, gesture?: string): boolean;
  trace?: DecisionTraceWriter | null; traceSalt?: string;
  readSources?: Omit<FcaReadSourcesOptions, 'ownerScope' | 'ownerAlone' | 'state' | 'conversations'>;
  /** Her own time's store and settings: own-time tasks and their budget (ADR-0009 stage 2, E3/E4); absent, none run. */
  ownTime?: OwnTimeFcaParts;
  /** The operator's Minecraft path (`docs/operator-minecraft-contract.md`): its audit, socket and time limits; absent, none. */
  operator?: OperatorHostParts;
}) {
  const readSourceVisible = parts.state && parts.conversations ? createFcaReadSources({ ...parts.readSources, ...(parts.now ? { now: parts.now } : {}), ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone, state: parts.state, conversations: parts.conversations }) : undefined;
  if (parts.conversations) parts.conversations.readSourceVisible = readSourceVisible;
  // Syzygy ADR-0009 S9: the common runtime is always on (`SHANNON_FCA_RUNTIME` is retired). What it needs is checked here, at
  // start, and a missing part stops the API at once with what to set.
  if (!stage4Enabled(values)) throw new Error('FCA_ACTION_THREADS_REQUIRED: the common task runtime needs the mind worker; set SHANNON_ADR8_STAGE4=on');
  const modelName = replacementModel(values.SHANNON_FCA_MODEL);
  const nativeKey = modelName === 'claude-sonnet-5-5' ? anthropicApiKey(values) : null;
  const provider = modelName === 'claude-sonnet-5-5' ? nativeKey ? { model: modelName, apiKey: nativeKey } : null : configuredResponseModel(values, 'SHANNON_FCA_MODEL');
  if (!provider) throw new Error(`FCA_PROVIDER_REQUIRED: no key for the task model ${modelName}; set ${fcaKeyNames(modelName)}`);
  // Sleep always takes the common runtime (S9 retired `SHANNON_FCA_SLEEP`); the API hands its store, the worker its owner night.
  const sleepEnabled = Boolean(parts.sleepStore);
  const borrowed = sleepEnabled ? parts.sleepStore!.fcaDatabase() : null;
  const db = borrowed ? configureDatabase(borrowed, 'taskRuntime') : openDatabase(parts.path, 'taskRuntime');
  const client = new MindSocketClient(mindSocketPath(values, parts.path));
  let sleep: ReturnType<typeof createFcaSleepWiring> | null = null;
  const operatorAudit = parts.operator ? configuredOperatorAudit(values, parts.path) : null;
  try {
    sleep = sleepEnabled ? createFcaSleepWiring({ values, store: parts.sleepStore!, ownerScope: parts.ownerScope }) : null;
    const ownTimeBudget = parts.ownTime ? ownTimeBudgetPort(parts.ownTime, provider.model) : null;
    const budgetStore = new TaskBudgetStore(db);
    const budget = fcaBudget({ actions: actionThreadsClient(client.call), store: budgetStore, now: () => new Date().toISOString(), ownTime: ownTimeBudget,
      minecraftRequest: task => admittedMinecraftRequest(task, task.parentId ? runtime.runtime.get(task.scopeKey, task.parentId) : null,
        Boolean(minecraft?.control.store.body(task.id))), ...(operatorAudit ? { taskCapYen: (id: string) => operatorAudit.store.budgetYen(id) } : {}) });
    const recordUsage: Parameters<typeof createAnthropicFcaModel>[0]['recordUsage'] = usage => {
      budget.recordUsage(usage.estimatedCostUsd);
      parts.usage.recordLlmUsage({ scopeKey: parts.ownerScope, lane: 'chat', model: usage.model,
        inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens, estimatedCostUsd: usage.estimatedCostUsd, occurredAt: new Date().toISOString() });
    };
    const timeZone = ownerTimeZone(values);
    const model = createAnthropicFcaModel({ ...provider, recordUsage, clock: () => ({ localTime: ownerLocalClock(new Date(), timeZone), timeZone }),
      compactAboveTokens: fcaCompactAboveTokens(values.SHANNON_FCA_COMPACT_ABOVE_TOKENS) });
    const summarizer = createAnthropicFcaSummarizer({ ...provider, recordUsage });
    const actions = actionThreadsClient(client.call);
    const jev = configuredJevChooser(values, { trace: parts.trace ?? null, salt: parts.traceSalt });
    const selector: FcaToolSelector = jev ? new JevFcaToolSelector(jev) : { async select(request) { request.signal.throwIfAborted(); return { names: request.tools.map(tool => tool.name), source: 'fallback' }; } };
    const minecraft = configuredFcaMinecraft(values, { ...parts, db, configuration: parts.minecraftConfiguration, jev, actions });
    let shared: ReturnType<typeof createFcaSharedWiring> | undefined;
    let visible: ReturnType<typeof createFcaSourceGuard> | undefined;
    const runtime = createTaskRuntimeWiring({ db, actions, model,
      scopeKey: parts.ownerScope, ownerAlone: parts.ownerAlone, budget, ownTimeAllowed: ownTimeTaskAllowed(values, parts.ownTime, ownTimeBudget),
      ...(sleep ? { sleepTicket: sleep.jobs.ticket, maintenanceAllowed: sleep.jobs.allowed } : {}),
      canRunTask: (_runtime, id) => { const task = _runtime.get(parts.ownerScope, id); return task?.origin === 'own_time' ? _runtime.taskSources(parts.ownerScope, id).length === 0 : task?.kind === 'sleep' ? Boolean(sleep?.visible(_runtime, task)) : visible?.(parts.ownerScope, id) ?? _runtime.taskSources(parts.ownerScope, id).length === 0; }, stepPorts: (_runtime, step) => {
        if (step.snapshot.task.kind === 'sleep') { if (!sleep) throw new Error('FCA_SLEEP_DISABLED'); return sleep.step(_runtime, step); }
        const history = { codec: anthropicFcaHistoryCodec, summarizer };
        if (step.snapshot.task.origin === 'own_time') return ownTimeStepPorts(step, { ...parts, runtime: _runtime, selector, history });
        const body = minecraft ? createMinecraftTaskBody({ ...minecraft, evidence: shared?.evidence, runtime: _runtime, step, ownerAlone: parts.ownerAlone, sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? false }) : null;
        const sourcesVisible = () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? []) ?? step.snapshot.sources.length === 0;
        const taskVisible = (id: string) => id === step.taskId ? sourcesVisible() : visible?.(step.scopeKey, id) ?? _runtime.taskSources(step.scopeKey, id).length === 0;
        const observeTasks = (ids: readonly string[]) => { if (!_runtime.inheritTaskSources(step, ids)) return false; step.snapshot.sources = _runtime.taskSources(step.scopeKey, step.taskId, step.messageIds); return sourcesVisible(); };
        const permitProgress = async () => {
          await actionPermit();
          const active = currentActionExecution();
          if (!active || active.lease.id !== step.lease.id || !parts.ownerAlone() || !sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
          active.signal.throwIfAborted();
          if (_runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
        };
        const goalBodyId = minecraft?.control.store.body(step.taskId)
          ?? (minecraft?.control.available().length === 1 ? minecraft.control.available()[0] : null)
          ?? (parts.minecraftConfiguration?.servers.size === 1 ? `minecraft:${[...parts.minecraftConfiguration.servers.keys()][0]}` : 'minecraft:unbound');
        const binding = minecraftGoalBinding(step.snapshot.task, goalBodyId);
        const observations = [createFcaTaskObservationMonitor({ runtime: _runtime, step, allowed: parts.ownerAlone, sourcesVisible, taskVisible, observeTasks })];
        // The operator's CLI can only start and stop a request: nobody can answer a task it handed over (Minebot lane run 1).
        const waitCounterpart = () => operatorRequester(operatorAudit, parts.ownerScope)(step.snapshot.task) !== 'operator';
        return ({ selector, observations, waitCounterpart, ...(body ? { body: body.body } : {}), safeToAcknowledgeStop: () => body?.safeToAcknowledgeStop() !== false && parts.minecraftLifecycle?.safe(step.lease.id) !== false, ...(shared ? { recall: shared.recall, evidence: shared.evidence, observeMemory: (ids: readonly string[]) => shared!.observeMemory(step, ids) } : {}),
        sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? []) ?? step.snapshot.sources.length === 0,
        taskVisible: id => id === step.taskId ? visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? []) ?? step.snapshot.sources.length === 0 : visible?.(step.scopeKey, id) ?? _runtime.taskSources(step.scopeKey, id).length === 0,
        observeTasks: ids => { if (!_runtime.inheritTaskSources(step, ids)) return false; step.snapshot.sources = _runtime.taskSources(step.scopeKey, step.taskId, step.messageIds); return true; },
        history: { codec: anthropicFcaHistoryCodec, summarizer },
        ...(parts.tools && parts.state && parts.conversations ? { tools: createFcaProgressTools(combineFcaTools(fcaResearchTools({ tools: parts.tools,
          state: parts.state, conversations: parts.conversations, ...(shared ? { observeMemory: (ids: readonly string[]) => shared!.observeMemory(step, ids) } : {}),
          task: { id: step.taskId, origin: step.snapshot.task.origin, leaseId: step.lease.id },
          checkpoint: step.snapshot.checkpoint, placeSearch: _runtime.placeContext?.(step.scopeKey, step.taskId),
          observeRead: (operationId, receipt) => {
            const ids = fcaReadReceiptSources(receipt).readSourceIds ?? [];
            if (!ids.length) return true;
            const at = new Date().toISOString();
            if (!parts.ownerAlone() || ids.some(id => !readSourceVisible?.(step.scopeKey, id, at))) return false;
            if (!_runtime.observeSources(step, { observationId: `read:${operationId}`, recalledMemoryIds: [], readSourceIds: ids })) return false;
            step.snapshot.sources = _runtime.taskSources(step.scopeKey, step.taskId, step.messageIds);
            return visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? false;
          }, scopeKey: step.scopeKey, ownerAlone: parts.ownerAlone, sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? step.snapshot.sources.length === 0 }), ...(minecraft ? [fcaMinecraftTools({ control: minecraft.control, step, ownerAlone: parts.ownerAlone, sourcesVisible: () => visible?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources) ?? false }), ...(body ? [body.tools] : [])] : [])), { checkpoint: step.snapshot.checkpoint, binding, permit: permitProgress, observationSignal: (name, signal) => body?.body.toolSignal(name, signal) ?? signal }) } : { tools: createFcaProgressTools(combineFcaTools(), { checkpoint: step.snapshot.checkpoint, binding, permit: permitProgress, observationSignal: (name, signal) => body?.body.toolSignal(name, signal) ?? signal }) }),
      }); } });
    visible = parts.state && parts.conversations ? createFcaSourceGuard({ runtime: runtime.runtime, state: parts.state,
      conversations: parts.conversations, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone,
      readSourceVisible }) : undefined;
    if (visible && sleep) {
      const foregroundVisible = visible;
      visible = Object.assign((scope: string, id: string, pending?: string) => {
        const task = runtime.runtime.get(scope, id);
        return task?.kind === 'sleep' ? scope === parts.ownerScope && parts.ownerAlone() && sleep!.visible(runtime.runtime, task) : foregroundVisible(scope, id, pending);
      }, { sources: foregroundVisible.sources, progress: foregroundVisible.progress, content: foregroundVisible.content,
        // The evidence store's coverage and walk counts are the foreground guard's, as its `sources` (review of 5d492ae8).
        covers: foregroundVisible.covers, walks: foregroundVisible.walks });
    }
    const conversation = visible ? createFcaConversationBridge({ runtime: runtime.runtime, ownerScope: parts.ownerScope, visible, selector }) : null;
    if (visible && parts.state && parts.conversations && readSourceVisible) shared = createFcaSharedWiring({ ...parts, db, runtime: runtime.runtime, state: parts.state, conversations: parts.conversations, visible, readSourceVisible,
      segmentStaleMinutes: fcaSegmentStaleMinutes(values.SHANNON_FCA_SEGMENT_STALE_MINUTES) });
    if (conversation && shared && parts.tools) connectFcaMemoryTools({ tools: parts.tools, memory: shared.memory, conversation, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone });
    const voice = conversation && parts.conversations ? createFcaVoiceBridge({ conversation, runtime: runtime.runtime, conversations: parts.conversations, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone, ...(parts.now ? { now: parts.now } : {}) }) : null;
    if (conversation && parts.tools) parts.tools.useTaskRuntime({ available: scope => conversation.taskToolsAvailable(scope),
      execute: (name, input, context) => conversation.executeTaskTool(name, input, context),
      observeRead: (scope, receipt) => conversation.observeRead(scope, receipt) });
    const sourceVisible = (scope: string, id: string) => Boolean(shared?.memory.read(scope, [id], { kind: 'owner' }).length);
    const touch = switchOn(values, 'SHANNON_FCA_TOUCH') ? (() => {
      // `shared` exists only with the state and conversations (above); the last two checks only narrow their types.
      if (!jev || !parts.touchAllowed || !shared || !parts.state || !parts.conversations) throw new Error('FCA_TOUCH_REQUIRES_BODY_JEV_MEMORY');
      // One snapshot and withholding for all of a touch's sources (`fcaTouchSources.ts`, hotfix 2026-10-14).
      const sourcesVisible = touchSourcesVisible({ memory: shared.memory, state: parts.state, conversations: parts.conversations, readSourceVisible });
      return createFcaTouchWiring({ db, runtime: runtime.runtime, actions, selector: new JevTouchSelector(jev), ownerScope: parts.ownerScope,
        allowed: parts.touchAllowed, sourceVisible, sourcesVisible, threadId: scope => parts.conversations?.threadId(scope) ?? null });
    })() : null;
    const requests = minecraft && conversation && visible ? fcaMinecraftRequests({ ...parts, control: minecraft.control,
      runtime: runtime.runtime, conversation, visible, stop: runtime.stop, sourceVisible: id => sourceVisible(parts.ownerScope, id),
      atomic: work => underWriteLock(db, null, '', work, 'fca_minecraft_admission') }) : null;
    if (minecraft && !requests) throw new Error('FCA_MINECRAFT_REQUIRES_CONVERSATION');
    if (requests && parts.tools) parts.tools.useMinecraftTasks(requests.tools);
    const wake = () => { try { sleep?.jobs.reconcile(runtime.runtime); sleep?.jobs.admit(runtime.runtime); } catch { /* Atomic admission retries; unknown task outcomes remain held. */ } void touch?.tick().catch(() => {}); if (!parts.ownerAlone()) void shared?.recall.cancelAll(); try { shared?.evidence?.flush(); } catch { /* Durable evidence remains for retry. */ } void runtime.tick().catch(() => {}); };
    const timer = setInterval(() => timedTick('fca_wake', wake), 1000); timer.unref();
    const operator = parts.operator ? startOperatorMinecraft({ ...parts.operator, audit: operatorAudit, path: parts.path, scopeKey: parts.ownerScope,
      now: parts.now ?? (() => new Date().toISOString()), ownerAlone: parts.ownerAlone, log: line => console.log(line),
      requests: minecraft && requests ? { ...requests.operator, wake } : null, bodyRecheck: minecraft?.recheck ?? null }) : null;
    const spoken = createSpokenReports({ speaker: createConfiguredSpokenReportModel(values, parts.usage),
      localTime: () => ownerLocalClock(new Date(), timeZone), requester: operatorRequester(operatorAudit, parts.ownerScope),
      record: (scope, id, reportId, text) => runtime.runtime.recordSpokenReport?.(scope, id, reportId, text) ?? false });
    // Which report reaches him now (`fcaReportWiring.ts`): the card waits out quiet hours; neither repeats an answered request. Rich
    // chat (docs/rich-chat-contract.md): a finished piece of work he asked for leaves a report card in its Talk.
    const seen = progressWithSpokenReports(runtime.runtime, parts.ownerScope, id => visible?.progress?.(parts.ownerScope, id) ?? null, spoken,
      parts.ownerAlone);
    const reports = fcaReportWiring({ runtime: runtime.runtime, ownerScope: parts.ownerScope, timeZone, conversations: parts.conversations, seen,
      ownerAlone: parts.ownerAlone, log: line => console.warn(line), requester: operatorRequester(operatorAudit, parts.ownerScope) });
    const cardTimer = reports.cards
      ? setInterval((cards: { tick(): number }) => { timedTick('report_cards', () => cards.tick()); }, 5000, reports.cards).unref() : null;
    const route = createFcaTaskRoute({ runtime: runtime.runtime, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone, stop: runtime.stop, wake,
      visible: id => visible?.(parts.ownerScope, id) ?? runtime.runtime.taskSources(parts.ownerScope, id).length === 0,
      progress: reports.call, spokenReports: true });
    const lifecycleTask = (executionId: string) => {
      const taskId = new ActionLeaseReader(db).fcaTaskOf(executionId, parts.ownerScope);
      return taskId && visible?.(parts.ownerScope, taskId) ? runtime.runtime.taskSources(parts.ownerScope, taskId) : null;
    };
    const lifecycleSources = (executionId: string) => lifecycleTask(executionId)?.flatMap(source => [
      ...(source.experienceId ? [`experience:${source.experienceId}`] : []),
      ...source.recalledMemoryIds.map(id => `memory:${id}`), ...(source.readSourceIds ?? []).map(id => `read:${id}`),
    ]);
    return { route, conversation, voice, touch, reportCardVisible: (taskId: string) => { try { return visible?.(parts.ownerScope, taskId) === true; } catch { return false; } }, lifecycleTaskAllowed: (executionId: string) => lifecycleTask(executionId) !== null,
      lifecycleTaskSources: (executionId: string) => { const ids = lifecycleSources(executionId); return ids ? [...new Set(ids)].sort() : null; }, minecraft: minecraft && requests ? { control: minecraft.control, intent: requests.intent } : null, async stopActions(target: string | null) {
      if (target === null) { await runtime.stop(runtime.runtime.ensureRoot(parts.ownerScope).id, 'owner_stop_all'); return; }
      const action = await actions.get(parts.ownerScope, target);
      const taskId = action?.kind === 'agentTask' ? fcaTaskIdOf(action.sourceId) : null;
      if (taskId) await runtime.stop(taskId, 'owner_stop');
    }, async close() { await operator?.close(); await minecraft?.recheck?.close(); clearInterval(timer); if (cardTimer) clearInterval(cardTimer); await Promise.all([runtime.close(), shared?.recall.cancelAll(), touch?.close(), spoken.close()]); sleep?.close(); client.close(); if (!borrowed) db.close(); } };
  } catch (error) { operatorAudit?.close(); sleep?.close(); client.close(); if (!borrowed) db.close(); throw error; }
}
export async function serveFcaTaskRoute(service: ReturnType<typeof configuredServerFca>, request: IncomingMessage,
  response: ServerResponse, principal: { scopeKey: string } | null, url: URL): Promise<boolean> {
  if (url.pathname !== FCA_TASK_PATH) return false;
  if (!service) sendJson(response, 503, { error: 'FCA_NOT_ENABLED' });
  else await service.route(request, response, principal, url);
  return true;
}

/** The environment names that give the task model its key (names only, never a value). */
function fcaKeyNames(model: string): string {
  if (model === 'claude-sonnet-5-5') return 'SHANNON_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY';
  return isHaikuModel(model) ? 'SHANNON_HAIKU_API_KEY, SHANNON_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}
