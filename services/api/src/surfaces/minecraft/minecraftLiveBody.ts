import type { FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import type { TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from './minecraftControl.js';
import type { MinecraftLiveSink } from './minecraftLive.js';
import { minecraftMilestones } from './minecraftReflexAdapter.js';

/**
 * A Minecraft task's body told to the conversations' view of her body (session dc-live; `SHANNON_MINECRAFT_LIVE`). Like
 * `withMinecraftWorking` it wraps the body instead of growing it: at each decision it says which task this is, while a tool runs it says
 * which, and when the step ends it says so. Nothing it does can change a decision or fail a step: every call into the view is caught.
 */
export function withMinecraftLive<Made extends { body: FcaBodyLifecycle }>(made: Made, parts: {
  live: MinecraftLiveSink | undefined; control: MinecraftControl; step: TaskStep;
}): Made {
  const { live, control, step } = parts, inner = made.body;
  if (!live) return made;
  const kept = (step.snapshot.checkpoint as { minecraftMilestones?: unknown } | null)?.minecraftMilestones;
  let nether: boolean | null = minecraftMilestones({ milestones: kept })?.netherReached ?? null;
  const told = (work: () => void) => {
    try { work(); } catch { /* the view never fails a step */ }
  };
  const body: FcaBodyLifecycle = {
    ...inner,
    context() {
      const value = inner.context();
      told(() => live.begin({ taskId: step.taskId, scopeKey: step.scopeKey, goal: step.snapshot.task.goal.slice(0, 120), origin: step.snapshot.task.origin,
        createdAtMs: Date.parse(step.snapshot.task.createdAt),
        bodyId: control.store.body(step.taskId) ?? (control.available().length === 1 ? control.available()[0]! : null),
        netherReached: nether }));
      return value;
    },
    noteCall(call, operationId) {
      inner.noteCall?.(call, operationId);
      if (call.name.startsWith('mc.')) told(() => live.activity(step.taskId, { name: call.name, input: call.input }));
    },
    noteResult(call, result, durationMilliseconds) {
      inner.noteResult?.(call, result, durationMilliseconds);
      if (call.name.startsWith('mc.')) told(() => live.activity(step.taskId, null));
      if (call.name === 'mc.goal-evidence' && result.ok) nether = minecraftMilestones(result.text)?.netherReached ?? nether;
    },
    async close() {
      told(() => live.end(step.taskId));
      await inner.close();
    },
  };
  return { ...made, body };
}
