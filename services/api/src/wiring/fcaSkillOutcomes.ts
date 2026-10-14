import { fcaSkillTaskKey, type SkillMemory } from '../mind/memory/memoryPorts.js';
import type { TaskPhase } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';

/**
 * The body's own milestones on the way (`mc.goal-evidence` → `milestones`, R41R41/Shannon 4b047cf): the Nether stood in and the
 * blaze rods carried. Null is unknown (an unreadable count), never a failure. Not the goal's proof (`boss.verified` stays that).
 */
interface Milestones { netherReached: boolean | null; blazeRods: number | null }

/**
 * Her skills read by a Minecraft task, judged by what that task then does (Syzygy TI-REQ: trial skills from the old Minebot
 * knowledge must stay when right and retire when wrong). A `skill.read` in the task's loop is one pending use
 * (`SkillMemory.usedInTask`); the task's next outcome settles every use still pending (`settleTask`): a new milestone (the Nether
 * reached, or blaze rods held where there were fewer) or the task completed is 1; the body's death or the task failed is 0. A task stopped,
 * or a read with nothing after it, leaves its uses pending: they judge nothing. The trial itself is judged at night by the
 * existing rule (`SKILL_LIFECYCLE`: three uses, two successes). Process-local: after a restart pending uses stay pending.
 */
export interface FcaSkillOutcomes {
  /** Noted only for a task its loop offers a Minecraft body (bound, or the one body there is). */
  read(scopeKey: string, taskId: string, name: string): void;
  /** The text of a completed `mc.goal-evidence` result for the task. */
  evidence(scopeKey: string, taskId: string, result: string | undefined): void;
  died(bodyId: string): void;
  /** Settles tasks that reached `completed` or `failed`, and forgets stopped ones. */
  tick(phase: (scopeKey: string, taskId: string) => TaskPhase | null): void;
}

const TRACKED = 64;

export function createFcaSkillOutcomes(parts: {
  skills: Pick<SkillMemory, 'usedInTask' | 'settleTask'>;
  /** The Minecraft body a task is bound to, if any. */
  bodyOf(taskId: string): string | null;
  /** The body a task's loop is offered (bound, or the only one connected); default `bodyOf`. */
  offered?(taskId: string): string | null;
  now(): string;
  log?(line: string): void;
}): FcaSkillOutcomes {
  const tasks = new Map<string, { scopeKey: string; taskId: string; reads: boolean; milestones: Milestones | null }>();
  const entry = (scopeKey: string, taskId: string) => {
    const key = `${scopeKey}\n${taskId}`;
    let found = tasks.get(key);
    if (!found) {
      found = { scopeKey, taskId, reads: false, milestones: null };
      tasks.set(key, found);
      if (tasks.size > TRACKED) tasks.delete(tasks.keys().next().value!);
    }
    return found;
  };
  const settle = (scopeKey: string, taskId: string, outcome: 0 | 1, why: string) => {
    try {
      const settled = parts.skills.settleTask(scopeKey, fcaSkillTaskKey(taskId), outcome, parts.now());
      if (settled) parts.log?.(`fca skill uses settled: ${settled} ${why} ${outcome}`);
    } catch { /* learning never fails a task */ }
  };
  return {
    read(scopeKey, taskId, name) {
      try {
        if ((parts.offered ?? parts.bodyOf)(taskId) === null) return;
        if (parts.skills.usedInTask(scopeKey, fcaSkillTaskKey(taskId), name, parts.now())) entry(scopeKey, taskId).reads = true;
      } catch { /* learning never fails a read */ }
    },
    evidence(scopeKey, taskId, result) {
      const next = milestonesOf(result);
      if (!next) return;
      const task = entry(scopeKey, taskId), before = task.milestones;
      // An unknown value keeps what was known; the first known value is the baseline, and only progress after it counts.
      task.milestones = { netherReached: next.netherReached ?? before?.netherReached ?? null, blazeRods: next.blazeRods ?? before?.blazeRods ?? null };
      const nether = before?.netherReached === false && next.netherReached === true;
      const rods = before?.blazeRods !== null && before?.blazeRods !== undefined && next.blazeRods !== null && next.blazeRods > before.blazeRods;
      if (task.reads && (nether || rods)) settle(scopeKey, taskId, 1, nether ? 'nether_reached' : 'blaze_rods');
    },
    died(bodyId) {
      for (const task of tasks.values()) if (task.reads && parts.bodyOf(task.taskId) === bodyId) settle(task.scopeKey, task.taskId, 0, 'death');
    },
    tick(phase) {
      for (const [key, task] of [...tasks]) {
        let current: TaskPhase | null = null;
        try { current = phase(task.scopeKey, task.taskId); } catch { continue; }
        if (current === 'completed' || current === 'failed') {
          if (task.reads) settle(task.scopeKey, task.taskId, current === 'completed' ? 1 : 0, current);
          tasks.delete(key);
        } else if (current === 'stopped' || current === null) tasks.delete(key);
      }
    },
  };
}

/** The Minecraft wiring with its skill outcomes (null while her skills are off), told of each death of a body it controls. */
export function withSkillOutcomes<T extends { control: MinecraftControl }>(minecraft: T | null,
  skills: Pick<SkillMemory, 'usedInTask' | 'settleTask'> | null | undefined, now?: () => string): (T & { skillOutcomes: FcaSkillOutcomes | null }) | null {
  if (!minecraft) return null;
  const { control } = minecraft;
  const skillOutcomes = skills ? createFcaSkillOutcomes({ skills, bodyOf: taskId => control.store.body(taskId),
    offered: taskId => control.store.body(taskId) ?? (control.available().length === 1 ? control.available()[0]! : null),
    now: now ?? (() => new Date().toISOString()), log: line => console.log(line) }) : null;
  if (skillOutcomes) control.deathListeners.add(bodyId => skillOutcomes.died(bodyId));
  return Object.assign(minecraft, { skillOutcomes });
}

function milestonesOf(result: string | undefined): Milestones | null {
  if (!result) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { return null; }
  const value = parsed && typeof parsed === 'object' ? (parsed as { milestones?: unknown }).milestones : undefined;
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  return { netherReached: typeof m.netherReached === 'boolean' ? m.netherReached : null,
    blazeRods: Number.isSafeInteger(m.blazeRods) && (m.blazeRods as number) >= 0 ? m.blazeRods as number : null };
}
