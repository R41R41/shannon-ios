import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import { minecraftRecallCues } from './minecraftRecallCues.js';
import { minecraftSituation } from './minecraftSkillPointers.js';
import { minecraftPace } from './minecraftPace.js';

type PaceArguments = Parameters<typeof minecraftPace>;
type RecentResults = Parameters<typeof minecraftRecallCues>[2] & PaceArguments[1];

/**
 * A body task's context in the LLM-centric mode (r3; run 27: every decision still built the old path's pace, situation, route, skill
 * pointers and gists, stage and summary, walked the task's sources for them, and wrote their measurement lines): the live state is the
 * wrapper's (`withLlmcBody`), so the context is the revision alone, and the recall's cues read the situation only when a recall asks.
 */
export function llmcBodyContext(parts: { observation: BodyObservation | null; step: TaskStep; recentResults: RecentResults; now: number;
  milestones: PaceArguments[3]; idleWaitMs: number; revision: number;
  keep(latest: { transient(): Record<string, unknown>; cues(): ReturnType<typeof minecraftRecallCues> }): void }): { revision: number; observation: null } {
  const { observation, step, recentResults, now } = parts;
  const elapsedSeconds = Math.max(0, (now - Date.parse(step.snapshot.task.createdAt)) / 1000);
  parts.keep({ transient: () => ({}), cues: () => minecraftRecallCues(observation, minecraftSituation(observation,
    { ...minecraftPace(step, recentResults, now, parts.milestones, parts.idleWaitMs), recentIdleWaits: 0, elapsedSeconds }), recentResults) });
  return { revision: parts.revision, observation: null };
}
