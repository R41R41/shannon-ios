import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BudgetResult } from './graders/budgets.js';
import type { CheckResult } from './graders/checks.js';
import type { RubricResult } from './graders/judge.js';
import type { TrialObservation } from './harness/trial.js';
import type { DailyEvalTask } from './types.js';

export interface TrialResult {
  trial: number;
  variant: number;
  passed: boolean;
  checks: CheckResult[];
  budgets: BudgetResult[];
  rubric: RubricResult;
  shannonCostYen: number;
  firstAudioMs: (number | null)[];
  replies: string[];
  error?: string;
}

export interface TaskResult {
  id: string;
  title: string;
  surface: string;
  trials: TrialResult[];
  /** pass^k: every trial passed. */
  passAll: boolean;
  /** pass@1 estimate: the fraction of trials that passed. */
  passRate: number;
}

export interface RunResult {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  set: string;
  k: number;
  judge: string | null;
  shannonModel: string;
  tasks: TaskResult[];
  totals: { passed: number; tasks: number; shannonCostYen: number; judgeCostYen: number; simulatorCostYen: number };
}

/** Real wall-clock time, whatever the eval clock reads. */
export function realNow(): string {
  return new Date(performance.timeOrigin + performance.now()).toISOString().replace(/\.\d+Z$/u, 'Z');
}

export function resultsDirectory(base: string, set: string, startedAt: string): string {
  return join(base, `${startedAt.replace(/[:]/gu, '').replace(/-/gu, '')}-${set}`);
}

/** Writes `results.json`, `summary.md` and one transcript per trial (all under the gitignored results directory). */
export function writeResults(directory: string, run: RunResult, observations: readonly TrialObservation[]): void {
  mkdirSync(join(directory, 'transcripts'), { recursive: true });
  writeFileSync(join(directory, 'results.json'), `${JSON.stringify(run, null, 2)}\n`);
  for (const observation of observations) {
    writeFileSync(join(directory, 'transcripts', `${observation.taskId}-trial${observation.trial + 1}.json`), `${JSON.stringify(observation, null, 2)}\n`);
  }
  writeFileSync(join(directory, 'summary.md'), summaryMarkdown(run));
}

const seconds = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${(value / 1_000).toFixed(1)}s`;

export function summaryMarkdown(run: RunResult): string {
  const lines = [
    `# Shannon daily evals — ${run.set} (k=${run.k})`, '',
    `- Started ${run.startedAt}, finished ${run.finishedAt}`,
    `- Shannon model: ${run.shannonModel}; judge: ${run.judge ?? 'none'}`,
    `- pass^${run.k}: **${run.totals.passed}/${run.totals.tasks}**`,
    `- Spend: Shannon ¥${run.totals.shannonCostYen.toFixed(2)}, judge ¥${run.totals.judgeCostYen.toFixed(2)}, simulator ¥${run.totals.simulatorCostYen.toFixed(2)}`,
    '', '| Task | pass^k | trials | first audio (worst) | research | ¥/trial | failed checks / budgets |', '|---|---|---|---|---|---|---|',
  ];
  for (const task of run.tasks) {
    const worstAudio = Math.max(...task.trials.flatMap(trial => trial.firstAudioMs.map(value => value ?? Number.POSITIVE_INFINITY)));
    const research = task.trials.flatMap(trial => trial.budgets.filter(budget => budget.name === 'researchResultMs').map(budget => seconds(budget.observed)));
    const cost = task.trials.reduce((sum, trial) => sum + trial.shannonCostYen, 0) / Math.max(1, task.trials.length);
    const failures = [...new Set(task.trials.flatMap(trial => [
      ...trial.checks.filter(check => !check.passed).map(check => check.kind),
      ...trial.budgets.filter(budget => !budget.passed).map(budget => budget.name),
      ...(trial.rubric.passed ? [] : [trial.rubric.skipped ? `rubric(${trial.rubric.skipped})` : `rubric ${trial.rubric.total}/${trial.rubric.maximum}`]),
      ...(trial.error ? ['error'] : []),
    ]))];
    lines.push(`| ${task.id} ${task.title} | ${task.passAll ? 'PASS' : 'FAIL'} | ${task.trials.filter(trial => trial.passed).length}/${task.trials.length} | `
      + `${Number.isFinite(worstAudio) ? seconds(worstAudio) : '—'} | ${research.join(', ') || '—'} | ${cost.toFixed(2)} | ${failures.join(', ') || '—'} |`);
  }
  lines.push('', 'Per-trial transcripts are in `transcripts/` (synthetic fixtures only; never commit this directory).', '');
  return lines.join('\n');
}

export function taskResult(task: DailyEvalTask, trials: TrialResult[]): TaskResult {
  const passed = trials.filter(trial => trial.passed).length;
  return { id: task.id, title: task.title, surface: task.surface, trials, passAll: trials.length > 0 && passed === trials.length,
    passRate: trials.length ? Math.round((passed / trials.length) * 100) / 100 : 0 };
}
