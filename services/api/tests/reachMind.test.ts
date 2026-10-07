import { describe, expect, it } from 'vitest';
import { PROACTIVE_SCENARIOS, WORKSPACE_SCENARIOS } from '../../../packages/evaluation/src/reach/index.js';
import { REACH_SCENARIOS, runReachSuite, scriptedDrivers } from './reach/reachSuite.js';

/** Scenario suite v3 of Syzygy ADR-0008 stage 3 (the workspace) runs model-free in the reach suite, and every scenario passes. */
describe('the workspace scenarios of the reach suite', () => {
  it('are registered, and pass model-free', async () => {
    expect(WORKSPACE_SCENARIOS.map(scenario => scenario.id)).toEqual(['ws.cross-body', 'ws.restart', 'ws.others-present', 'ws.notice-prefix', 'ws.untrusted-frame']);
    for (const scenario of WORKSPACE_SCENARIOS) expect(REACH_SCENARIOS).toContain(scenario);
    const report = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'test', only: ['ws.'], now: () => '2026-10-07T00:00:00.000Z' });
    expect(report.runs.map(run => [run.scenarioId, run.status, run.checks.filter(check => !check.passed).map(check => check.id)]))
      .toEqual(WORKSPACE_SCENARIOS.map(scenario => [scenario.id, 'passed', []]));
    expect(report.totals.costYen).toBe(0);
  }, 120_000);

  it('include the proactive gate\'s scenarios (no spacing scenario: spacing stays 5 minutes), and they pass model-free', async () => {
    expect(PROACTIVE_SCENARIOS.map(scenario => scenario.id)).toEqual(['pro.intent-expiry', 'pro.topic-reuse', 'pro.withheld-visible']);
    for (const scenario of PROACTIVE_SCENARIOS) expect(REACH_SCENARIOS).toContain(scenario);
    const report = await runReachSuite(scriptedDrivers(), { mode: 'scripted', revision: 'test', only: ['pro.'], now: () => '2026-10-07T00:00:00.000Z' });
    expect(report.runs.map(run => [run.scenarioId, run.status, run.checks.filter(check => !check.passed).map(check => check.id)]))
      .toEqual(PROACTIVE_SCENARIOS.map(scenario => [scenario.id, 'passed', []]));
    expect(report.totals.costYen).toBe(0);
  }, 120_000);
});
