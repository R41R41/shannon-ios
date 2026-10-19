import { describe, expect, it } from 'vitest';
import { runLoopStall } from './support/fcaLoopStallHarness.js';

/**
 * Production run 14 (2026-10-17, 06:34-07:04 JST): `event loop blocked` 204 times in 30 minutes, 808 s in all (46% of the run), median
 * 3.3 s, the longest 19.9 s, while a Minecraft body task ran; none before it. This is that task offline (`support/fcaLoopStallHarness.ts`):
 * the real runtime, FCA step, recall, evidence, guard and Minecraft control over a SQLite file with the shape of production's remembered
 * turns (counts only, `support/fcaDenseWorld.ts`), a body that polls every 100 ms with a 20,000-character frame, and a task that
 * already holds a run 14 provenance (100 rows over 190 turns and 25 skill revisions).
 *
 * The budget is for the API's one thread over the task's first steps: no hold longer than 650 ms (origin/main 0c0ad93, measured on the
 * same machine: 950-1,040 ms; this branch: 340-440 ms) and at most 17% of the time in holds of 50 ms or more (origin/main 20-24%; this
 * branch 8-10%). The VM runs the same code about five times slower, so what is 100 ms here is a block that `event loop blocked` names there.
 * `fcaLoopStallWork.test.ts` holds the same fixes by the questions they ask, which do not move with the machine.
 * To measure more steps, or to profile: `node --import tsx tests/perf/loopStallBench.ts` (`STEPS`, `SEED_ROWS`, `PROFILE`, `TIMELINE`).
 */
describe('a Minecraft body task on production-dense memory keeps the API\'s one thread free', () => {
  it('holds it for at most 650 ms at a time, and under 17% of the time in holds of 50 ms or more, over its first steps', async () => {
    const run = await runLoopStall({ steps: 3, seedProvenance: { rows: 100 }, walkLogMilliseconds: 50, skillMilliseconds: [300, 900], modelMilliseconds: 500 });
    try {
      expect(run.decisions).toBeGreaterThanOrEqual(4);
      const longestCheck = Math.max(0, ...run.walks.map(walk => walk.total));
      expect(longestCheck, `the longest check of the source guard (${run.walks.map(walk => `${walk.mode}/${walk.via} ${walk.total}ms`).join(', ')})`).toBeLessThan(300);
      expect(run.loop.maxMs, `longest holds ${run.loop.longest.join(', ')} ms`).toBeLessThan(650);
      expect(run.loop.blockedFraction, `blocked ${Math.round(run.loop.blockedMs)} ms of ${Math.round(run.wallMs)} ms`).toBeLessThan(0.17);
      // The watch of production names a hold of 500 ms or more: none here.
      expect(run.watch.filter(ms => ms >= 650)).toEqual([]);
    } finally { await run.close(); }
  }, 120_000);
});
