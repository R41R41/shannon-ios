import type { FcaSourceGuard, FcaWalkCaller } from '../mind/action/fca/fcaConversationPorts.js';
import type { TaskRuntime, TaskSource, TaskStep, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * The two callers that ask every second and only need to learn of a verdict already made (`FcaSourceGuard.peek`): they never walk
 * the task's provenance. False means the guard knows the task is withheld; "not known" (no verdict kept for the current state) is
 * not a reason to stop anything here, because nothing is revealed or done on their word:
 *
 * - the observation monitor only fences a step (a stale revision, or a thrown `FCA_SOURCE_WITHHELD`). What a step shows or does is
 *   gated by the whole check (`guard.sources`): the runner's `checked()` before and after the model and before each tool and before
 *   the commit, each tool's own gate, the progress permit and the body's lease check.
 * - the scheduler's gate only skips a ready task already known to be withheld; `execute` asks the whole check (`canRunTask`) before
 *   a task is admitted.
 */
export function peekedVisible(guard: FcaSourceGuard | undefined, scopeKey: string, task: TaskView,
  sources: readonly TaskSource[], whole: () => boolean): boolean {
  return guard?.peek ? guard.peek(scopeKey, task, sources) !== false : whole();
}

/** A step's own checks of its provenance: the whole one naming its caller (undefined without a guard), and the walk-free one. */
export function stepVisibility(guard: () => FcaSourceGuard | undefined, step: TaskStep) {
  const whole = (via: FcaWalkCaller) => guard()?.sources(step.scopeKey, step.snapshot.task, step.snapshot.sources ?? [], undefined, via);
  const peek = () => peekedVisible(guard(), step.scopeKey, step.snapshot.task, step.snapshot.sources ?? [],
    () => whole('step') ?? (step.snapshot.sources ?? []).length === 0);
  return { whole, peek };
}

/**
 * Whether a task may start (`canRunTask`: the whole check, asked where it is admitted) and whether the once-a-second scheduler may
 * go on to admit it (`canScheduleTask`: walks nothing). Own-time and sleep tasks keep their own gates, which walk nothing.
 */
export function taskGates(parts: { ownerScope: string; guard(): FcaSourceGuard | undefined; sleepVisible(runtime: TaskRuntime, task: TaskView): boolean }) {
  const whole = (runtime: TaskRuntime, id: string): boolean => {
    const task = runtime.get(parts.ownerScope, id), sources = () => runtime.taskSources(parts.ownerScope, id).length === 0;
    if (task?.origin === 'own_time') return sources();
    return task?.kind === 'sleep' ? parts.sleepVisible(runtime, task) : parts.guard()?.(parts.ownerScope, id, undefined, 'task') ?? sources();
  };
  return { canRunTask: whole, canScheduleTask: scheduleGate({ ownerScope: parts.ownerScope, guard: parts.guard, whole }) };
}

/** The scheduler's gate on its own: the walk-free verdict for a foreground task, the whole gate for any other. */
export function scheduleGate(parts: { ownerScope: string; guard(): FcaSourceGuard | undefined; whole(runtime: TaskRuntime, id: string): boolean }) {
  return (runtime: TaskRuntime, id: string): boolean => {
    const task = runtime.get(parts.ownerScope, id), guard = parts.guard();
    if (!task || task.origin === 'own_time' || task.kind === 'sleep' || !guard?.peek) return parts.whole(runtime, id);
    return peekedVisible(guard, parts.ownerScope, task, runtime.taskSources(parts.ownerScope, id), () => parts.whole(runtime, id));
  };
}
