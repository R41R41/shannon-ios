import type { TrialObservation } from '../harness/trial.js';
import { DEFAULT_BUDGETS, type DailyEvalTask } from '../types.js';

export interface BudgetResult { name: string; limit: number; observed: number | null; passed: boolean; unit: 'ms' | 'yen' }

/** USD → JPY for the cost budget (`SHANNON_EVALS_YEN_PER_USD`, default 150). */
export function yenPerUsd(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(environment.SHANNON_EVALS_YEN_PER_USD);
  return Number.isFinite(value) && value > 0 ? value : 150;
}

/**
 * Time and money as pass conditions (spec §4). Latency is the worst turn of the trial; a turn with no audible line or token at all
 * fails its budget. Research time is checked by `researchCompletedWithin` where a task asks for it, and here against the default.
 */
export function runBudgets(task: DailyEvalTask, observation: TrialObservation, rate = yenPerUsd()): BudgetResult[] {
  const budgets = { ...DEFAULT_BUDGETS, ...task.budgets };
  const results: BudgetResult[] = [];
  const worst = (values: readonly (number | null)[]) => values.length ? values.some(value => value === null) ? null : Math.max(...values as number[]) : null;
  if (task.surface === 'voice') {
    const observed = worst(observation.turns.map(turn => turn.firstAudioMs));
    results.push({ name: 'voiceFirstAudioMs', limit: budgets.voiceFirstAudioMs, observed, passed: observed !== null && observed <= budgets.voiceFirstAudioMs, unit: 'ms' });
  } else {
    const observed = worst(observation.turns.map(turn => turn.firstTokenMs ?? turn.firstSentenceMs));
    results.push({ name: 'textFirstTokenMs', limit: budgets.textFirstTokenMs, observed, passed: observed !== null && observed <= budgets.textFirstTokenMs, unit: 'ms' });
  }
  const research = observation.research.map(item => item.completedMs === null ? null : item.completedMs - (observation.turnStartsMs[item.turn] ?? 0));
  if (research.length) {
    const observed = worst(research);
    results.push({ name: 'researchResultMs', limit: budgets.researchResultMs, observed, passed: observed !== null && observed <= budgets.researchResultMs, unit: 'ms' });
  }
  const yen = Math.round(observation.shannonCostUsd * rate * 100) / 100;
  results.push({ name: 'costYen', limit: budgets.costYen, observed: yen, passed: yen <= budgets.costYen, unit: 'yen' });
  return results;
}
