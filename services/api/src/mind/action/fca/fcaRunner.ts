import type { TaskProgressEvent } from '../taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskStep, TaskSnapshot } from '../taskRuntime/taskRuntimePorts.js';
import { TASK_TOOLS, executeTaskTool } from '../../tools/toolRunnerPorts.js';
import { observeAsync, observerHandoff, observeSync, withObserverTask } from '../../../infra/observer/observerContext.js';
import { currentActionExecution } from '../../../infra/context/actionExecution.js';
import { observedToolName } from '../../../infra/models/anthropic/observerProjection.js';
import type { FcaToolSelector } from '../../selectors/selectorsPorts.js';
import { TOOL_OPEN_NAME, toolFailure } from '../../tools/toolRegistryPorts.js';
import type { BodyTaskRecall, TaskRecall } from '../../recall/taskRecallPorts.js';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import type { FcaEvidence } from './fcaEvidencePorts.js';
import { fcaRecallContext } from './fcaRecallContext.js';
import type { FcaBodyLifecycle, FcaExternalTools, FcaModel, FcaModelInput } from './fcaPorts.js';
import { decideWithRetry, FCA_RETRY_REFRESH_MS } from './fcaProviderRetry.js';
import { fcaDecisionMetrics } from './fcaDecisionMetrics.js';
import { openFcaTool, selectFcaTools, selectedFcaTools } from './fcaToolState.js';
import { prepareFcaHistory } from './fcaHistory.js';
import { withCoreAnchor, type FcaObsMode } from './fcaCoreTools.js';
import { fcaTransientHistory, isFcaTransientTask, shouldForceFcaEpoch } from './fcaCoreHistory.js';
import { isTransientUnsupported, legacyToolState } from './fcaTransientFallback.js';
import { FCA_WAIT_WITHOUT_COUNTERPART, fcaWaitGate } from './fcaWaitGate.js';
import { reflexCutCheckpoint, reflexCutRunOf, repeatedFailureReason, settleReflexStep } from './fcaReflexCuts.js';
import type { FcaObservationLifecycle } from './fcaObservation.js';
import type { FcaHistoryCodec, FcaHistoryPolicy, FcaHistorySummarizer } from './fcaHistoryPorts.js';

