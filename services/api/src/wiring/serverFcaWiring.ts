import { fcaReportWiring } from './fcaReportWiring.js';
import { timedTick } from '../infra/observer/eventLoopWatch.js';
import { minecraftGoalBinding } from './fcaMinecraftGoalBinding.js';
import { createFcaProgressTools } from '../mind/action/fca/fcaProgressTools.js';
import { createFcaTaskObservationMonitor } from './fcaTaskObservationWiring.js';
import { actionPermit, currentActionExecution } from '../infra/context/actionExecution.js';
import { createFcaSleepWiring } from './fcaSleepWiring.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { createMinecraftTaskBody } from '../surfaces/minecraft/minecraftReflexAdapter.js';
import type { MinecraftLiveSink } from '../surfaces/minecraft/minecraftLive.js';
import { withMinecraftLive } from '../surfaces/minecraft/minecraftLiveBody.js';
import { withMinecraftWorking } from '../surfaces/minecraft/minecraftWorkingBody.js';
import { withMinecraftAgenda } from '../surfaces/minecraft/minecraftAgenda.js';
import { withMinecraftProgress } from '../surfaces/minecraft/minecraftProgress.js';
import { minecraftProcedureStepParts } from '../surfaces/minecraft/minecraftProcedureTool.js';
import { minecraftAgendaBodyParts, withMinecraftAgendaParts } from '../surfaces/minecraft/minecraftLookahead.js';
import { minecraftOpportunityJudge } from '../surfaces/minecraft/minecraftOpportunityJudge.js';
import { configuredFcaMinecraft } from './fcaBodyWiring.js';
import { fcaMinecraftTools, combineFcaTools } from './fcaMinecraftTools.js';
import { admittedMinecraftRequest, fcaMinecraftRequests, MINECRAFT_REQUEST_CRITERIA } from './fcaMinecraftRequests.js';
import { createFcaTouchWiring } from './fcaTouchWiring.js';
import { touchSourcesVisible } from './fcaTouchSources.js';
import { underWriteLock } from '../infra/sqlite/lockWaits.js';
import { JevTouchSelector } from '../mind/action/reflex/fcaTouchPorts.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import type { MinecraftBodyConfiguration } from '../contracts/minecraftBodyContract.js';
import { createFcaSharedWiring } from './fcaSharedWiring.js';
import { connectFcaMemoryTools } from './fcaMemoryWiring.js';
import { createFcaVoiceBridge } from '../mind/action/fca/fcaVoicePorts.js';
import { fcaObsMode } from '../mind/action/fca/fcaCoreTools.js';
import type { FcaAffectWriter } from '../mind/emotion/emotionPorts.js';
import type { MemoryProposals } from '../mind/memory/memoryPorts.js';
import type { TurnMemoryRecall } from '../mind/recall/turnMemoryRecall.js';
import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import { minecraftRoutePlannerPart } from './minecraftRouteWiring.js';
import { anthropicFcaHistoryCodec } from '../infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../infra/models/anthropic/anthropicFcaSummary.js';
import { configuredFcaSummaries } from './fcaSummaryWiring.js';
import { createFcaReadSources, type FcaReadSourcesOptions } from './fcaReadSources.js';
import type { CompanionStateStore } from '@shannon/cognition';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { ShannonToolRunner } from '../mind/tools/toolRunnerPorts.js';
import { createFcaConversationBridge, createFcaSourceGuard, type FcaWalkCaller } from '../mind/action/fca/fcaConversationPorts.js';
import { JevFcaToolSelector, type FcaToolSelector } from '../mind/selectors/selectorsPorts.js';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { configuredJevChooser } from './skillRoutingWiring.js';
import { fcaResearchTools } from './fcaResearchWiring.js';
import { withSkillOutcomes } from './fcaSkillOutcomes.js';
import { bodySkillGists, stepReadObserver } from './fcaSkillGists.js';
import type { SkillMemory } from '../mind/memory/memoryPorts.js';
import type { SkillTurnPorts } from '../contracts/skillMemoryContract.js';
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
import { skillNamesOfIndex } from '../surfaces/minecraft/minecraftSkillPointers.js';
import { fcaSegmentStaleMinutes } from '../mind/action/fca/store/fcaEvidenceSegments.js';
import { stage4Enabled, mindSocketPath } from '../infra/config/stage4.js';
import { MindSocketClient } from '../infra/ipc/mindSocket.js';
import { createFcaTaskRoute, FCA_TASK_PATH } from '../infra/http/fcaTaskRoutes.js';
import { sendJson } from '../infra/http/serverHttp.js';
import { actionThreadsClient } from './actionThreadsWiring.js';
import { createTaskRuntimeWiring } from './taskRuntimeWiring.js';
import { createFcaBodyRecovery, fcaBodyReturnWindow } from './fcaBodyRecovery.js';
import { stepVisibility, taskGates } from './fcaPeekGates.js';
import { ActionLeaseReader, fcaTaskIdOf } from '../mind/action/threads/store/actionLeaseReader.js';
import { createSpokenReports, progressWithSpokenReports } from '../mind/action/fca/fcaSpokenReport.js';
import { createConfiguredSpokenReportModel } from '../infra/models/spokenReportModel.js';
import { ownerLocalClock, ownerTimeZone } from '../infra/time/localDate.js';
import { configuredOperatorAudit, operatorRequester, operatorTalkNotes, startOperatorMinecraft, type OperatorHostParts } from './operatorServerWiring.js';

