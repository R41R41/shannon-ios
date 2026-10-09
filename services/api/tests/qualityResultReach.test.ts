import { expect, it } from 'vitest';
import { runReachSuite, scriptedDrivers } from './reach/reachSuite.js';
it('keeps acceptance and exact-target successes while detecting unsupported claims without a model', async () => {
  const report = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'candidate', only: ['quality.result.'] });
  expect(report.runs.map(run => run.status)).toEqual(['passed', 'passed']);
  expect(report.totals.costYen).toBe(0);
  expect(report.runs.every(run => run.cost.calls === 0)).toBe(true);
});
