import type { TaskProgressEvent } from '../taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskStep, TaskSnapshot } from '../taskRuntime/taskRuntimePorts.js';
import { TASK_TOOLS } from '../../tools/toolRunnerPorts.js';
import { observeAsync, observerHandoff, observeSync, withObserverTask } from '../../../infra/observer/observerContext.js';
import { currentActionExecution } from '../../../infra/context/actionExecution.js';
import { observedToolName } from '../../../infra/models/anthropic/observerProjection.js';
import { detachedModelCall } from './fcaModelIsolation.js';
import type { FcaToolSelector } from '../../selectors/selectorsPorts.js';
import { TOOL_OPEN_NAME } from '../../tools/toolRegistryPorts.js';
import type { BodyTaskRecall, TaskRecall } from '../../recall/taskRecallPorts.js';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import type { FcaEvidence } from './fcaEvidencePorts.js';
import { fcaRecallContext } from './fcaRecallContext.js';
import type { FcaBodyLifecycle, FcaDecision, FcaExternalTools, FcaModel, FcaModelInput, FcaModelOutput, FcaToolCall } from './fcaPorts.js';
import { decideWithRetry, FCA_RETRY_REFRESH_MS } from './fcaProviderRetry.js';
import { decideInterruptibly } from './fcaUrgentDecision.js';
import { fcaDecisionMetrics } from './fcaDecisionMetrics.js';
import { selectFcaTools, selectedFcaTools } from './fcaToolState.js';
import { prepareFcaHistory } from './fcaHistory.js';
import { withCoreAnchor, type FcaObsMode } from './fcaCoreTools.js';
import { fcaTransientHistory, isFcaTransientTask, shouldForceFcaEpoch } from './fcaCoreHistory.js';
import { isTransientUnsupported, legacyToolState } from './fcaTransientFallback.js';
import { FCA_WAIT_WITHOUT_COUNTERPART, fcaWaitGate } from './fcaWaitGate.js';
import { runToolRound, type RoundContext, type RoundOutcome } from './fcaToolRound.js';
import { settleNews, waitForQueue } from './fcaStretch.js';
import { closeFcaMonitors, investigateFcaBody } from './fcaBodyInvestigation.js';
import { FCA_COMPLETION_MISTAKES_STOP, sayCompletionMistake, type FcaCompletionMistake } from './fcaCompletionMistake.js';
import { reflexCutCheckpoint, reflexCutRunOf, repeatedFailureReason, settleReflexStep } from './fcaReflexCuts.js';
import { failureSinceCheckpoint, failureSinceOf, failureStops, nextFailureSince } from './fcaFailureLadder.js';
import type { FcaObservationLifecycle } from './fcaObservation.js';
import { planInput, type FcaPlanPort } from './fcaPlanTools.js';
import { permitDue } from './fcaStepCost.js';
import type { FcaHistoryAheadOptions, FcaHistoryCodec, FcaHistoryPolicy, FcaHistorySummarizer } from './fcaHistoryPorts.js';


