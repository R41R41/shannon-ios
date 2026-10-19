import { describe, expect, it } from 'vitest';
import { runLoopStall } from './support/fcaLoopStallHarness.js';
import { WITHHOLDING_QUESTIONS, countingAsync } from './support/callCounts.js';

/**
 * Production run 14 (2026-10-17, 06:34-07:04 JST): `event loop blocked` 204 times in 30 minutes, 808 s in all (46% of the run), median
 * 3.3 s, the longest 19.9 s, while a Minecraft body task ran; none before it. This is that task offline (`support/fcaLoopStallHarness.ts`):
 * the real runtime, FCA step, recall, evidence, guard and Minecraft control over a SQLite file with the shape of production's remembered
 * turns (counts only, `support/fcaDenseWorld.ts`), a body that polls every 100 ms with a 20,000-character frame, and a task that
 * already holds a run 14 provenance (100 rows over 190 turns and 25 skill revisions).
 *
 * The budget here is COUNTED, not timed: the questions the task's first steps asked of the recall graph and the statements the database
 * compiled. They do not move with the machine or with what else runs on it (CI runs this suite beside others, `--maxWorkers=4`); a time
 * budget failed under load (a 650 ms hold seen as 663 ms, 17% blocked seen as 21%). Measured on the same run, this branch / origin/main
 * (0c0ad93), unloaded and with 24 busy loops beside it (this branch varied by under 7%):
 *   withholdsReply          48.6-51.8 k /  89.9 k      sourceVisible        38.9 k /  90.5 k
 *   recalledWithheldWithin  158.8-159.4 k / 611 k      withholdsExperience  12.4 k /  33.1 k
 *   provenanceWithheld      19.5-19.9 k /  218 k       statements prepared  10.9-11.0 k / 55 k
 * The bounds below sit between the two, about 1.4 to 1.8 times this branch. The run in seconds (no hold longer than 650 ms, under 17% of
 * the time in holds of 50 ms or more; origin/main 950-1,040 ms and 20-24%, this branch 340-440 ms and 8-10%; the VM runs the same code about
 * five times slower) is `node --import tsx tests/perf/loopStallBudget.ts`, and `tests/perf/loopStallBench.ts` measures more steps and
 * profiles. `fcaLoopStallWork.test.ts` holds the same fixes on single walks.
 */
const BOUNDS: Record<string, number> = { withholdsReply: 72_000, recalledWithheldWithin: 250_000, provenanceWithheld: 40_000, sourceVisible: 60_000,
  withholdsExperience: 18_000, prepare: 20_000 };

describe('a Minecraft body task on production-dense memory asks the recall graph a bounded number of questions', () => {
  it('asks and compiles no more than the bounds below over its first steps, and every step is decided', async () => {
    const { value: run, counts } = await countingAsync(WITHHOLDING_QUESTIONS, () =>
      runLoopStall({ steps: 3, seedProvenance: { rows: 100 }, walkLogMilliseconds: 50, skillMilliseconds: [300, 900], modelMilliseconds: 500 }), { statements: true });
    try {
      expect(run.decisions).toBeGreaterThanOrEqual(4);
      expect(run.warnings.filter(line => /FCA_SOURCE_WITHHELD|poll failed|capped/u.test(line))).toEqual([]);
      for (const [name, bound] of Object.entries(BOUNDS)) expect(counts[name], `${name} of ${JSON.stringify(counts)}`).toBeLessThan(bound);
    } finally { await run.close(); }
  }, 120_000);
});
