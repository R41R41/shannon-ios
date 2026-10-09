import { describe, expect, it } from 'vitest';
import { QUALITY_AFFECT_SCENARIOS, compareReachReports } from '../../../packages/evaluation/src/reach/index.js';
import { runReachSuite, scriptedDrivers } from './reach/reachSuite.js';

describe('bounded quality affect comparison through the existing reach harness', () => {
  it('compares six synthetic histories reproducibly without a paid model or changing production emotion rules', async () => {
    const context = { mode: 'scripted' as const, revision: 'candidate', only: ['quality.affect.'], now: () => '2026-10-09T00:00:00.000Z' };
    const report = await runReachSuite(scriptedDrivers(), context);
    expect(report.runs.map(run => [run.scenarioId, run.status, run.checks.filter(check => !check.passed).map(check => check.id)]))
      .toEqual(QUALITY_AFFECT_SCENARIOS.map(scenario => [scenario.id, 'passed', []]));
    expect(report.totals.costYen).toBe(0);
    expect(report.runs.every(run => run.cost.calls === 0 && run.inputs.naturalness === 'not-evaluated')).toBe(true);
    const replay = await runReachSuite(scriptedDrivers(), { ...context, revision: 'repeat' });
    expect(replay.runs.map(run => run.metrics)).toEqual(report.runs.map(run => run.metrics));
    expect(compareReachReports(report, replay).regressions).toEqual([]);
  });
});
