import { describe, expect, it } from 'vitest';
import { COGNITION_SCENARIOS } from '../../../packages/evaluation/src/reach/index.js';
import { REACH_SCENARIOS, runReachSuite, scriptedDrivers } from './reach/reachSuite.js';

/** Scenario suite v1 of Syzygy ADR-0008 stage 1 runs model-free in the reach suite, and every scenario passes. */
describe('the cognition scenarios of the reach suite', () => {
  it('are registered, and pass model-free', async () => {
    expect(COGNITION_SCENARIOS.map(scenario => scenario.id)).toEqual([
      'cog.night-reply', 'cog.story-reaction', 'cog.reading-used', 'cog.tool-streak', 'cog.rollback', 'cog.kill-switch', 'cog.calibration', 'cog.mood-jitter', 'cog.cold-start',
    ]);
    for (const scenario of COGNITION_SCENARIOS) expect(REACH_SCENARIOS).toContain(scenario);
    const report = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'test', only: ['cog.'], now: () => '2026-10-07T00:00:00.000Z' });
    expect(report.runs.map(run => [run.scenarioId, run.status, run.checks.filter(check => !check.passed).map(check => check.id)]))
      .toEqual(COGNITION_SCENARIOS.map(scenario => [scenario.id, 'passed', []]));
    expect(report.totals.costYen).toBe(0);
  }, 120_000);
});
