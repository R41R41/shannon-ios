import type { EvalClaude } from '../claude.js';
import type { TrialObservation } from '../harness/trial.js';
import type { TrialResult } from '../results.js';
import type { DailyEvalTask } from '../types.js';
import { runBudgets, yenPerUsd } from './budgets.js';
import { runChecks } from './checks.js';
import { judgeTrial } from './judge.js';

/** A trial passes when every check, every budget and the rubric pass (`judge: false` leaves the rubric out, and says so). */
export async function gradeTrial(task: DailyEvalTask, observation: TrialObservation, judge: EvalClaude | null, options: { useJudge: boolean }): Promise<TrialResult> {
  const checks = runChecks(task, observation);
  // The model's own server-side web search reads the live web, not the task's fixtures: a failure unless the task allows it.
  if (task.nativeWebSearch !== 'allowed') {
    const count = observation.nativeWebRequests ?? 0;
    checks.push({ kind: 'fixturesOnly', passed: count === 0, detail: count ? `${count} request(s) for the model's own web search` : 'no native web search' });
  }
  const budgets = runBudgets(task, observation);
  const rubric = options.useJudge ? await judgeTrial(judge, task, observation)
    : { scores: [], total: 0, maximum: task.rubric.criteria.length * 2, ratio: 0, passed: true, skipped: 'judge disabled (--no-judge)' };
  const passed = !observation.error && checks.every(check => check.passed) && budgets.every(budget => budget.passed) && rubric.passed;
  return {
    trial: observation.trial, variant: observation.variant, passed, checks, budgets, rubric,
    shannonCostYen: Math.round(observation.shannonCostUsd * yenPerUsd() * 100) / 100,
    firstAudioMs: observation.turns.map(turn => turn.firstAudioMs), replies: observation.turns.map(turn => turn.reply),
    ...(observation.error ? { error: observation.error } : {}),
  };
}
