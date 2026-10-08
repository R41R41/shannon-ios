import type { TaskRuntime, TaskStep, TaskSnapshot } from '../taskRuntime/taskRuntimePorts.js';
import { TASK_TOOLS, executeTaskTool } from '../../tools/toolRunnerPorts.js';
import { observeAsync, observerHandoff, observeSync } from '../../../infra/observer/observerContext.js';
import type { FcaModel } from './fcaPorts.js';

export interface FcaStepPorts {
  runtime: TaskRuntime; model: FcaModel;
  ownerAlone(): boolean;
  /** Existing lease/resource gate, rechecked before each model or tool operation. */
  permit(): Promise<boolean>;
}
/** One bounded model decision; waiting and completed segments release their inference slot in wiring. */
export async function runFcaStep(step: TaskStep, ports: FcaStepPorts, signal: AbortSignal): Promise<TaskSnapshot> {
  const { runtime } = ports;
  const checked = async () => {
    signal.throwIfAborted();
    if (!ports.ownerAlone() || !await ports.permit()) throw new Error('FCA_EXECUTION_HELD');
    signal.throwIfAborted();
    if (runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
  };
  await checked();
  const provenance = { taskId: step.taskId, parentId: step.snapshot.task.parentId, stepId: step.id, revision: step.revision };
  const input = observeSync('context', provenance, () => ({
    task: step.snapshot.task, messages: step.snapshot.messages,
    children: step.snapshot.task.childIds.flatMap(id => {
      const child = runtime.get(step.scopeKey, id);
      return child ? [{ id: child.id, title: child.title, phase: child.phase, summary: child.summary }] : [];
    }),
    history: step.snapshot.history, tools: TASK_TOOLS,
  }), () => ({ ...provenance, tools: TASK_TOOLS.map(tool => tool.name), messages: step.snapshot.messages.length }));
  observerHandoff('context', 'native', provenance);
  const output = await ports.model.decide(input, signal);
  await checked();
  const history = [...output.history];
  const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object'
    ? step.snapshot.checkpoint as Record<string, unknown> : {};
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
      observerHandoff('llm', 'gate', { ...provenance, operationId, tool: call.name });
      const result = await observeAsync('tools', { ...provenance, operationId, tool: call.name }, async () =>
        executeTaskTool(runtime, call.name, call.input, { scopeKey: step.scopeKey, taskId: step.taskId, operationId, ownerAlone: ports.ownerAlone }),
      value => ({ ...provenance, operationId, ok: value.ok, failure: value.failure ?? null }));
      results.push({ id: call.id, text: result.text, ok: result.ok });
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
    history, disposition, checkpoint: { ...prior, consecutiveToolFailures }, ...(decision.kind !== 'tools' ? { summary: decision.summary } : {}),
  }), value => ({ ...provenance, committed: value !== null, phase: value?.task.phase ?? null }));
  if (!saved) throw new Error('FCA_COMMIT_FENCED');
  if (consecutiveToolFailures >= 5) {
    runtime.stop(step.scopeKey, step.taskId, 'repeated_tool_failure');
    return runtime.snapshot(step.scopeKey, step.taskId)!;
  }
  return saved;
}
