import { describe, expect, it } from 'vitest';
import { SKILL_SCENARIOS } from '../../../packages/evaluation/src/reach/index.js';
import { REACH_SCENARIOS, runReachSuite, scriptedDrivers } from './reach/reachSuite.js';

/** Scenario suite v2 of Syzygy ADR-0008 stage 2 (skills and recall) runs model-free in the reach suite, and every scenario passes. */
describe('the skill and recall scenarios of the reach suite', () => {
  it('are registered, and pass model-free', async () => {
    expect(SKILL_SCENARIOS.map(scenario => scenario.id)).toEqual(['skill.form', 'skill.use', 'skill.retire', 'skill.guest', 'skill.pattern', 'skill.trial', 'skill.audit', 'skill.export']);
    for (const scenario of SKILL_SCENARIOS) expect(REACH_SCENARIOS).toContain(scenario);
    const report = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'test', only: ['skill.', 'recall.'], now: () => '2026-10-07T00:00:00.000Z' });
    expect(report.runs.map(run => [run.scenarioId, run.status, run.checks.filter(check => !check.passed).map(check => check.id)]))
      .toEqual(SKILL_SCENARIOS.map(scenario => [scenario.id, 'passed', []]));
    expect(report.totals.costYen).toBe(0);
  }, 120_000);
});
