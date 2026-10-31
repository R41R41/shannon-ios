import type { TaskRuntime, TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';

/** Attach every displayed task's provenance before any context is released. */
export function inheritObservedTaskSources(runtime: TaskRuntime, step: TaskStep, ids: readonly string[]): boolean {
  // The store bounds one attachment to 100 tasks; a root's retained history can exceed it.
  // Keep every source and fail before releasing context if any group is refused.
  for (let offset = 0; offset < ids.length; offset += 100) {
    if (!runtime.inheritTaskSources(step, ids.slice(offset, offset + 100))) return false;
    step.snapshot.sources = runtime.taskSources(step.scopeKey, step.taskId, step.messageIds);
  }
  return true;
}