/** Explicit opt-in: owner tasks plus existing foreground text/voice binding; own-time keeps its current path. */
/** How long an FCA decision already sent may finish after its step is stopped (`stopGraceMilliseconds`, Minecraft run 10). */
export const FCA_MODEL_STOP_GRACE_MILLISECONDS = 20_000;

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
  /** Her skill memory while `SHANNON_SKILLS` is on: a Minecraft task's `skill.read` becomes a use its outcome settles. */
  skills?: Pick<SkillMemory, 'usedInTask' | 'settleTask'> | null;
  /** `skill.read`'s own port (`SkillTurnPorts.open`): a body task's pointed skills, for their gists (`SHANNON_FCA_SKILL_GIST`). */
  skillOpen?: SkillTurnPorts['open'];
  /** SHANNON_MINECRAFT_LIVE (session dc-live): told what task a Minecraft body is on, for the conversations' view of it. */
  live?: MinecraftLiveSink;
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
      // A charge nobody confirmed (a lost request, an answer without usable usage) is an upper bound: booked apart (`fcaBudgetWiring.ts`).
      budget.recordUsage(usage.estimatedCostUsd, !usage.usageComplete);
      parts.usage.recordLlmUsage({ scopeKey: parts.ownerScope, lane: 'chat', model: usage.model,
        inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens, estimatedCostUsd: usage.estimatedCostUsd, occurredAt: new Date().toISOString() });
    };
    const timeZone = ownerTimeZone(values);
    const model = createAnthropicFcaModel({ ...provider, recordUsage, clock: () => ({ localTime: ownerLocalClock(new Date(), timeZone), timeZone }),
      compactAboveTokens: fcaCompactAboveTokens(values.SHANNON_FCA_COMPACT_ABOVE_TOKENS), stopGraceMilliseconds: FCA_MODEL_STOP_GRACE_MILLISECONDS });
    // SHANNON_FCA_SUMMARY_MODEL=haiku (P4): a body task's summaries by Haiku, rare; absent, every task is as it was.
    const summaries = configuredFcaSummaries(values, createAnthropicFcaSummarizer({ ...provider, recordUsage }), recordUsage);
    const actions = actionThreadsClient(client.call);
    const jev = configuredJevChooser(values, { trace: parts.trace ?? null, salt: parts.traceSalt });
    const selector: FcaToolSelector = jev ? new JevFcaToolSelector(jev) : { async select(request) { request.signal.throwIfAborted(); return { names: request.tools.map(tool => tool.name), source: 'catalog' }; } };
    // A Minecraft task's skill reads, settled by what the task then does (`fcaSkillOutcomes.ts`).
    // SHANNON_MINECRAFT_AGENDA (mb-arch): the next decision asked while the body works, and the executor around its tools.
    const minecraft = withMinecraftAgendaParts(withSkillOutcomes(
      configuredFcaMinecraft(values, { ...parts, db, configuration: parts.minecraftConfiguration, jev, actions }),
      parts.skills, parts.now), switchOn(values, 'SHANNON_MINECRAFT_AGENDA'));
    let shared: ReturnType<typeof createFcaSharedWiring> | undefined;
    let visible: ReturnType<typeof createFcaSourceGuard> | undefined;
    // Owner decision 2026-10-15: a body task inherits only the asking conversation, and step records keep sources by reference.
    const runtime = createTaskRuntimeWiring({ db, actions, model, provenanceRefs: switchOn(values, 'SHANNON_FCA_PROVENANCE_REFS'), continueAtOnce: true,
      scopeKey: parts.ownerScope, ownerAlone: parts.ownerAlone, budget, ownTimeAllowed: ownTimeTaskAllowed(values, parts.ownTime, ownTimeBudget),
      // A Minecraft request left unknown (a restart, a lost answer) goes on once its body has proven its release (`fcaBodyRecovery.ts`).
      ...(minecraft ? { bodyRecovery: recoveryParts => createFcaBodyRecovery({ ...recoveryParts,
        windowMs: fcaBodyReturnWindow(values.SHANNON_FCA_BODY_RETURN_MINUTES),
        body: { bound: id => minecraft.control.store.body(id), connected: id => minecraft.control.frame(id) !== null,
          release: step => minecraft.recheck.releaseStep(step) } }) } : {}),
      ...(sleep ? { sleepTicket: sleep.jobs.ticket, maintenanceAllowed: sleep.jobs.allowed } : {}),
      ...taskGates({ ownerScope: parts.ownerScope, guard: () => visible, sleepVisible: (rt, task) => Boolean(sleep?.visible(rt, task)) }),
      stepPorts: (_runtime, step) => {
        if (step.snapshot.task.kind === 'sleep') { if (!sleep) throw new Error('FCA_SLEEP_DISABLED'); return sleep.step(_runtime, step); }
        const history = { codec: anthropicFcaHistoryCodec, summarizer: summaries.decision };
        if (step.snapshot.task.origin === 'own_time') return ownTimeStepPorts(step, { ...parts, runtime: _runtime, selector, history });
        // Her readable skills for the body's situational pointers (`minecraftSkillPointers.ts`): only while `skill.read` is offered.
        const skillNames = () => parts.tools?.offered('text', 'owner_alone', step.scopeKey).some(tool => tool.name === 'skill.read')
          ? skillNamesOfIndex(parts.tools.skillIndex(step.scopeKey)) : new Set<string>();
        // `check.whole` names its caller for the slow-walk line; `check.peek` is the observation monitor's, which walks nothing (`fcaPeekGates.ts`).
        const check = stepVisibility(() => visible, step);
        // SHANNON_MINECRAFT_WORKING_EVENTS (mb-arch stage 1): what the body tells while it works can cut a stalled command (`minecraftWorkingBody.ts`).
        const body = minecraft ? withMinecraftWorking(createMinecraftTaskBody({ ...minecraft, evidence: shared?.evidence, runtime: _runtime, step, ownerAlone: parts.ownerAlone, skillNames,
          // SHANNON_FCA_SKILL_GIST (owner 2026-10-15): each pointer with its skill's first steps, pinned as a read (`fcaSkillGists.ts`).
          ...(switchOn(values, 'SHANNON_FCA_SKILL_GIST') ? bodySkillGists(step, parts.skillOpen,
            fcaStepReads({ step, runtime: _runtime, ownerAlone: parts.ownerAlone, readSourceVisible, visible: () => visible }),
            minecraft.skillOutcomes) : {}),
          fastJudgment: switchOn(values, 'SHANNON_MINECRAFT_FAST_JUDGMENT'),
          // Owner 2026-10-20: her route to the Nether from a strong model, charged as a decision is (`minecraftRouteWiring.ts`).
          ...minecraftRoutePlannerPart(values, recordUsage),
          sourcesVisible: () => check.whole('body') ?? false }),
          { on: minecraft.agenda.on || switchOn(values, 'SHANNON_MINECRAFT_WORKING_EVENTS'), control: minecraft.control, runtime: _runtime, step,
            ...(minecraft.agenda.on
              ? minecraftAgendaBodyParts(step.taskId, () => minecraft.control.observe(minecraft.control.store.body(step.taskId) ?? '')) : {}) }) : null;
        const sourcesVisible = () => check.whole('step') ?? step.snapshot.sources.length === 0;
        const taskVisible = (id: string) => id === step.taskId ? sourcesVisible() : visible?.(step.scopeKey, id, undefined, 'child_monitor') ?? _runtime.taskSources(step.scopeKey, id).length === 0;
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
        const observations = [createFcaTaskObservationMonitor({ runtime: _runtime, step, allowed: parts.ownerAlone, sourcesVisible: check.peek, taskVisible, observeTasks })];
        // The operator's CLI can only start and stop a request: nobody can answer a task it handed over (Minebot lane run 1).
        const waitCounterpart = () => operatorRequester(operatorAudit, parts.ownerScope)(step.snapshot.task) !== 'operator';
        // A body task (review of 0efd5acb): its body bound to it, or made from a Minecraft request; never any other task.
        const keepBodyTools = () => Boolean(minecraft && (minecraft.control.store.body(step.taskId)
          || step.snapshot.task.completionCriteria === MINECRAFT_REQUEST_CRITERIA));
        return ({ ...(minecraft?.agenda.lookahead && keepBodyTools() ? { lookahead: minecraft.agenda.lookahead } : {}), selector, observations, waitCounterpart, keepBodyTools, obsMode: fcaObsMode(values.SHANNON_FCA_OBS_MODE), ...(body ? { body: withMinecraftLive(body, { live: parts.live, control: minecraft!.control, step }).body } : {}), safeToAcknowledgeStop: () => body?.safeToAcknowledgeStop() !== false && parts.minecraftLifecycle?.safe(step.lease.id) !== false, ...(shared ? { recall: shared.recall, bodyRecall: shared.bodyRecall, evidence: shared.evidence, observeMemory: (ids: readonly string[]) => shared!.observeMemory(step, ids) } : {}),
        sourcesVisible,
        taskVisible: id => id === step.taskId ? sourcesVisible() : visible?.(step.scopeKey, id, undefined, 'child') ?? _runtime.taskSources(step.scopeKey, id).length === 0,
        observeTasks: ids => { if (!_runtime.inheritTaskSources(step, ids)) return false; step.snapshot.sources = _runtime.taskSources(step.scopeKey, step.taskId, step.messageIds); return true; },
        history: { codec: anthropicFcaHistoryCodec, ...(keepBodyTools() ? summaries.body : { summarizer: summaries.decision }) },
        ...(parts.tools && parts.state && parts.conversations ? { tools: createFcaProgressTools(combineFcaTools(fcaResearchTools({ tools: parts.tools,
          state: parts.state, conversations: parts.conversations, ...(shared ? { observeMemory: (ids: readonly string[]) => shared!.observeMemory(step, ids) } : {}),
          task: { id: step.taskId, origin: step.snapshot.task.origin, leaseId: step.lease.id },
          checkpoint: step.snapshot.checkpoint, placeSearch: _runtime.placeContext?.(step.scopeKey, step.taskId),
          observeRead: fcaStepReads({ step, runtime: _runtime, ownerAlone: parts.ownerAlone, readSourceVisible, visible: () => visible }),
          scopeKey: step.scopeKey, ownerAlone: parts.ownerAlone,
          sourcesVisible: () => check.whole('tool') ?? step.snapshot.sources.length === 0,
          ...(minecraft?.skillOutcomes ? { skillRead: (name: string) => minecraft.skillOutcomes?.read(step.scopeKey, step.taskId, name) } : {}) }),
          ...(minecraft ? [withMinecraftProgress(withMinecraftAgenda(fcaMinecraftTools({ control: minecraft.control, step, ownerAlone: parts.ownerAlone,
            sourcesVisible: () => check.whole('tool') ?? false,
            ...(minecraft.skillOutcomes ? { evidence: (result?: string) => minecraft.skillOutcomes?.evidence(step.scopeKey, step.taskId, result) } : {}) }),
            { on: minecraft.agenda.on, taskId: step.taskId, judge: minecraftOpportunityJudge(jev, step.scopeKey), log: line => console.info(line),
              ...minecraftProcedureStepParts(_runtime, step), observe: () => minecraft.control.observe(minecraft.control.store.body(step.taskId) ?? ''),
              arrivedAt: () => minecraft.control.arrivedAt(minecraft.control.store.body(step.taskId) ?? '') }),
            // A failed call that made something is not a failed step (`minecraftProgress.ts`, mb-r23).
            { observe: () => minecraft.control.observe(minecraft.control.store.body(step.taskId) ?? '') }),
            ...(body ? [body.tools] : [])] : [])), { checkpoint: step.snapshot.checkpoint, binding, requireConditions: keepBodyTools(), permit: permitProgress, observationSignal: (name, signal) => body?.body.toolSignal(name, signal) ?? signal }) } : { tools: createFcaProgressTools(combineFcaTools(), { checkpoint: step.snapshot.checkpoint, binding, requireConditions: keepBodyTools(), permit: permitProgress, observationSignal: (name, signal) => body?.body.toolSignal(name, signal) ?? signal }) }),
      }); } });
    visible = parts.state && parts.conversations ? createFcaSourceGuard({ runtime: runtime.runtime, state: parts.state,
      conversations: parts.conversations, ownerScope: parts.ownerScope, ownerAlone: parts.ownerAlone,
      readSourceVisible }) : undefined;
    if (visible && sleep) {
      const foregroundVisible = visible;
      visible = Object.assign((scope: string, id: string, pending?: string, via?: FcaWalkCaller) => {
        const task = runtime.runtime.get(scope, id);
        return task?.kind === 'sleep' ? scope === parts.ownerScope && parts.ownerAlone() && sleep!.visible(runtime.runtime, task) : foregroundVisible(scope, id, pending, via);
      }, { sources: foregroundVisible.sources, progress: foregroundVisible.progress, content: foregroundVisible.content,
        // `peek` too: without it the evidence store and the monitor below never saw the foreground guard's verdicts while sleep was on.
        peek: foregroundVisible.peek, withheld: foregroundVisible.withheld,
        // The evidence store's coverage and walk counts are the foreground guard's, as its `sources` (review of 5d492ae8).
        covers: foregroundVisible.covers, residual: foregroundVisible.residual, walks: foregroundVisible.walks });
    }
    const conversation = visible ? createFcaConversationBridge({ runtime: runtime.runtime, ownerScope: parts.ownerScope, visible, selector }) : null;
    if (visible && parts.state && parts.conversations && readSourceVisible) shared = createFcaSharedWiring({ ...parts, db, runtime: runtime.runtime, state: parts.state, conversations: parts.conversations, visible, readSourceVisible,
      segmentStaleMinutes: fcaSegmentStaleMinutes(values.SHANNON_FCA_SEGMENT_STALE_MINUTES),
      provenanceRefs: switchOn(values, 'SHANNON_FCA_PROVENANCE_REFS'), bodyRecallJev: switchOn(values, 'SHANNON_FCA_BODY_RECALL_JEV') ? jev : null });
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
    const wake = () => { minecraft?.skillOutcomes?.tick((scope, id) => runtime.runtime.get(scope, id)?.phase ?? null); try { sleep?.jobs.reconcile(runtime.runtime); sleep?.jobs.admit(runtime.runtime); } catch { /* Atomic admission retries; unknown task outcomes remain held. */ } void touch?.tick().catch(() => {}); if (!parts.ownerAlone()) void shared?.recall.cancelAll(); void shared?.evidence?.drain({ segments: true }).catch(() => { /* Durable evidence remains for retry. */ }); void runtime.tick().catch(() => {}); };
    const timer = setInterval(() => timedTick('fca_wake', wake), 1000); timer.unref();
    const operator = parts.operator ? startOperatorMinecraft({ ...parts.operator, audit: operatorAudit, path: parts.path, scopeKey: parts.ownerScope,
      now: parts.now ?? (() => new Date().toISOString()), ownerAlone: parts.ownerAlone, log: line => console.log(line),
      requests: minecraft && requests ? { ...requests.operator, wake } : null, bodyRecheck: minecraft?.recheck ?? null,
      talkNotes: operatorTalkNotes(values) }) : null;
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
      lifecycleTaskSources: (executionId: string) => { const ids = lifecycleSources(executionId); return ids ? [...new Set(ids)].sort() : null; }, minecraft: minecraft && requests ? { control: minecraft.control, intent: requests.intent, admission: requests.admission, voice: requests.voice } : null,
      // Whether a Minecraft-bound task is running, stopping or unknown (the phases that are not final); null when that cannot be read.
      // 「新しいワールドで始める」 (`freshWorldWiring.ts`) makes a new world only when this is exactly false.
      minecraftTasksOpen: (): boolean | null => { try { return requests ? requests.operator.open().length > 0 : null; } catch { return null; } },
      async stopActions(target: string | null) {
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

/** A step's read receipts (`skill.read`, the skill index, a skill gist), against the task's source guard (`stepReadObserver`). */
type StepReadParts = Omit<Parameters<typeof stepReadObserver>[0], 'sourcesVisible'>;
function fcaStepReads(parts: StepReadParts & { visible(): ReturnType<typeof createFcaSourceGuard> | undefined }) {
  const { step } = parts;
  const sourcesVisible = () => parts.visible()?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources, undefined, 'skill_read') ?? false;
  return stepReadObserver({ ...parts, sourcesVisible });
}
