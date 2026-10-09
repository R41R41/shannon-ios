import { createHash } from 'node:crypto';
import { createFcaObservationMonitor } from '../mind/action/fca/fcaObservation.js';
import type { TaskRuntime, TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
/** Monitor canonical task authority independently while inference awaits; never poll copied task text. */
export function createFcaTaskObservationMonitor(parts: {
  runtime: TaskRuntime; step: TaskStep; allowed(): boolean; sourcesVisible(): boolean;
  taskVisible(id: string): boolean; observeTasks(ids: readonly string[]): boolean;
  intervalMilliseconds?: number;
}) {
  const { runtime, step } = parts;
  let pinnedChildren = '';
  return createFcaObservationMonitor({
    ...(parts.intervalMilliseconds ? { intervalMilliseconds: parts.intervalMilliseconds } : {}),
    async read(signal) {
      signal.throwIfAborted();
      if (!parts.allowed() || !parts.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
      const task = runtime.get(step.scopeKey, step.taskId);
      if (!task || task.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
      const children = task.childIds.flatMap(id => {
        const child = runtime.get(step.scopeKey, id);
        return child && parts.taskVisible(id) ? [{ id: child.id, phase: child.phase, summaryDigest: createHash('sha256').update(child.summary).digest('hex') }] : [];
      });
      const childGeneration = JSON.stringify(children);
      if (children.length && childGeneration !== pinnedChildren && !parts.observeTasks(children.map(child => child.id))) throw new Error('FCA_SOURCE_WITHHELD');
      pinnedChildren = childGeneration;
      if (!parts.allowed() || !parts.sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
      const data = { taskId: task.id, pendingMessageIds: runtime.pendingMessageIds?.(step.scopeKey, step.taskId) ?? step.messageIds, children }; 
      return { generation: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data, sourceIds: [] };
    },
    observeSources: () => parts.allowed() && parts.sourcesVisible(),
    // Canonical inbox/child changes fence the next decision; no unknown outside effect is locally cancelled.
    interruptible: () => false,
  });
}
