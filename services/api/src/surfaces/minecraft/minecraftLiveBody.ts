import type { FcaBodyLifecycle } from '../../mind/action/fca/fcaPorts.js';
import type { TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { BodyPlanView } from '../../contracts/bodyControlContract.js';
import type { MinecraftControl } from './minecraftControl.js';
import type { MinecraftLiveSink } from './minecraftLive.js';
import { workingNode } from './minecraftLlmcNode.js';
import { minecraftMilestones } from './minecraftReflexAdapter.js';

/**
 * A Minecraft task's body told to the conversations' view of her body (session dc-live; `SHANNON_MINECRAFT_LIVE`). Like
 * `withMinecraftWorking` it wraps the body instead of growing it: at each decision it says which task this is, while a tool runs it says
 * which, and when the step ends it says so. Nothing it does can change a decision or fail a step: every call into the view is caught.
 */
export function withMinecraftLive<Made extends { body: FcaBodyLifecycle }>(made: Made, parts: {
  live: MinecraftLiveSink | undefined; control: MinecraftControl; step: TaskStep;
  /** The plan she keeps (the step's `llmc.plan`): a change of it is something she can say. Absent: no plan to read. */
  plan?: () => BodyPlanView | undefined;
  /** The task's phase now: the end of a request is told from it. */
  phase?: () => string | null;
}): Made {
  const { live, control, step } = parts, inner = made.body;
  if (!live) return made;
  const kept = (step.snapshot.checkpoint as { minecraftMilestones?: unknown } | null)?.minecraftMilestones;
  let nether: boolean | null = minecraftMilestones({ milestones: kept })?.netherReached ?? null;
  const told = (work: () => void) => {
    try { work(); } catch { /* the view never fails a step */ }
  };
  // What her calls say of her work: a promise of the plan and a `keep` of an act are what a step needs; an act's `why` is what she means by it.
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  // An act's `keep` is a line `品目:数:用途` (the short form the model writes; the use may hold colons), or an entry of the JSON form.
  const keepLine = /^([^:\s]+)\s*:\s*(\d+)\s*:\s*(\S[\s\S]*)$/u;
  const needed = (entry: unknown) => {
    if (typeof entry === 'string') {
      const read = keepLine.exec(entry.trim().replace(/^["']+|["']+$/gu, ''));
      if (read) live.need?.(step.taskId, { item: read[1]!, count: Number(read[2]), use: read[3]!.trim() });
      return;
    }
    const row = record(entry);
    if (row && typeof row.item === 'string' && typeof row.count === 'number') live.need?.(step.taskId, { item: row.item, count: row.count, use: String(row.use ?? '') });
  };
  // A promise of the plan is a need once the plan took it (a refused one is not something she needs).
  const promised = (call: { name: string; input: unknown }) => {
    const input = record(call.input);
    if (call.name !== 'plan.update' || !input) return;
    for (const op of Array.isArray(input.ops) ? input.ops : []) if (record(op)?.op === 'promise') needed(op);
  };
  const saying = (call: { name: string; input: unknown }) => {
    const input = record(call.input);
    if (!input) return;
    if (call.name === 'mc.act') {
      for (const entry of Array.isArray(input.keep) ? input.keep : typeof input.keep === 'string' ? input.keep.split(/[,\n]/u) : []) needed(entry);
      if (typeof input.why === 'string') live.thought?.(step.taskId, input.why);
    }
  };
  const body: FcaBodyLifecycle = {
    ...inner,
    context() {
      const value = inner.context();
      told(() => live.begin({ taskId: step.taskId, scopeKey: step.scopeKey, goal: step.snapshot.task.goal.slice(0, 120), origin: step.snapshot.task.origin,
        createdAtMs: Date.parse(step.snapshot.task.createdAt),
        bodyId: control.store.body(step.taskId) ?? (control.available().length === 1 ? control.available()[0]! : null),
        netherReached: nether, ...(parts.phase ? { phase: parts.phase } : {}),
        // The node the model last started work for, as the body's mod shows it (`workingNode`): read when a conversation asks, not at each decision.
        ...(parts.plan ? { working: () => workingNode(step.taskId, parts.plan?.()?.current) } : {}) }));
      // The plan as the head's own checks left it since the last decision (a node seen done is a step she may say).
      told(() => live.plan?.(step.taskId, parts.plan?.()));
      return value;
    },
    noteCall(call, operationId) {
      inner.noteCall?.(call, operationId);
      if (call.name.startsWith('mc.')) told(() => live.activity(step.taskId, { name: call.name, input: call.input }));
      told(() => saying(call));
    },
    noteResult(call, result, durationMilliseconds) {
      inner.noteResult?.(call, result, durationMilliseconds);
      if (call.name.startsWith('mc.')) told(() => live.activity(step.taskId, null));
      if (call.name === 'plan.update' && result.ok) told(() => promised(call));
      if (call.name === 'plan.update' || call.name === 'mc.act') told(() => live.plan?.(step.taskId, parts.plan?.()));
      if (call.name === 'mc.goal-evidence' && result.ok) nether = minecraftMilestones(result.text)?.netherReached ?? nether;
    },
    async close() {
      told(() => live.end(step.taskId));
      await inner.close();
    },
  };
  return { ...made, body };
}
