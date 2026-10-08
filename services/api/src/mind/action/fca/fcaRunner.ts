import type { TaskRuntime, TaskStep, TaskSnapshot } from '../taskRuntime/taskRuntimePorts.js';
import { TASK_TOOLS, executeTaskTool } from '../../tools/toolRunnerPorts.js';
import { observeAsync, observerHandoff, observeSync } from '../../../infra/observer/observerContext.js';
import { observedToolName } from '../../../infra/models/anthropic/observerProjection.js';
import type { FcaToolSelector } from '../../selectors/selectorsPorts.js';
import { TOOL_OPEN_NAME, toolFailure } from '../../tools/toolRegistryPorts.js';
import type { FcaExternalTools, FcaModel } from './fcaPorts.js';
import { openFcaTool, selectFcaTools, selectedFcaTools } from './fcaToolState.js';
import { prepareFcaHistory } from './fcaHistory.js';
import type { FcaHistoryCodec, FcaHistoryPolicy, FcaHistorySummarizer } from './fcaHistoryPorts.js';

export interface FcaStepPorts {
  runtime: TaskRuntime; model: FcaModel;
  ownerAlone(): boolean;
  /** Existing lease/resource gate, rechecked before each model or tool operation. */
  permit(): Promise<boolean>;
  selector?: FcaToolSelector;
  tools?: FcaExternalTools;
  history?: { codec: FcaHistoryCodec; summarizer?: FcaHistorySummarizer; policy?: Partial<FcaHistoryPolicy> };
  /** Rechecks only the sources pinned to this admitted step, never newly pending inbox input. */
  sourcesVisible?(): boolean;
  /** Disclosure for another task's list/get/send projection. */
  taskVisible?(taskId: string): boolean;
  /** Persist source lineage before another task's successful projection enters this round. */
  observeTasks?(taskIds: readonly string[]): boolean;
}
/** One bounded model decision; waiting and completed segments release their inference slot in wiring. */
export async function runFcaStep(step: TaskStep, ports: FcaStepPorts, signal: AbortSignal): Promise<TaskSnapshot> {
  const { runtime } = ports;
  const checked = async () => {
    signal.throwIfAborted();
    if (!ports.ownerAlone()) throw new Error('FCA_EXECUTION_HELD');
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
    if (!await ports.permit()) throw new Error('FCA_EXECUTION_HELD');
    signal.throwIfAborted();
    if (!ports.ownerAlone()) throw new Error('FCA_EXECUTION_HELD');
    if (ports.sourcesVisible && !ports.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
    if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
  };
  await checked();
  const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object'
    ? step.snapshot.checkpoint as Record<string, unknown> : {};
  const catalog = [...TASK_TOOLS, ...(ports.tools?.definitions ?? [])];
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
  }, () => ({ ...provenance, tools: catalog.map(tool => observedToolName(tool.name)), messages: step.snapshot.messages.length }));
  await checked();
  const selection = ports.selector ? await selectFcaTools(input, catalog, prior.fcaToolSelection, ports.selector, step.scopeKey, signal) : null;
  if (selection) {
    input.tools = selectedFcaTools(catalog, selection);
  }
  await checked();
  observerHandoff('context', 'native', provenance);
  const output = await ports.model.decide({ ...input, ...(selection ? { catalog: catalog.map(tool => ({ name: tool.name, description: tool.description })) } : {}) }, signal);
  await checked();
  const history = [...output.history];
  let consecutiveToolFailures = Number(prior.consecutiveToolFailures ?? 0);
  if (!Number.isSafeInteger(consecutiveToolFailures) || consecutiveToolFailures < 0) consecutiveToolFailures = 0;
  const decision = output.decision;
  let disposition: 'continue' | 'wait' | 'complete' = decision.kind === 'tools' ? 'continue' : decision.kind;
  if (decision.kind === 'tools') {
    if (!decision.calls.length || decision.calls.length > 8 || new Set(decision.calls.map(call => call.id)).size !== decision.calls.length) throw new Error('FCA_INVALID_CALLS');
    const results: Array<{ id: string; text: string; ok: boolean }> = [];
    for (const call of decision.calls) {
      await checked();
      const operationId = `${step.id}:${call.id}`;
      const tool = call.name === TOOL_OPEN_NAME ? 'tool_open' : observedToolName(call.name);
      observerHandoff('llm', 'gate', { ...provenance, operationId, tool });
      const result = await observeAsync('tools', { ...provenance, operationId, tool }, async () => {
        if (call.name === TOOL_OPEN_NAME && selection) return openFcaTool(call.input, catalog, selection);
        if (selection && !input.tools.some(definition => definition.name === call.name)) return toolFailure('not_offered', '定義が必要な道具は、先に tool_open で開いてください。');
        if (ports.tools?.definitions.some(definition => definition.name === call.name)) {
          // Never turn an unknown outside outcome into a retryable tool result.
          return ports.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId, name: call.name, input: call.input, signal });
        }
        return executeTaskTool(runtime, call.name, call.input, { scopeKey: step.scopeKey, taskId: step.taskId, operationId,
          ownerAlone: ports.ownerAlone, ...(ports.taskVisible ? { visible: ports.taskVisible } : {}),
          ...(ports.observeTasks ? { observed: ports.observeTasks } : {}) });
      },
      value => ({ ...provenance, operationId, ok: value.ok, failure: value.failure ?? null }));
      results.push({ id: call.id, text: result.text, ok: result.ok });
      if (selection) {
        if (!result.ok) selection.refresh = true;
        selection.recentResults = [...selection.recentResults, { name: call.name, ok: result.ok, summary: result.text.slice(0, 1_000) }].slice(-8);
      }
    }
    consecutiveToolFailures = results.every(result => !result.ok) ? consecutiveToolFailures + 1 : 0;
    history.push(ports.model.toolResults(results));
  }
  if (disposition === 'complete' && (step.snapshot.task.kind === 'root' ||
    (runtime.get(step.scopeKey, step.taskId)?.childIds ?? []).some(id => {
      const child = runtime.get(step.scopeKey, id); return child && !['completed', 'failed'].includes(child.phase);
    }))) disposition = 'wait';
  await checked();
  observerHandoff(decision.kind === 'tools' ? 'tools' : 'llm', 'store', provenance);
  const saved = observeSync('store', provenance, () => runtime.commitStep(step, {
    history, disposition, checkpoint: { ...prior, consecutiveToolFailures, ...(selection ? { fcaToolSelection: selection } : {}) }, ...(decision.kind !== 'tools' ? { summary: decision.summary } : {}),
  }), value => ({ ...provenance, committed: value !== null, phase: value?.task.phase ?? null }));
  if (!saved) throw new Error('FCA_COMMIT_FENCED');
  if (consecutiveToolFailures >= 5) {
    runtime.stop(step.scopeKey, step.taskId, 'repeated_tool_failure');
    return runtime.snapshot(step.scopeKey, step.taskId)!;
  }
  return saved;
}
