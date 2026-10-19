import { fcaProductionShape } from './fcaProductionShape.js';
import { SQLiteTaskExperiences } from '../../src/mind/memory/store/taskExperiences.js';
import { taskExperienceId } from '../../src/mind/memory/taskExperience.js';
import type { TaskSource } from '../../src/mind/action/taskRuntime/taskRuntimePorts.js';

/** A small deterministic generator, so that runs compare. */
export function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * The remembered turns of production on 2026-10-19, from counts alone (nothing of its content): 1,337 turns, of which about two
 * hundred are the episodes of earlier body tasks (`fca.task`), each recalling up to 190 ids and reading up to 25 skill revisions; the
 * others mostly recall nothing (median 0, mean 17.6, p90 84 ids per turn; read receipts mean 2.8, p90 16). The task of run 14
 * (2026-10-17) carried 100 provenance rows over 190 distinct ids and 25 distinct skill revisions, and a walk of it took 3.3 s on the
 * VM (`event loop blocked`, median).
 */
export const DENSE_WORLD = Object.freeze({ ordinary: 937, episodes: 400, episodeRecalledMax: 190, episodeReadsMax: 18, skills: 25, skillBody: 1900 });

export function fcaDenseWorld(options: Partial<Record<keyof typeof DENSE_WORLD, number>> & { seed?: number } = {}) {
  const size = { ...DENSE_WORLD, ...options }, random = rng(options.seed ?? 7);
  const pick = <T>(items: readonly T[], count: number) => Array.from({ length: Math.min(count, items.length) }, () => items[Math.floor(random() * items.length)]!);
  const shape = fcaProductionShape({ experiences: size.ordinary, skills: size.skills, skillBody: size.skillBody, forgets: 2,
    recalledOf: (_index, earlier) => random() < 0.7 || !earlier.length ? [] : pick(earlier, 3 + Math.floor(random() * 12)) });
  // The episodes of earlier body tasks: written the way the memory writer writes them (`taskExperiences.ts`), each at a time among the turns.
  const writer = new SQLiteTaskExperiences(shape.world.store.fcaDatabase());
  const episodes: string[] = [];
  const start = Date.parse('2026-10-07T03:00:00.000Z');
  for (let index = 0; index < size.episodes; index++) {
    const turn = Math.floor(60 + (index + 1) * (size.ordinary - 120) / size.episodes);
    const observedAt = new Date(start + (turn + 1) * 60_000 + 7).toISOString();
    // What it recalled: earlier turns and earlier episodes (the sources of its task), as many as the task's provenance held.
    const earlier = [...shape.ids.slice(0, turn), ...episodes];
    const count = random() < 0.35 ? 0 : 20 + Math.floor(random() * (size.episodeRecalledMax - 20));
    const record = { scopeKey: 'owner', taskId: `dense-task-${index}`, outcomeId: `outcome-${index}`, observedAt, status: 'success' as const,
      goal: `探索の目標${index}`, context: `文脈${index}`, action: `行動${index}`, prediction: `予想${index}`, observedResult: `観測${index}`, interpretation: `解釈${index}`,
      sourceIds: [...new Set(pick(earlier, count))], readSourceIds: [...new Set(pick(shape.skillSources, Math.floor(random() * (size.episodeReadsMax + 1))))] };
    writer.write('owner', record);
    episodes.push(taskExperienceId('owner', record.taskId, record.outcomeId));
  }
  const ordinary = shape.ids.slice(0, -2);
  /** The provenance rows of a task that has taken `steps` steps: each step's recall and skill index, from a pool of `pool` ids. */
  function provenance(steps: number, pool = 190, perStep = 95, reads = 25): TaskSource[] {
    const poolIds = [...new Set([...pick(episodes, Math.floor(pool / 2)), ...pick(ordinary, pool)])].slice(0, pool);
    return Array.from({ length: steps }, (_, step) => ({ kind: 'memory', stepId: `s${String(step + 1).padStart(4, '0')}`, experienceId: null, threadId: null,
      observedAt: new Date(Date.parse('2026-10-17T06:34:00.000Z') + (step + 1) * 20_000).toISOString(),
      recalledMemoryIds: pick(poolIds, perStep), readSourceIds: pick(shape.skillSources, Math.floor(random() * (reads + 1))) }) as unknown as TaskSource);
  }
  return { ...shape, ids: [...ordinary, ...episodes], ordinary, episodes, provenance, random };
}
