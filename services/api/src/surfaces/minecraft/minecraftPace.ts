import type { TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';

// Moved out of minecraftReflexAdapter.ts unchanged (rel25: that file passed the 500-line ceiling); the adapter re-exports them.

/**
 * The task's pace as closed numbers (the old Minebot `describePace`; owner 2026-10-14: 「40分のまま速くする」): minutes since the task
 * began, its latest tool results that worked and failed (at most six), its steps in a row whose actions all failed, and its latest
 * milestones when the body reported them, and the seconds she has spent in `mc.wait-time` (Minecraft run 9: 390 s in nine calls) when any.
 */
export function minecraftPace(step: TaskStep, recent: ReadonlyArray<{ ok: boolean }>, at: number, milestones: PaceMilestones | null = null,
  idleWaitMilliseconds = 0) {
  const began = Date.parse(step.snapshot.task.createdAt), checkpoint = step.snapshot.checkpoint as { consecutiveToolFailures?: unknown } | null;
  const failedSteps = Number(checkpoint?.consecutiveToolFailures ?? 0);
  return { elapsedMinutes: Number.isFinite(began) ? Math.max(0, Math.floor((at - began) / 60_000)) : null,
    recentResults: { worked: recent.filter(result => result.ok).length, failed: recent.filter(result => !result.ok).length },
    failedStepsInARow: Number.isSafeInteger(failedSteps) && failedSteps >= 0 ? failedSteps : 0, ...(milestones ? { milestones } : {}),
    ...(idleWaitMilliseconds > 0 ? { idleWaitSeconds: Math.round(idleWaitMilliseconds / 1000) } : {}) };
}

/** The milliseconds a `mc.wait-time` call asks for (`milliseconds`, or `ms`), bounded; 0 when it names none. */
export function waitTimeMilliseconds(input: unknown): number {
  const value = input && typeof input === 'object' ? (input as { milliseconds?: unknown; ms?: unknown }) : {};
  const milliseconds = Number(value.milliseconds ?? value.ms);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.min(milliseconds, 3_600_000) : 0;
}

/**
 * The body's milestones (Minebot 4b047cf, `mc.goal-evidence`) as the pace note gives them: its dimension and whether it reached the
 * Nether, closed values only (`visited` and the counts are left out). Read from a result's whole text, before any summary of it is
 * cut (review of d36252e8: a long `visited` list passed the 1,000 characters kept and the milestones went missing); null when the
 * text carries none.
 */
export type PaceMilestones = { dimension: string | null; netherReached: boolean | null };
export function minecraftMilestones(value: unknown): PaceMilestones | null {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const milestones = parsed && typeof parsed === 'object' ? (parsed as { milestones?: unknown }).milestones : undefined;
  if (!milestones || typeof milestones !== 'object' || Array.isArray(milestones)) return null;
  const { dimension, netherReached } = milestones as { dimension?: unknown; netherReached?: unknown };
  return { dimension: typeof dimension === 'string' && /^[a-z_:]{1,40}$/u.test(dimension) ? dimension : null,
    netherReached: typeof netherReached === 'boolean' ? netherReached : null };
}
