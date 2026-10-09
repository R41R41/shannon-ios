import type { TaskRuntime, TaskStep, TaskSnapshot } from '../taskRuntime/taskRuntimePorts.js';
import { TASK_TOOLS, executeTaskTool } from '../../tools/toolRunnerPorts.js';
import { observeAsync, observerHandoff, observeSync, withObserverTask } from '../../../infra/observer/observerContext.js';
import { observedToolName } from '../../../infra/models/anthropic/observerProjection.js';
import type { FcaToolSelector } from '../../selectors/selectorsPorts.js';
import { TOOL_OPEN_NAME, toolFailure } from '../../tools/toolRegistryPorts.js';
import type { TaskRecall } from '../../recall/taskRecallPorts.js';
import type { FcaEvidence } from './fcaEvidencePorts.js';
import { fcaRecallContext } from './fcaRecallContext.js';
import type { FcaBodyLifecycle, FcaExternalTools, FcaModel } from './fcaPorts.js';
import { openFcaTool, selectFcaTools, selectedFcaTools } from './fcaToolState.js';
import { prepareFcaHistory } from './fcaHistory.js';
import type { FcaHistoryCodec, FcaHistoryPolicy, FcaHistorySummarizer } from './fcaHistoryPorts.js';

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
  recall?: TaskRecall;
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
}
/** One bounded model decision; waiting and completed segments release their inference slot in wiring. */
export async function runFcaStep(step: TaskStep, ports: FcaStepPorts, signal: AbortSignal): Promise<TaskSnapshot> {
  return withObserverTask({ taskId: step.taskId, parentTaskId: step.snapshot.task.parentId, stepId: step.id, actionId: step.lease.id }, () =>
    observeAsync('fca', { phase: 'step', kind: step.snapshot.task.kind, revision: step.revision }, async () => {
      try { ports.body?.start(signal); return await executeFcaStep(step, ports, signal); }
      finally { try { await ports.body?.close(); } finally { await ports.recall?.finishSegment(step.scopeKey, step.taskId); } }
    }, value => ({ phase: value.task.phase, revision: value.revision })));
}
async function executeFcaStep(step: TaskStep, ports: FcaStepPorts, signal: AbortSignal): Promise<TaskSnapshot> {
  const { runtime } = ports;
  const maintenance = step.snapshot.task.origin === 'maintenance' && step.snapshot.task.kind === 'sleep';
  const allowed = () => maintenance ? ports.executionAllowed?.() === true : ports.ownerAlone() && (ports.executionAllowed?.() ?? true);
  const checked = () => observeAsync('gate', { phase: 'step_permit' }, async () => {
    signal.throwIfAborted();
    if (!allowed()) throw new Error('FCA_EXECUTION_HELD');
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
    if (!await ports.permit()) throw new Error('FCA_EXECUTION_HELD');
    signal.throwIfAborted();
    if (!allowed()) throw new Error('FCA_EXECUTION_HELD');
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
    if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
  }, () => ({ allowed: true }));
  await checked();
  const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object'
    ? step.snapshot.checkpoint as Record<string, unknown> : {};
  const recallContext = ports.recall ? fcaRecallContext(step, prior, signal) : null;
  if (recallContext) { observerHandoff('fca', 'recall', { phase: 'start' }); ports.recall!.start(recallContext.input); }
  const catalog = [...(maintenance || ports.taskTools === false ? [] : TASK_TOOLS), ...(ports.tools?.definitions ?? [])];
  if (new Set(catalog.map(tool => tool.name)).size !== catalog.length || catalog.some(tool => tool.name === TOOL_OPEN_NAME)) throw new Error('FCA_TOOL_CATALOG_INVALID');
  const replay = ports.history ? await prepareFcaHistory(step, {
    runtime, codec: ports.history.codec, summarizer: ports.history.summarizer,
    permit: async () => { await checked(); return true; }, sourcesVisible: () => ports.sourcesVisible?.() ?? true,
  }, signal, ports.history.policy) : null;
  const provenance = { taskId: step.taskId, parentId: step.snapshot.task.parentId, stepId: step.id, revision: step.revision };
  const input = observeSync('context', provenance, () => {
    const children = step.snapshot.task.childIds.flatMap(id => {
      const child = runtime.get(step.scopeKey, id);
      return child && (!ports.taskVisible || ports.taskVisible(id)) ? [{ id: child.id, title: child.title, phase: child.phase, summary: child.summary }] : [];
    });
    if (children.length && ports.observeTasks && !ports.observeTasks(children.map(child => child.id))) throw new Error('FCA_SOURCE_WITHHELD');
    return { task: step.snapshot.task, messages: step.snapshot.messages, children,
      history: replay?.history ?? step.snapshot.history, tools: catalog };
  }, () => ({ ...provenance, tools: catalog.map(tool => observedToolName(tool.name, catalog)), messages: step.snapshot.messages.length }));
  await checked();
  const selection = ports.selector ? await selectFcaTools(input, catalog, prior.fcaToolSelection, ports.selector, step.scopeKey, signal) : null;
  if (selection) {
    input.tools = selectedFcaTools(catalog, selection);
  }
  await checked();
  const recall = recallContext ? await observeAsync('recall', { phase: 'decision_packet', maximumWaitMs: recallContext.waitMilliseconds },
    () => ports.recall!.packet(recallContext.input, { waitMilliseconds: recallContext.waitMilliseconds }),
    value => ({ status: value.status, itemCount: value.items.length, sourceCount: value.sourceIds.length })) : undefined;
  if (recall?.sourceIds.length && (!ports.observeMemory || !ports.observeMemory(recall.sourceIds))) throw new Error('FCA_SOURCE_WITHHELD');
  await checked();
  if (recall) observerHandoff('recall', 'context', { phase: 'decision_packet', status: recall.status, itemCount: recall.items.length, sourceCount: recall.sourceIds.length });
  const sharedContext = ports.evidence ? observeSync('emotion', { phase: 'shared_context' }, () => ports.evidence!.prepare(step),
    value => ({ outcomeCount: value.recentOutcomes.length })) : undefined;
  if (ports.body) await ports.body.guard(ports.body.revision());
  const bodyRevision = ports.body?.revision() ?? 0;
  observerHandoff('context', 'native', provenance);
  const output = await ports.model.decide({ ...input, ...(ports.body ? { body: ports.body.context() } : {}), ...(recall ? { recall } : {}), ...(sharedContext ? { sharedContext } : {}), ...(selection ? { catalog: catalog.map(tool => ({ name: tool.name, description: tool.description })) } : {}) }, signal);
  await checked();
  let bodyStale = ports.body ? !await ports.body.guard(bodyRevision) : false;
  if (ports.evidence && !observeSync('prediction', { phase: 'before_actions', expectationCount: output.expectations?.length ?? 0, appraisalCount: output.appraisals?.length ?? 0 },
    () => ports.evidence!.beforeActions(step, bodyStale ? { ...output, expectations: [], appraisals: [] } : output), value => ({ accepted: value }))) throw new Error('FCA_EVIDENCE_FENCED');
  const history = [...output.history];
  let consecutiveToolFailures = Number(prior.consecutiveToolFailures ?? 0);
  if (!Number.isSafeInteger(consecutiveToolFailures) || consecutiveToolFailures < 0) consecutiveToolFailures = 0;
  const priorToolFailures = consecutiveToolFailures;
  const decision = output.decision;
  let disposition: 'continue' | 'wait' | 'complete' = decision.kind === 'tools' ? 'continue' : decision.kind;
  if (decision.kind === 'tools') {
    if (!decision.calls.length || decision.calls.length > 8 || new Set(decision.calls.map(call => call.id)).size !== decision.calls.length) throw new Error('FCA_INVALID_CALLS');
    const results: Array<{ id: string; text: string; ok: boolean }> = [...output.auxiliaryResults ?? []];
    for (const call of decision.calls) {
      await checked();
      if (ports.body && !await ports.body.guard(bodyRevision)) bodyStale = true;
      const operationId = `${step.id}:${call.id}`;
      const tool = call.name === TOOL_OPEN_NAME ? 'tool_open' : observedToolName(call.name, catalog);
      observerHandoff('llm', 'gate', { ...provenance, operationId, tool });
      const result = await observeAsync('tools', { ...provenance, operationId, tool }, async () => {
        const staleResult = () => toolFailure('failed', '身体の状態が変わりました。最新の観測から判断し直してください。', { retryable: false });
        if (bodyStale) return staleResult();
        if (call.name === TOOL_OPEN_NAME && selection) return openFcaTool(call.input, catalog, selection);
        if (!catalog.some(definition => definition.name === call.name)) return toolFailure('not_offered', 'このタスクでは利用できない道具です。');
        if (selection && !input.tools.some(definition => definition.name === call.name)) return toolFailure('not_offered', '定義が必要な道具は、先に tool_open で開いてください。');
        if (ports.tools?.definitions.some(definition => definition.name === call.name)) {
          // Never turn an unknown outside outcome into a retryable tool result.
          ports.body?.noteCall?.(call, operationId);
          const operationSignal = ports.body?.toolSignal(call.name, signal) ?? signal;
          try { return await ports.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId, name: call.name, input: call.input, signal: operationSignal }); }
          catch (error) {
            if (operationSignal !== signal && operationSignal.aborted && !signal.aborted && ports.body && !await ports.body.guard(bodyRevision)) {
              bodyStale = true; return staleResult();
            }
            throw error;
          }
        }
        return executeTaskTool(runtime, call.name, call.input, { scopeKey: step.scopeKey, taskId: step.taskId, operationId,
          ownerAlone: ports.ownerAlone, ...(ports.taskVisible ? { visible: ports.taskVisible } : {}),
          ...(ports.observeTasks ? { observed: ports.observeTasks } : {}) });
      },
      value => ({ ...provenance, operationId, ok: value.ok, failure: value.failure ?? null })).catch(error => { ports.evidence?.unknown(step, call); throw error; });
      if (ports.evidence) observeSync('prediction', { phase: 'observed', ok: result.ok }, () => ports.evidence!.observed(step, call, result));
      ports.body?.noteResult?.(call, result);
      if (ports.body && !await ports.body.guard(bodyRevision)) bodyStale = true;
      results.push({ id: call.id, text: result.text, ok: result.ok });
      if (selection) {
        if (!result.ok) selection.refresh = true;
        selection.recentResults = [...selection.recentResults, { name: call.name, ok: result.ok, summary: result.text.slice(0, 1_000) }].slice(-8);
      }
    }
    if (!bodyStale) consecutiveToolFailures = results.slice(output.auxiliaryResults?.length ?? 0).every(result => !result.ok) ? consecutiveToolFailures + 1 : 0;
    history.push(ports.model.toolResults(results));
  }
  if (disposition === 'complete' && (step.snapshot.task.kind === 'root' ||
    (runtime.get(step.scopeKey, step.taskId)?.childIds ?? []).some(id => {
      const child = runtime.get(step.scopeKey, id); return child && !['completed', 'failed'].includes(child.phase);
    }))) disposition = 'wait';
  await checked();
  // No detached recall may keep spending after the segment's completion receipt becomes visible.
  await ports.recall?.finishSegment(step.scopeKey, step.taskId);
  if (ports.body && !await ports.body.guard(bodyRevision)) bodyStale = true;
  await ports.body?.close();
  if (ports.body && !await ports.body.guard(bodyRevision)) bodyStale = true;
  if (bodyStale) { disposition = 'continue'; consecutiveToolFailures = priorToolFailures; }
  await checked();
  observerHandoff(decision.kind === 'tools' ? 'tools' : 'llm', 'store', provenance);
  const saved = observeSync('store', provenance, () => runtime.commitStep(step, {
    history, disposition, checkpoint: { ...prior, ...ports.checkpoint?.(), consecutiveToolFailures, ...(recallContext ? { fcaRecallInput: recallContext.checkpoint } : {}), ...(selection ? { fcaToolSelection: selection } : {}) }, ...(decision.kind !== 'tools' && !bodyStale ? { summary: decision.summary } : {}),
  }), value => ({ ...provenance, committed: value !== null, phase: value?.task.phase ?? null }));
  if (!saved) throw new Error('FCA_COMMIT_FENCED');
  if (saved.task.phase === 'waiting') {
    observerHandoff('store', 'wait', { phase: saved.task.phase });
    observeSync('wait', { phase: 'checkpoint', measured: 'state' }, () => undefined, () => ({ phase: saved.task.phase }));
  }
  // These callbacks drain durable outboxes; their failure must never undo/repeat committed tools.
  try { ports.evidence?.committed(step); } catch { /* Retried by the existing maintenance tick. */ }
  if (saved.task.phase === 'completed' || saved.task.phase === 'failed') ports.recall?.cancel(step.scopeKey, step.taskId);
  if (consecutiveToolFailures >= 5) {
    runtime.stop(step.scopeKey, step.taskId, 'repeated_tool_failure');
    return runtime.snapshot(step.scopeKey, step.taskId)!;
  }
  return saved;
}
