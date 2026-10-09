import type { TaskRuntime } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { TaskProgress } from '../../mind/action/taskRuntime/taskProgressPorts.js';

/** Only public task metadata and executor receipts. History/inbox/checkpoints never cross this route. */
export function fcaNowProjection(runtime: TaskRuntime, scope: string, visible: (id: string) => boolean, progress?: (id: string) => TaskProgress | null) {
  const tasks = runtime.list(scope, { order: 'recent', limit: 100 }).filter(task => !['root', 'conversation'].includes(task.kind) && visible(task.id)).slice(0, 50);
  let receiptCharacters = 100_000;
  const bounded = <T>(value: T): T | undefined => { const size = JSON.stringify(value).length; if (size > receiptCharacters) return undefined; receiptCharacters -= size; return value; };
  return { generatedAt: new Date().toISOString(), tasks: tasks.map(task => {
    const observed = progress?.(task.id);
    const report = observed?.report ? bounded(observed.report) : undefined;
    const places = observed?.places ? bounded(observed.places) : undefined;
    const findings = observed?.findings.slice(-4).flatMap(finding => { const item = bounded({ ...finding, text: finding.text.slice(0, 600), sources: finding.sources.slice(0, 4) }); return item ? [item] : []; });
    const sourceThreadId = runtime.taskSources(scope, task.id).find(source => source.threadId)?.threadId;
    return { id: task.id, parentId: task.parentId, kind: task.kind, origin: task.origin, title: task.title.slice(0, 160),
      phase: task.phase, summary: task.summary.slice(0, 1000), revision: task.revision, updatedAt: task.updatedAt,
      ...(sourceThreadId ? { sourceThreadId } : {}), ...(observed ? { currentStep: observed.currentStep,
        startedAt: observed.startedAt, progressStatus: observed.status, observedAt: observed.updatedAt,
        findings, ...(report ? { report } : {}), ...(places ? { places } : {}) } : {}) };
  }) };
}