/** The result of a body action left unrun because an earlier body action of the same response failed (the guard in `executeFcaStep`). */
export const FCA_EARLIER_ACTION_FAILED = '同じ応答で先に呼んだ体の操作が失敗したため、この操作は実行していません。先の結果と新しい観測から判断し直してください。';

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
  observeMemory?(ids: readonly string[]): boolean;
  tools?: FcaExternalTools;
  history?: { codec: FcaHistoryCodec; summarizer?: FcaHistorySummarizer; policy?: Partial<FcaHistoryPolicy> };
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
    try { runtime.recordProgress?.(step, event); } catch { /* Optional UI observations never change an operation's actual outcome. */ }
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
  const checked = () => metrics.timed('permitMs', () => observeAsync('gate', { phase: 'step_permit' }, async () => {
    signal.throwIfAborted();
    const before = heldReason();
    if (before) throw held(before);
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
    if (!await ports.permit()) throw held('permit_denied');
    signal.throwIfAborted();
    const after = heldReason();
    if (after) throw held(after);
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
    if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
  }, () => ({ allowed: true })));
  await checked();
  // A body task's decision carries no recall packet, in either shape (run 15, 2026-10-19: 2.3–7.3k characters of past episodes in every
  // stored decision, and 2.7 s of each step): what she did before is one `memory.search` away (offered to every task) when it matters.
  const bodyTask = ports.keepBodyTools?.() === true;
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
  const replay = ports.history ? await metrics.timed('summaryMs', () => prepareFcaHistory(step, {
    runtime, codec: ports.history!.codec, summarizer: ports.history!.summarizer,
    permit: async () => { await checked(); return true; }, sourcesVisible: () => ports.sourcesVisible?.() ?? true,
  }, signal, transient?.policy ?? ports.history!.policy, forceEpoch ? { forceEpoch } : undefined)) : null;
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
  let selection = ports.selector ? await metrics.timed('selectorMs', () => selectFcaTools(input, catalog, prior.fcaToolSelection, ports.selector!,
    step.scopeKey, signal, { keepBodyTools: ports.keepBodyTools?.() === true, ...(ports.obsMode ? { obsMode: ports.obsMode } : {}) })) : null;
  if (selection) {
    input.tools = selectedFcaTools(catalog, selection);
  }
  await checked();
  const recall = recallContext ? await observeAsync('recall', { phase: 'decision_packet', maximumWaitMs: recallContext.waitMilliseconds },
    () => metrics.timed('recallMs', () => ports.recall!.packet(recallContext.input, { waitMilliseconds: recallContext.waitMilliseconds })),
    value => ({ status: value.status, itemCount: value.items.length, sourceCount: value.sourceIds.length })) : undefined;
  if (recall?.sourceIds.length && (!ports.observeMemory || !ports.observeMemory(recall.sourceIds))) throw new Error('FCA_SOURCE_WITHHELD');
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
  const skillIndex = metrics.timedSync('contextMs', () => ports.tools?.skillIndex?.());
  const waitGate = fcaWaitGate(step, runtime, ports.waitCounterpart, prior);
  const waiting = waitGate.fact();
  await checked();
  const request: FcaModelInput = metrics.timedSync('contextMs', () => ({ ...input,
    ...(ports.observations ? { observations: ports.observations.map(observation => observation.context()) } : {}),
    ...(ports.tools?.progress ? { progress: ports.tools.progress.context() } : {}), ...(skillIndex ? { skillIndex } : {}),
    ...(ports.body ? { body: ports.body.context() } : {}), ...(waiting ? { waiting } : {}), ...(recall ? { recall } : {}),
    ...(sharedContext ? { sharedContext } : {}),
    ...(selection ? { catalog: catalog.map(tool => ({ name: tool.name, description: tool.description })) } : {}),
    ...(selection?.obsMode === 'transient' && selection.core ? { coreTools: selection.core.tools,
      ...(transient ? { replayTokenLimit: transient.policy.maximumReplayTokens } : {}),
      ...(ports.body?.transient ? { transient: ports.body.transient() } : {}) } : {}) }));
  // A body task's recall (`bodyTaskRecall.ts`): a few memories for the situation the body was just read in (`recallCues`), none when
  // nothing fits; its sources are pinned like the recall packet's before anything is sent.
  if (bodyTask && ports.bodyRecall) {
    const found = await metrics.timed('recallMs', () => ports.bodyRecall!.packet({ scopeKey: step.scopeKey, taskId: step.taskId,
      goal: step.snapshot.task.goal, cues: ports.body?.recallCues?.() ?? { words: [], tags: [] }, present: OWNER_AUDIENCE, signal }));
    metrics.bodyRecall(found.measure);
    if (found.packet.sourceIds.length && (!ports.observeMemory || !ports.observeMemory(found.packet.sourceIds))) throw new Error('FCA_SOURCE_WITHHELD');
    if (found.packet.items.length) request.recall = found.packet;
    await checked();
  }
  observerHandoff('context', 'native', provenance);
  const execution = currentActionExecution();
  if (execution) execution.decisionRequested = true;
  progress({ operationId: `${step.id}:decision`, tool: 'fca.decide', status: 'running' });
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
      ...(ports.body ? { body: ports.body.context() } : {}),
      ...(asked.transient !== undefined && ports.body?.transient ? { transient: ports.body.transient() } : {}) };
  };
  /** The request in hand (the one last sent, rebuilt by every `freshen`) and when it was built: a fallback starts from this, never from the first one. */
  let latest = { asked: request, at: Date.now() };
  const decide = (asked: FcaModelInput) => {
    latest = { asked, at: Date.now() };
    return decideWithRetry(() => metrics.timed('llmMs', () => ports.model.decide(latest.asked, signal)), { signal, recheck: checked,
      delay: ports.decisionRetryDelayMs, afford: ports.retryAllowed, failed: answeredNothing,
      refresh: async () => { latest = { asked: await freshen(latest.asked), at: Date.now() }; },
      log: line => console.warn(`${line} task=${step.taskId}`) });
  };
  const output = await decide(request).catch(async error => {
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
  }).catch(error => {
    progress({ operationId: `${step.id}:decision`, tool: 'fca.decide', status: 'unknown' });
    throw error;
  });
  progress({ operationId: `${step.id}:decision`, tool: 'fca.decide', status: 'received' });
  await checked();
  let bodyStale = !await stillFresh();
  if (ports.evidence && !observeSync('prediction', { phase: 'before_actions', expectationCount: output.expectations?.length ?? 0, appraisalCount: output.appraisals?.length ?? 0 },
    () => ports.evidence!.beforeActions(step, bodyStale ? { ...output, expectations: [], appraisals: [] } : output), value => ({ accepted: value }))) throw new Error('FCA_EVIDENCE_FENCED');
  const history = [...output.history];
  // The epoch's core pin is committed with what its replay will start with next (`continuesFcaEpoch`).
  if (selection?.core) selection.core = withCoreAnchor(selection.core, input.history, history);
  let consecutiveToolFailures = Number(prior.consecutiveToolFailures ?? 0);
  if (!Number.isSafeInteger(consecutiveToolFailures) || consecutiveToolFailures < 0) consecutiveToolFailures = 0;
  const priorToolFailures = consecutiveToolFailures;
  const priorReflexRun = reflexCutRunOf(prior);
  let reflexRun = priorReflexRun;
  /** Whether the step that took the failure count to its present value counted a reflex cut as the failure (the stop reason below). */
  let failedByCuts = false;
  let completionVerificationFailures = Number(prior.completionVerificationFailures ?? 0);
  if (!Number.isSafeInteger(completionVerificationFailures) || completionVerificationFailures < 0) completionVerificationFailures = 0;
  let completionRejected = false;
  const decision = output.decision;
  let disposition: 'continue' | 'wait' | 'complete' = decision.kind === 'tools' ? 'continue' : decision.kind;
  if (decision.kind === 'tools') {
    if (!decision.calls.length || decision.calls.length > 8 || new Set(decision.calls.map(call => call.id)).size !== decision.calls.length) throw new Error('FCA_INVALID_CALLS');
    const results: Array<{ id: string; text: string; ok: boolean }> = [...output.auxiliaryResults ?? []];
    /** Calls the body's own reflex cut off: no fault of the model or the tool, so they neither add to nor clear the failure count
     * (until the bound of `fcaReflexCuts.ts`). */
    const reflexCuts = new Set<string>();
    /**
     * The guard that goes with the batch rule of `BODY_RULE` (the old Minebot's `earlier_action_failed`, ShannonExecutor.ts:971-974; L104:
     * 14 of 239 body calls): once a body action of this response has failed, the body actions after it are not run, since each was chosen
     * for the world the failed one was to leave. Reads still run, and so does every tool that is not the body's (the goal and replan tools,
     * a research write): only a body task's body actions (`minecraft_body`, not `read`) stop and are stopped. A call not run is neither a
     * failure of its own (the failure count, the pace ledger, the progress failures and the tool selection never see it) nor a stale
     * result, and it is no event (`FcaEvidence.notRun`).
     */
    const bodyAction = (name: string) => bodyTask && ports.tools?.definitions.some(definition => definition.name === name
      && definition.domain === 'minecraft_body' && definition.effect !== 'read') === true;
    let earlierFailed = false;
    const notRun = new Set<string>();
    for (const call of decision.calls) {
      await checked();
      if (!await stillFresh()) bodyStale = true;
      const operationId = `${step.id}:${call.id}`;
      const tool = call.name === TOOL_OPEN_NAME ? 'tool_open' : observedToolName(call.name, catalog);
      const skipped = !bodyStale && earlierFailed && bodyAction(call.name);
      observerHandoff('llm', 'gate', { ...provenance, operationId, tool });
      progress({ operationId, tool: call.name, status: 'running' });
      const toolStarted = performance.now();
      const result = await observeAsync('tools', { ...provenance, operationId, tool }, async () => {
        const staleResult = () => toolFailure('failed', '身体の状態が変わりました。最新の観測から判断し直してください。', { retryable: false });
        if (bodyStale) return staleResult();
        if (skipped) return toolFailure('failed', FCA_EARLIER_ACTION_FAILED, { retryable: true });
        if (call.name === TOOL_OPEN_NAME && selection) return openFcaTool(call.input, catalog, selection);
        if (!catalog.some(definition => definition.name === call.name)) return toolFailure('not_offered', 'このタスクでは利用できない道具です。');
        if (selection && !input.tools.some(definition => definition.name === call.name)) return toolFailure('not_offered', '定義が必要な道具は、先に tool_open で開いてください。');
        if (ports.tools?.definitions.some(definition => definition.name === call.name)) {
          // Never turn an unknown outside outcome into a retryable tool result.
          ports.body?.noteCall?.(call, operationId);
          let operationSignal = ports.body?.toolSignal(call.name, signal) ?? signal;
          for (const observation of ports.observations ?? []) operationSignal = observation.toolSignal(call.name, operationSignal);
          try { return await ports.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId, name: call.name, input: call.input, signal: operationSignal }); }
          catch (error) {
            if (operationSignal !== signal && operationSignal.aborted && !signal.aborted && !await stillFresh()) {
              bodyStale = true; return staleResult();
            }
            throw error;
          }
        }
        return executeTaskTool(runtime, call.name, call.input, { scopeKey: step.scopeKey, taskId: step.taskId, operationId,
          ownerAlone: ports.ownerAlone, ...(ports.taskVisible ? { visible: ports.taskVisible } : {}),
          ...(ports.observeTasks ? { observed: ports.observeTasks } : {}) });
      },
      value => ({ ...provenance, operationId, ok: value.ok, failure: value.failure ?? null })).catch(error => { progress({ operationId, tool: call.name, status: 'unknown' }); ports.evidence?.unknown(step, call); throw error; });
      if (skipped) metrics.skipped(call.name); else metrics.tool(call.name, performance.now() - toolStarted);
      progress({ operationId, tool: call.name, status: result.ok ? 'received' : 'failed', ...(result.ok && result.readReceipt ? { read: result.readReceipt } : {}), ...(result.ok && call.name === 'task.send' && call.input && typeof call.input === 'object' && (call.input as Record<string, unknown>).id === step.snapshot.task.parentId && typeof (call.input as Record<string, unknown>).message === 'string' ? { report: { text: String((call.input as Record<string, unknown>).message) } } : {}) });
      if (skipped) ports.evidence?.notRun?.(step, call);
      else if (ports.evidence) observeSync('prediction', { phase: 'observed', ok: result.ok }, () => ports.evidence!.observed(step, call, result));
      if (skipped) {
        notRun.add(call.id);
        results.push({ id: call.id, text: result.text, ok: false });
        continue;
      }
      ports.body?.noteResult?.(call, result, performance.now() - toolStarted);
      ports.tools?.progress?.observed(operationId, call.name, result);
      if (!result.ok && bodyAction(call.name)) earlierFailed = true;
      if (!await stillFresh()) bodyStale = true;
      // A transient body task stores the cut text of a body result (`minecraftStoredResult.ts`); everything else here saw the whole one.
      const stored = selection?.obsMode === 'transient' && ports.body?.storedResult ? ports.body.storedResult(call, result.text) : result.text;
      results.push({ id: call.id, text: stored, ok: result.ok });
      if (result.bodyReflex) reflexCuts.add(call.id);
      if (selection) {
        if (!result.ok) selection.refresh = true;
        selection.recentResults = [...selection.recentResults, { name: call.name, ok: result.ok, summary: result.text.slice(0, 1_000) }].slice(-8);
      }
    }
    if (!bodyStale) {
      const outcomes = decision.calls.flatMap((call, index) => ['goal.set_conditions', 'goal.verify', 'task.replan'].includes(call.name) || notRun.has(call.id)
        ? [] : [{ call, result: results[(output.auxiliaryResults?.length ?? 0) + index]! }]);
      // A cut call does not count until the same tool (or any) has been cut off too many times in a row; any outcome of its own ends the
      // run, but a read that worked beside or between cuts does not (`fcaReflexCuts.ts`, M2).
      ({ failures: consecutiveToolFailures, run: reflexRun, byCuts: failedByCuts } = settleReflexStep(consecutiveToolFailures, reflexRun, outcomes.map(outcome => ({
        name: outcome.call.name, ok: outcome.result.ok, cut: reflexCuts.has(outcome.call.id),
        read: catalog.find(tool => tool.name === outcome.call.name)?.effect === 'read' }))));
    }
    history.push(ports.model.toolResults(results));
  }
  if (disposition === 'complete' && (step.snapshot.task.kind === 'root' ||
    (runtime.get(step.scopeKey, step.taskId)?.childIds ?? []).some(id => {
      const child = runtime.get(step.scopeKey, id); return child && !['completed', 'failed'].includes(child.phase);
    }))) disposition = 'wait';
  // A wait nobody can answer is turned away a bounded number of times, then committed and the task stopped (below).
  const gated = waitGate.apply(disposition);
  disposition = gated.disposition;
  await checked();
  if (disposition === 'complete' && !bodyStale && ports.tools?.progress) await metrics.timed('verifyMs', async () => {
    // Final native evidence must not race a new reflex using this same enclosing lease.
    // Stop and drain the physical monitor first; keep the task inbox monitor observing.
    await ports.body?.close();
    if (ports.body && !await ports.body.guard(bodyRevision)) bodyStale = true;
    if (!bodyStale) {
      const verification = await ports.tools!.progress!.verifyCompletion({ scopeKey: step.scopeKey, taskId: step.taskId, operationId: `${step.id}:completion`, name: 'goal.verify', input: {}, signal }, checked);
      if (verification.status === 'not_verified') { disposition = 'continue'; completionRejected = true; completionVerificationFailures++; }
      else completionVerificationFailures = 0;
    }
  });
  // No detached recall may keep spending after the segment's completion receipt becomes visible.
  await metrics.timed('closeMs', async () => ports.recall?.finishSegment(step.scopeKey, step.taskId));
  if (!await stillFresh()) bodyStale = true;
  await metrics.timed('closeMs', () => closeFcaMonitors(ports));
  if (!await stillFresh()) bodyStale = true;
  if (bodyStale) { disposition = 'continue'; consecutiveToolFailures = priorToolFailures; reflexRun = priorReflexRun; failedByCuts = false; }
  await checked();
  observerHandoff(decision.kind === 'tools' ? 'tools' : 'llm', 'store', provenance);
  const saved = metrics.timedSync('commitMs', () => observeSync('store', provenance, () => runtime.commitStep(step, {
    history, disposition, checkpoint: { ...prior, ...(prior.fcaHeldRetries ? { fcaHeldRetries: 0 } : {}), ...(prior.fcaProviderRetries ? { fcaProviderRetries: 0 } : {}), ...ports.checkpoint?.(), ...ports.tools?.checkpoint?.(), ...(maintenance ? {} : metrics.checkpoint()), consecutiveToolFailures, ...reflexCutCheckpoint(reflexRun, prior), ...(ports.tools?.progress ? { completionVerificationFailures } : {}), ...(gated.refusedWaits ? { fcaWaitRefusals: gated.refusedWaits } : {}), ...(recallContext ? { fcaRecallInput: recallContext.checkpoint } : {}), ...(selection ? { fcaToolSelection: selection } : {}), ...(output.stateCut !== undefined ? { fcaStateCut: output.stateCut } : {}) }, ...(decision.kind !== 'tools' && !bodyStale ? { summary: completionRejected ? '完了条件を新しい観測でまだ確認できません。' : decision.summary } : {}),
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
  if (consecutiveToolFailures >= 5 || completionVerificationFailures >= 5) {
    runtime.stop(step.scopeKey, step.taskId, consecutiveToolFailures >= 5 ? repeatedFailureReason(failedByCuts) : 'repeated_tool_failure');
    return runtime.snapshot(step.scopeKey, step.taskId)!;
  }
  return saved;
}

async function closeFcaMonitors(ports: FcaStepPorts): Promise<void> {
  const results = await Promise.allSettled([ports.body?.close(), ...(ports.observations ?? []).map(observation => observation.close())]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