export interface FcaStepPorts {
  runtime: TaskRuntime; model: FcaModel;
  ownerAlone(): boolean;
  /** Trusted policy for internal maintenance; never changes disclosure or tool audience. */
  executionAllowed?(): boolean;
  taskTools?: boolean;
  /** Code-owned phase state, committed with history under the same action lease. */
  checkpoint?(): Readonly<Record<string, unknown>>;
  /** Existing lease/resource gate, rechecked before each model or tool operation. */
  permit(): Promise<boolean>;
  selector?: FcaToolSelector;
  /** This task acts through a body (bound, or made from a body request): a reselection never leaves out all its body tools. */
  keepBodyTools?(): boolean;
  /** `SHANNON_FCA_OBS_MODE` (`fcaCoreTools.ts`); a body task takes it only when it starts, never after. Absent: legacy. */
  obsMode?: FcaObsMode;
  recall?: TaskRecall;
  /** A body task's recall (`bodyTaskRecall.ts`); the task recall above is never started for a body task. */
  bodyRecall?: BodyTaskRecall;
  evidence?: FcaEvidence;
  observeMemory?(ids: readonly string[]): boolean | Promise<boolean>;
  tools?: FcaExternalTools;
  history?: { codec: FcaHistoryCodec; summarizer?: FcaHistorySummarizer; policy?: Partial<FcaHistoryPolicy>;
    /** mb-llmc r3: the summary is made beside the steps (`prepareFcaHistory`); absent: it is made in the step that needs it. */
    ahead?: Pick<FcaHistoryAheadOptions, 'port' | 'hard' | 'waitMs'> };
  /** Rechecks only the sources pinned to this admitted step, never newly pending inbox input. */
  sourcesVisible?(): boolean;
  /** Disclosure for another task's list/get/send projection. */
  taskVisible?(taskId: string): boolean;
  /** Persist source lineage before another task's successful projection enters this round. */
  observeTasks?(taskIds: readonly string[]): boolean;
  /** Actual remote-body acknowledgement, independently of local promises having unwound. */
  safeToAcknowledgeStop?(): boolean;
  body?: FcaBodyLifecycle;
  observations?: readonly FcaObservationLifecycle[];
  /**
   * Whether whoever handed this task over can send it a message (`fcaWaitGate.ts`). False only where the wiring knows nobody can
   * (an operator's hand-over); absent means a wait is never questioned.
   */
  waitCounterpart?(): boolean;
  /**
   * The wait before a decision that carried no answer is asked again (`fcaProviderRetry.ts`): the suggested exponential, jittered wait,
   * which already honours the provider's `retry-after`, when absent (tests: 0, or a spy on `suggestedMs`).
   */
  decisionRetryDelayMs?(suggestedMs: number, failed: number): number;
  /** False once the task's budget has no room for another request that may be charged: the decision's retries end there. */
  retryAllowed?(): boolean;
  /** The task's plan tree (`fcaPlanTools.ts`): read into each decision, its flat copy committed with the step. Absent: no plan. */
  plan?: FcaPlanPort;
  /** Design mb-llm-centric 2.3: how long one lease grant serves every check of the step (`permitDue`, `fcaPlanTools.ts`). */
  permitWindowMs?: number;
  completionMistake?: FcaCompletionMistake; // mb-llmc r5: a turned-back completion, told in one line, counted only in a row
}
/** One bounded model decision; waiting and completed segments release their inference slot in wiring. */
export async function runFcaStep(step: TaskStep, ports: FcaStepPorts, signal: AbortSignal): Promise<TaskSnapshot> {
  return withObserverTask({ taskId: step.taskId, parentTaskId: step.snapshot.task.parentId, stepId: step.id, actionId: step.lease.id }, () =>
    observeAsync('fca', { phase: 'step', kind: step.snapshot.task.kind, revision: step.revision }, async () => {
      const enteredAt = performance.now();
      try { ports.body?.start(signal); for (const observation of ports.observations ?? []) observation.start(signal); return await executeFcaStep(step, ports, signal, enteredAt); }
      finally { try { await closeFcaMonitors(ports); } finally { await ports.recall?.finishSegment(step.scopeKey, step.taskId); } }
    }, value => ({ phase: value.task.phase, revision: value.revision })));
}
async function executeFcaStep(step: TaskStep, ports: FcaStepPorts, signal: AbortSignal, enteredAt?: number): Promise<TaskSnapshot> {
  const { runtime } = ports;
  const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object'
    ? step.snapshot.checkpoint as Record<string, unknown> : {};
  const metrics = fcaDecisionMetrics(step.taskId, step.snapshot.task.createdAt, prior, enteredAt === undefined ? {} : { enteredAt });
  const maintenance = step.snapshot.task.origin === 'maintenance' && step.snapshot.task.kind === 'sleep';
  const progress = (event: TaskProgressEvent) => {
    if (maintenance) return;
    // Optional UI observations never change an operation's actual outcome.
    try { metrics.timedSync('progressMs', () => runtime.recordProgress?.(step, event)); } catch { /* as above */ }
  };
  // Her own-time work (ADR-0009 stage 2, E4) is hers, not a conversation: it is held by its own gate, not by who is present.
  const ownTime = step.snapshot.task.origin === 'own_time';
  /** Why the step may not go on now, as a closed reason, or null. */
  const heldReason = (): 'owner_not_alone' | 'execution_disallowed' | null => {
    if (maintenance || ownTime) return ports.executionAllowed?.() === true ? null : 'execution_disallowed';
    if (!ports.ownerAlone()) return 'owner_not_alone';
    return ports.executionAllowed?.() ?? true ? null : 'execution_disallowed';
  };
  // Minecraft run 8 (2026-10-14): a step was held right after a compaction and nothing said which check held it. Content-free.
  const held = (reason: string) => {
    console.warn(`Shannon FCA execution held task=${step.taskId} reason=${reason}`);
    return new Error('FCA_EXECUTION_HELD');
  };
  // Minecraft run 18: the lease was asked of the mind at every check, about ten a decision at about 0.12 s each (1.27 s a decision).
  // Now `fresh` asks it just before an outside call that needs it (the summarizer, the model, a retry, a tool that does not ask it
  // itself); `reuse` (between steps of the decision's own preparation) asks only when the last grant is `FCA_PERMIT_REUSE_MS` old, so a
  // selector or a recall that took longer is followed by an ask; `local` asks nothing where the next outside call asks for itself (a
  // body tool, the completion's verification) or the commit checks the lease in its own transaction. The local checks (who is
  // present, the sources, the task's phase, a stop) run at every check, and once more after an ask (the event loop ran meanwhile);
  // with no ask nothing ran between, so they are not repeated (each sources check can walk the task's provenance: run 18 named 323
  // walks of 100 ms or more, 73 s in all).
  let permittedAt = Number.NEGATIVE_INFINITY;
  const local = () => {
    signal.throwIfAborted();
    const reason = heldReason();
    if (reason) throw held(reason);
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
  };
  const checked = (mode: 'fresh' | 'reuse' | 'local' = 'reuse') => metrics.timed('permitMs', () => observeAsync('gate', { phase: 'step_permit' }, async () => {
    local();
    if (permitDue(mode, performance.now() - permittedAt, ports.permitWindowMs)) {
      metrics.asked();
      if (!await ports.permit()) throw held('permit_denied');
      permittedAt = performance.now();
      local();
    }
    if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
  }, () => ({ allowed: true })));
  await checked();
  // A body task's decision carries no recall packet, in either shape (run 15, 2026-10-19: 2.3–7.3k characters of past episodes in every
  // stored decision, and 2.7 s of each step): what she did before is one `memory.search` away (offered to every task) when it matters.
  const bodyTask = ports.keepBodyTools?.() === true;
  const surprised = bodyTask && await investigateFcaBody(ports, step.taskId, metrics, signal);
  if (surprised) await checked();
  // mb-llmc r3 (run 27: a creeper stopped her act at 3.9 m and the next decision came 12.8 s later): an urgent step asks the model at once,
  // with no summary while the replay fits its bound and no recall (`FcaBodyLifecycle.urgent`).
  const urgent = bodyTask && ports.body?.urgent?.() === true;
  if (urgent) metrics.urgent();
  const recallContext = ports.recall && !bodyTask && !isFcaTransientTask(prior, ports) ? fcaRecallContext(step, prior, signal) : null;
  // The recall's deterministic part runs on the API's one thread. Minecraft run 6 (2026-10-14): started while a body had just logged
  // in, it blocked the thread while a stop was being handed over. Pending I/O (the body's polls) goes first; while the body is still
  // in its first frames after login, the recall starts with the decision packet instead (which starts it if nothing did).
  if (recallContext && !ports.body?.settling?.()) {
    await new Promise<void>(resolve => setImmediate(resolve));
    signal.throwIfAborted();
    observerHandoff('fca', 'recall', { phase: 'start' }); metrics.timedSync('recallStartMs', () => ports.recall!.start(recallContext.input));
  } else if (recallContext) observerHandoff('fca', 'recall', { phase: 'start_deferred', reason: 'body_settling' });
  const catalog = [...(maintenance || ports.taskTools === false ? [] : TASK_TOOLS), ...(ports.tools?.definitions ?? [])];
  if (new Set(catalog.map(tool => tool.name)).size !== catalog.length || catalog.some(tool => tool.name === TOOL_OPEN_NAME)) throw new Error('FCA_TOOL_CATALOG_INVALID');
  // A transient body task: the core definitions come off the replay budget, and a stale core may start a new epoch (`fcaCoreHistory.ts`).
  const transient = fcaTransientHistory(prior, catalog, ports);
  const cutLast = prior.fcaStateCut === true;
  const forceEpoch = transient && (transient.stale || cutLast) && ports.history?.summarizer
    ? (replay: readonly unknown[]) => shouldForceFcaEpoch(transient, replay, step.taskId, cutLast) : undefined;
  const historyAhead = ports.history?.ahead && ports.history.summarizer ? { ...ports.history.ahead, detach: detachedModelCall, urgent,
    note: (what: string) => metrics.ahead(what) } : undefined;
  const replay = ports.history ? await metrics.timed('summaryMs', () => prepareFcaHistory(step, {
    runtime, codec: ports.history!.codec, summarizer: ports.history!.summarizer,
    permit: async () => { await checked('fresh'); return true; }, sourcesVisible: () => ports.sourcesVisible?.() ?? true,
  }, signal, transient?.policy ?? ports.history!.policy, { ...(forceEpoch ? { forceEpoch } : {}), ...(historyAhead ? { ahead: historyAhead } : {}) })) : null;
  const provenance = { taskId: step.taskId, parentId: step.snapshot.task.parentId, stepId: step.id, revision: step.revision };
  const input = metrics.timedSync('contextMs', () => observeSync('context', provenance, () => {
    const children = step.snapshot.task.childIds.flatMap(id => {
      const child = runtime.get(step.scopeKey, id);
      return child && (!ports.taskVisible || ports.taskVisible(id)) ? [{ id: child.id, title: child.title, phase: child.phase, summary: child.summary }] : [];
    });
    if (children.length && ports.observeTasks && !ports.observeTasks(children.map(child => child.id))) throw new Error('FCA_SOURCE_WITHHELD');
    return { task: step.snapshot.task, messages: step.snapshot.messages, children,
      history: replay?.history ?? step.snapshot.history, tools: catalog };
  }, () => ({ ...provenance, tools: catalog.map(tool => observedToolName(tool.name, catalog)), messages: step.snapshot.messages.length })));
  await checked();
  let selection: Awaited<ReturnType<typeof selectFcaTools>> | null = ports.selector ? await metrics.timed('selectorMs', () => selectFcaTools(input, catalog, prior.fcaToolSelection, ports.selector!,
    step.scopeKey, signal, { keepBodyTools: ports.keepBodyTools?.() === true, ...(ports.obsMode ? { obsMode: ports.obsMode } : {}) })) : null;
  if (selection) {
    input.tools = selectedFcaTools(catalog, selection);
  }
  await checked();
  const recall = recallContext ? await observeAsync('recall', { phase: 'decision_packet', maximumWaitMs: recallContext.waitMilliseconds },
    () => metrics.timed('recallMs', () => ports.recall!.packet(recallContext.input, { waitMilliseconds: recallContext.waitMilliseconds })),
    value => ({ status: value.status, itemCount: value.items.length, sourceCount: value.sourceIds.length })) : undefined;
  if (recall?.sourceIds.length && (!ports.observeMemory || !await ports.observeMemory(recall.sourceIds))) throw new Error('FCA_SOURCE_WITHHELD');
  await checked();
  if (recall) observerHandoff('recall', 'context', { phase: 'decision_packet', status: recall.status, itemCount: recall.items.length, sourceCount: recall.sourceIds.length });
  // Minecraft run 7 (2026-10-14): 1.8–5.8 s of the API's one thread per step here. It now walks rarely and lets I/O through between walks.
  const sharedContext = ports.evidence ? await observeAsync('emotion', { phase: 'shared_context' }, () => metrics.timed('evidenceMs', () => ports.evidence!.prepare(step)),
    value => ({ outcomeCount: value.recentOutcomes.length })) : undefined;
  await metrics.timed('guardMs', async () => {
    if (ports.body) await ports.body.guard(ports.body.revision());
    for (const observation of ports.observations ?? []) await observation.guard(observation.revision());
  });
  let observationRevisions = (ports.observations ?? []).map(observation => observation.revision());
  const observationFresh = async () => (await Promise.all((ports.observations ?? []).map((observation, index) => observation.guard(observationRevisions[index]!)))).every(Boolean);
  let bodyRevision = ports.body?.revision() ?? 0;
  /** Whether the body and the observations are still at the revisions this decision was asked on (the time it waits is `guardMs`). */
  const stillFresh = () => metrics.timed('guardMs', async () => (!ports.body || await ports.body.guard(bodyRevision)) && await observationFresh());
  /** `stillFresh` for one call: the body may let a call of the kind it owns go on past its own reflexes' touches (`guardFor`). */
  const stillFreshFor = (call: FcaToolCall | undefined) => call && ports.body?.guardFor
    ? metrics.timed('guardMs', async () => await ports.body!.guardFor!(bodyRevision, call) && await observationFresh()) : stillFresh();
  const skillIndex = metrics.timedSync('contextMs', () => ports.tools?.skillIndex?.());
  const waitGate = fcaWaitGate(step, runtime, ports.waitCounterpart, prior);
  const waiting = waitGate.fact();
  await checked();
  const request: FcaModelInput = metrics.timedSync('contextMs', () => ({ ...input,
    ...(ports.observations ? { observations: ports.observations.map(observation => observation.context()) } : {}),
    ...(ports.tools?.progress ? { progress: ports.tools.progress.context() } : {}), ...(skillIndex ? { skillIndex } : {}),
    ...(ports.body ? { body: ports.body.context() } : {}), ...(waiting ? { waiting } : {}), ...(recall ? { recall } : {}),
    ...(sharedContext ? { sharedContext } : {}), ...planInput(ports.plan),
    ...(selection ? { catalog: catalog.map(tool => ({ name: tool.name, description: tool.description })) } : {}),
    ...(selection?.obsMode === 'transient' && selection.core ? { coreTools: selection.core.tools,
      ...(transient ? { replayTokenLimit: transient.policy.maximumReplayTokens } : {}),
      ...(ports.body?.transient ? { transient: ports.body.transient() } : {}) } : {}) }));
  // A body task's recall (`bodyTaskRecall.ts`): a few memories for the situation the body was just read in (`recallCues`), none when
  // nothing fits; its sources are pinned like the recall packet's before anything is sent.
  if (bodyTask && ports.bodyRecall && !urgent && ports.body?.recallWanted?.() !== false) {
    const found = await metrics.timed('recallMs', () => ports.bodyRecall!.packet({ scopeKey: step.scopeKey, taskId: step.taskId,
      goal: step.snapshot.task.goal, cues: ports.body?.recallCues?.() ?? { words: [], tags: [] }, present: OWNER_AUDIENCE, signal }));
    metrics.bodyRecall(found.measure);
    if (found.packet.sourceIds.length && (!ports.observeMemory || !await ports.observeMemory(found.packet.sourceIds))) throw new Error('FCA_SOURCE_WITHHELD');
    if (found.packet.items.length) request.recall = found.packet;
    await checked();
  }
  observerHandoff('context', 'native', provenance);
  const execution = currentActionExecution();
  if (execution) execution.decisionRequested = true;
  // A failed attempt that carried no decision leaves nothing to apply: its outcome is known, its spend was recorded by the adapter.
  const answeredNothing = () => { if (execution && execution.stepOutcome !== 'unknown') execution.modelOutcome = 'acknowledged'; };
  /**
   * A request asked again after a wait of ten seconds or more is rebuilt from the body's present observation: the one built before
   * the first attempt is minutes old by then, and a decision made on it would be discarded as stale (`bodyStale` below). The body
   * settles and its revision is read again exactly as before the first request; what the decision is later checked against is that
   * new revision. Nothing else of the request changes (the history, the tools and the messages are the ones the first attempt had).
   */
  const freshen = async (asked: FcaModelInput): Promise<FcaModelInput> => {
    if (ports.body) await ports.body.guard(ports.body.revision());
    for (const observation of ports.observations ?? []) await observation.guard(observation.revision());
    observationRevisions = (ports.observations ?? []).map(observation => observation.revision());
    bodyRevision = ports.body?.revision() ?? 0;
    return { ...asked,
      ...(ports.observations ? { observations: ports.observations.map(observation => observation.context()) } : {}),
      ...(ports.tools?.progress ? { progress: ports.tools.progress.context() } : {}),
      ...(ports.body ? { body: ports.body.context() } : {}), ...planInput(ports.plan),
      ...(asked.transient !== undefined && ports.body?.transient ? { transient: ports.body.transient() } : {}) };
  };
  /** The request in hand (the one last sent, rebuilt by every `freshen`) and when it was built: a fallback starts from this, never from the first one. */
  let latest = { asked: request, at: Date.now() };
  const ask = (asked: FcaModelInput, cancel: AbortSignal) => {
    latest = { asked, at: Date.now() };
    const thrown = () => cancel !== signal && cancel.aborted && !signal.aborted;
    return decideWithRetry(() => metrics.timed('llmMs', () => ports.model.decide(latest.asked, cancel), thrown), { signal: cancel,
      recheck: () => checked('fresh'), delay: ports.decisionRetryDelayMs, afford: ports.retryAllowed, failed: answeredNothing,
      log: line => console.warn(`${line} task=${step.taskId}`),
      refresh: async () => { latest = { asked: await freshen(latest.asked), at: Date.now() }; } });
  };
  const decide = (asked: FcaModelInput, cancel: AbortSignal = signal) => decideInterruptibly({ body: ports.body, signal: cancel, request: asked, ask,
    interrupted: ({ thrownMs }) => metrics.interrupted(thrownMs),
    again: async request => { ports.body?.rebuilding?.(); await checked('fresh'); return freshen(request); } });
  /** The first decision of the step: a transient task refused for its betas starts again in the legacy shape. */
  const decideFirst = (asked: FcaModelInput) => decide(asked).catch(async error => {
    // The very first decision of a transient task refused for its betas: no signed history exists, so it starts again in the legacy shape.
    if (!isTransientUnsupported(error) || !selection || selection.obsMode !== 'transient' || input.history.length) throw error;
    console.warn(JSON.stringify({ event: 'fca_obs_mode_fallback', task: step.taskId, from: 'transient', to: 'legacy', reason: 'beta_rejected' }));
    selection = legacyToolState(selection);
    input.tools = selectedFcaTools(catalog, selection);
    // The legacy request is made from the request in hand (its observations, body and progress may have been rebuilt meanwhile, and
    // `bodyRevision` and `observationRevisions` already name that observation), not from the first one (M-B). If that one has grown old
    // while the attempts ran, it is rebuilt again, with the gate before and after as for every further request.
    const { coreTools: _core, transient: _live, replayTokenLimit: _limit, ...legacy } = latest.asked;
    let legacyRequest: FcaModelInput = { ...legacy, tools: input.tools };
    if (Date.now() - latest.at >= FCA_RETRY_REFRESH_MS) {
      await checked();
      legacyRequest = await freshen(legacyRequest);
      await checked();
    }
    return decide(legacyRequest);
  });
  const history: unknown[] = [];
  let consecutiveToolFailures = Number(prior.consecutiveToolFailures ?? 0);
  if (!Number.isSafeInteger(consecutiveToolFailures) || consecutiveToolFailures < 0) consecutiveToolFailures = 0;
  const priorToolFailures = consecutiveToolFailures;
  // When the failures in a row began (`fcaFailureLadder.ts`): a body task stops on how long nothing has moved, not on the count alone.
  const stepStartedAt = Date.now(), priorFailureSince = failureSinceOf(prior);
  let failureSince = priorFailureSince;
  const priorReflexRun = reflexCutRunOf(prior);
  let reflexRun = priorReflexRun;
  /** Whether the step that took the failure count to its present value counted a reflex cut as the failure (the stop reason below). */
  let failedByCuts = false;
  let completionVerificationFailures = Number(prior.completionVerificationFailures ?? 0);
  if (!Number.isSafeInteger(completionVerificationFailures) || completionVerificationFailures < 0) completionVerificationFailures = 0;
  let completionRejected = null as { reason?: string } | null;
  const state = { bodyStale: false };
  const settleOutcomes = (outcomes: readonly RoundOutcome[]) => {
    // A cut call does not count until the same tool (or any) has been cut off too many times in a row; any outcome of its own ends the run, but a
    // read that worked beside or between cuts does not (`fcaReflexCuts.ts`, M2).
    ({ failures: consecutiveToolFailures, run: reflexRun, byCuts: failedByCuts } = settleReflexStep(consecutiveToolFailures, reflexRun, outcomes));
    failureSince = nextFailureSince(priorFailureSince, priorToolFailures, consecutiveToolFailures, stepStartedAt);
  };
  const roundContext: RoundContext = { step, ports, signal, runtime, metrics, checked, stillFresh, stillFreshFor, progress, catalog, input, provenance, bodyTask, state,
    get selection() { return selection; } };
  // The stretch (`fcaStretch.ts`): with the task queue, the step decides again while its items run and commits when none is open.
  const queue = bodyTask ? ports.body?.queue : undefined;
  let output!: FcaModelOutput, decision!: FcaDecision, rounds = 0;
  let asked: FcaModelInput | null = request;
  /** The last round's results and where its message stands in `history`: a decision thrown away puts the news of the items that ended after it there (run 41). */
  let lastRound: { results: Array<{ id: string; text: string; ok: boolean }>; at: number } | null = null;
  while (asked) {
    rounds += 1;
    const operationId = rounds === 1 ? `${step.id}:decision` : `${step.id}:decision${rounds}`;
    const askedVersion = queue?.version() ?? 0;
    progress({ operationId, tool: 'fca.decide', status: 'running' });
    if (rounds === 1) await checked('fresh');
    // A decision asked while items run is thrown away when one of them ends badly or is taken off: what it chose followed the queue it saw.
    const cancel = new AbortController();
    let thrownAway = false;
    const watch = rounds > 1 && queue ? setInterval(() => { if (queue.version() !== askedVersion) { thrownAway = true; cancel.abort(new Error('FCA_QUEUE_CHANGED')); } }, 100) : null;
    watch?.unref?.();
    const decidedAt = performance.now();
    let answer: FcaModelOutput | null = null;
    try {
      answer = rounds === 1 ? await decideFirst(asked) : await decide(asked, AbortSignal.any([signal, cancel.signal]));
    } catch (error) {
      if (!thrownAway || signal.aborted) {
        progress({ operationId, tool: 'fca.decide', status: 'unknown' });
        // Run 41: a step that ends on an error with items still running in the body leaves nobody to watch them and its outcome unknown until they end (1.5 minutes
        // of a refused request, minecraft_busy). The items are taken off here, so that their answers settle the step within a moment (`queueLifecycle.close`).
        queue?.cancelAll();
        throw error;
      }
    } finally { if (watch) clearInterval(watch); }
    if (!answer) {
      progress({ operationId, tool: 'fca.decide', status: 'failed' });
      metrics.stretch(rounds, true);
      // Run 41 (q103 and q143: the reason of a failed mine, 「…は deepslate_diamond_ore」, was in no later input): the item whose bad end threw this decision away
      // has its result in the queue's news, and the queue is this step's only. The news is settled as a round's is and stands at the end of the last tool result of
      // the round before (its message in the history is made again); with no such round it goes to the next decision (`noteNews`).
      if (queue) {
        const news = settleNews(roundContext, queue.take());
        if (news.outcomes.length && !state.bodyStale) settleOutcomes(news.outcomes);
        if (news.text && lastRound?.results.length && history[lastRound.at] !== undefined) {
          const last = lastRound.results.at(-1)!;
          lastRound.results[lastRound.results.length - 1] = { ...last, text: `${last.text}\n${news.text}` };
          history[lastRound.at] = ports.model.toolResults(lastRound.results);
        } else if (news.text) ports.body?.noteNews?.(news.text);
      }
      break;
    }
    output = answer;
    queue?.noteDecision(performance.now() - decidedAt);
    progress({ operationId, tool: 'fca.decide', status: 'received' });
    await checked('local');
    state.bodyStale = !await stillFreshFor(output.decision.kind === 'tools' ? output.decision.calls[0] : undefined);
    if (ports.evidence && !observeSync('prediction', { phase: 'before_actions', expectationCount: output.expectations?.length ?? 0, appraisalCount: output.appraisals?.length ?? 0 },
      () => ports.evidence!.beforeActions(step, state.bodyStale ? { ...output, expectations: [], appraisals: [] } : output), value => ({ accepted: value }))) throw new Error('FCA_EVIDENCE_FENCED');
    history.push(...output.history);
    // The epoch's core pin is committed with what its replay will start with next (`continuesFcaEpoch`).
    if (rounds === 1 && selection?.core) selection.core = withCoreAnchor(selection.core, input.history, history);
    decision = output.decision;
    if (ports.completionMistake && decision.kind === 'tools') completionVerificationFailures = 0;
    const round = decision.kind === 'tools' ? await runToolRound(roundContext, decision, output.auxiliaryResults ?? []) : null;
    if (round && !state.bodyStale) settleOutcomes(round.outcomes);
    let continuing = false;
    if (queue) {
      const waited = await waitForQueue({ ports, signal, runtime, step, tools: decision.kind === 'tools', stale: state.bodyStale, round: rounds, startedAt: stepStartedAt });
      continuing = waited.continuing;
      const news = settleNews(roundContext, queue.take());
      if (news.outcomes.length && !state.bodyStale) settleOutcomes(news.outcomes);
      if (news.text && !round) ports.body?.noteNews?.(news.text);
      if (news.text && round?.results.length) {
        const last = round.results.at(-1)!;
        round.results[round.results.length - 1] = { ...last, text: `${last.text}\n${news.text}` };
      }
    }
    if (round) {
      lastRound = { results: round.results, at: history.length };
      history.push(ports.model.toolResults(round.results));
    }
    if (!continuing || state.bodyStale) {
      metrics.stretch(rounds, false);
      break;
    }
    // The next decision: the history so far, the body and the plan as they are now; no recall, no message (the step's own were the first decision's).
    await checked('fresh');
    if (bodyTask && await investigateFcaBody(ports, step.taskId, metrics, signal)) await checked('fresh');
    const { recall: _recall, waiting: _waiting, ...rest } = request;
    asked = await freshen({ ...rest, messages: [], history: [...input.history, ...history] });
    await checked('fresh');
  }
  let disposition: 'continue' | 'wait' | 'complete' = !decision ? 'continue' : decision.kind === 'tools' ? 'continue' : decision.kind;
  if (disposition === 'complete' && (step.snapshot.task.kind === 'root' ||
    (runtime.get(step.scopeKey, step.taskId)?.childIds ?? []).some(id => {
      const child = runtime.get(step.scopeKey, id); return child && !['completed', 'failed'].includes(child.phase);
    }))) disposition = 'wait';
  // A wait nobody can answer is turned away a bounded number of times, then committed and the task stopped (below).
  const gated = waitGate.apply(disposition);
  disposition = gated.disposition;
  await checked('local');
  if (disposition === 'complete' && !state.bodyStale && ports.tools?.progress) await metrics.timed('verifyMs', async () => {
    // Final native evidence must not race a new reflex using this same enclosing lease.
    // Stop and drain the physical monitor first; keep the task inbox monitor observing.
    await ports.body?.close();
    if (ports.body && !await ports.body.guard(bodyRevision)) state.bodyStale = true;
    if (!state.bodyStale) {
      const verification = await ports.tools!.progress!.verifyCompletion({ scopeKey: step.scopeKey, taskId: step.taskId, operationId: `${step.id}:completion`, name: 'goal.verify', input: {}, signal }, () => checked('fresh'));
      if (verification.status === 'not_verified') { disposition = 'continue'; completionRejected = verification; completionVerificationFailures++; }
      else completionVerificationFailures = 0;
    }
  });
  if (completionRejected && ports.completionMistake) sayCompletionMistake(history, ports.completionMistake, completionVerificationFailures, completionRejected);
  // No detached recall may keep spending after the segment's completion receipt becomes visible.
  await metrics.timed('closeMs', async () => ports.recall?.finishSegment(step.scopeKey, step.taskId));
  if (!await stillFresh()) state.bodyStale = true;
  await metrics.timed('closeMs', () => closeFcaMonitors(ports));
  if (!await stillFresh()) state.bodyStale = true;
  if (state.bodyStale) {
    disposition = 'continue'; consecutiveToolFailures = priorToolFailures; reflexRun = priorReflexRun; failedByCuts = false; failureSince = priorFailureSince;
  }
  await checked('local');
  observerHandoff(decision.kind === 'tools' ? 'tools' : 'llm', 'store', provenance);
  const planCommit = ports.plan?.committed();
  const saved = metrics.timedSync('commitMs', () => observeSync('store', provenance, () => runtime.commitStep(step, {
    history, disposition, ...(planCommit ? { plan: planCommit } : {}), checkpoint: { ...prior, ...(prior.fcaHeldRetries ? { fcaHeldRetries: 0 } : {}), ...(prior.fcaProviderRetries ? { fcaProviderRetries: 0 } : {}), ...ports.checkpoint?.(), ...ports.tools?.checkpoint?.(), ...(maintenance ? {} : metrics.checkpoint()), consecutiveToolFailures, ...failureSinceCheckpoint(failureSince, prior), ...reflexCutCheckpoint(reflexRun, prior), ...(ports.tools?.progress ? { completionVerificationFailures } : {}), ...(gated.refusedWaits ? { fcaWaitRefusals: gated.refusedWaits } : {}), ...(recallContext ? { fcaRecallInput: recallContext.checkpoint } : {}), ...(selection ? { fcaToolSelection: selection } : {}), ...(output.stateCut !== undefined ? { fcaStateCut: output.stateCut } : {}) }, ...(decision.kind !== 'tools' && !state.bodyStale ? { summary: completionRejected ? '完了条件を新しい観測でまだ確認できません。' : decision.summary } : {}),
  }), value => ({ ...provenance, committed: value !== null, phase: value?.task.phase ?? null })));
  if (!saved) throw new Error('FCA_COMMIT_FENCED');
  if (!maintenance) metrics.emit(); // Maintenance (sleep) steps keep their checkpoint as it was and write no line.
  if (saved.task.phase === 'waiting') {
    observerHandoff('store', 'wait', { phase: saved.task.phase });
    observeSync('wait', { phase: 'checkpoint', measured: 'state' }, () => undefined, () => ({ phase: saved.task.phase }));
  }
  // These callbacks drain durable outboxes; their failure must never undo/repeat committed tools.
  try { ports.evidence?.committed(step); } catch { /* Retried by the existing maintenance tick. */ }
  if (saved.task.phase === 'completed' || saved.task.phase === 'failed') {
    ports.recall?.cancel(step.scopeKey, step.taskId);
    ports.bodyRecall?.cancel(step.scopeKey, step.taskId);
  }
  if (gated.stop && saved.task.phase === 'waiting') {
    runtime.stop(step.scopeKey, step.taskId, FCA_WAIT_WITHOUT_COUNTERPART);
    return runtime.snapshot(step.scopeKey, step.taskId)!;
  }
  // A body task stops on a failure after the fifth was read, and when nothing has moved for a while (`failureStops`).
  const toolFailuresStop = failureStops({ body: bodyTask, failures: consecutiveToolFailures, priorFailures: priorToolFailures,
    since: failureSince, now: Date.now() });
  if (toolFailuresStop || completionVerificationFailures >= FCA_COMPLETION_MISTAKES_STOP) {
    runtime.stop(step.scopeKey, step.taskId, toolFailuresStop ? repeatedFailureReason(failedByCuts) : 'repeated_tool_failure');
    return runtime.snapshot(step.scopeKey, step.taskId)!;
  }
  return saved;
}

