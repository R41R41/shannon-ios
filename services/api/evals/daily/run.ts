import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createEvalClaude, evalClaudeKey, type EvalClaude } from './claude.js';
import { yenPerUsd } from './graders/budgets.js';
import { gradeTrial } from './graders/grade.js';
import { installEvalClock, resetEvalClock } from './harness/clock.js';
import { installNetworkGuard, networkLog } from './harness/network.js';
import { JEV_DEFAULT_ENDPOINT } from '../../src/infra/models/jev/jevChoice.js';
import { runTrial, type TrialObservation } from './harness/trial.js';
import { realNow, resultsDirectory, summaryMarkdown, taskResult, writeResults, type RunResult, type TrialResult } from './results.js';
import { ALL_TASKS, DROPPED_TASKS, tasksOf } from './tasks/index.js';
import type { EvalSet } from './types.js';
import { validateTasks } from './validate.js';

/**
 * `pnpm -C services/api exec tsx evals/daily/run.ts --set regression --k 3 [--task E1] [--validate] [--no-judge]`
 *
 * Without `SHANNON_EVALS_LIVE=1` it validates the definitions and refuses to call any paid API. Live, each trial runs Shannon in
 * this process over a fresh temporary database (`harness/runtime.ts`); results go to `evals/daily/results/` (gitignored).
 */
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  set: { type: 'string', default: 'regression' }, k: { type: 'string' }, task: { type: 'string', multiple: true },
  validate: { type: 'boolean', default: false }, 'no-judge': { type: 'boolean', default: false }, out: { type: 'string' },
  quiet: { type: 'boolean', default: false },
} });

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

const set = values.set as EvalSet;
if (set !== 'regression' && set !== 'capability') fail(`--set must be regression or capability (got ${values.set})`);
const k = values.k === undefined ? (set === 'regression' ? 3 : 1) : Number(values.k);
if (!Number.isInteger(k) || k < 1 || k > 10) fail('--k must be an integer in 1..10');
const ids = (values.task ?? []).flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
const unknown = ids.filter(id => !ALL_TASKS.some(task => task.id === id.toUpperCase()));
if (unknown.length) fail(`unknown task id(s): ${unknown.join(', ')}${unknown.some(id => DROPPED_TASKS[id.toUpperCase()]) ? ' (dropped; see README)' : ''}`);

const problems = validateTasks(ALL_TASKS);
const selected = tasksOf(set, ids);
if (problems.size) {
  for (const [id, list] of problems) console.error(`${id}: ${list.join('; ')}`);
  fail(`${problems.size} task definition(s) invalid`, 1);
}
if (values.validate) {
  console.log(`daily evals: ${ALL_TASKS.length} task definition(s) valid; ${selected.length} in --set ${set}${ids.length ? ` --task ${ids.join(',')}` : ''}.`);
  console.log(`dropped: ${Object.keys(DROPPED_TASKS).join(', ') || 'none'}`);
  process.exit(0);
}
if (process.env.SHANNON_EVALS_LIVE !== '1') {
  fail('Refusing to run: live trials call paid model APIs. Set SHANNON_EVALS_LIVE=1 to run them, or use --validate (definitions only, free).');
}
if (!evalClaudeKey(process.env)) fail('SHANNON_EVALS_LIVE=1 needs an Anthropic key in the environment (SHANNON_HAIKU_API_KEY, SHANNON_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY).');
if (!selected.length) fail('no task selected');

const startedAt = realNow();
// Jev's origin is reachable only while its key is set (the key itself is read by the runtime, never printed).
const jevOrigins = process.env.TYPESAFE_API_KEY?.trim() ? [new URL(process.env.SHANNON_JEV_ENDPOINT?.trim() || JEV_DEFAULT_ENDPOINT).origin] : [];
installNetworkGuard(jevOrigins);
installEvalClock();
const useJudge = !values['no-judge'];
const judge: EvalClaude | null = useJudge ? createEvalClaude(process.env) : null;
const simulator: EvalClaude | null = selected.some(task => task.simulator) ? createEvalClaude(process.env) : null;
const say = (line: string) => { if (!values.quiet) console.log(line); };

/** Server code writes its own content-free log lines; during a trial they go to the trial's log, not the terminal. */
async function quietly<T>(sink: string[], work: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const capture = (level: string) => (...args: unknown[]) => { sink.push(`${level} ${args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')}`.slice(0, 500)); };
  Object.assign(console, { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error'), debug: capture('debug') });
  try { return await work(); } finally { Object.assign(console, saved); }
}

const observations: TrialObservation[] = [];
const taskResults = [];
say(`daily evals: --set ${set} --k ${k}, ${selected.length} task(s), judge ${judge?.model ?? 'off'}, Jev ${jevOrigins.length ? 'on' : 'off'}`);
for (const task of selected) {
  const trials: TrialResult[] = [];
  for (let trial = 0; trial < k; trial += 1) {
    const serverLog: string[] = [];
    const refusedBefore = networkLog.refused.length, nativeBefore = networkLog.nativeWebRequests;
    const observation = await quietly(serverLog, () => runTrial(task, trial, { live: true, simulator }));
    resetEvalClock();
    observation.harnessLog.push(...serverLog.map(line => `server: ${line}`));
    if (networkLog.refused.length > refusedBefore) observation.harnessLog.push(`network refused: ${[...new Set(networkLog.refused.slice(refusedBefore))].join(', ')}`);
    observation.nativeWebRequests = networkLog.nativeWebRequests - nativeBefore;
    if (observation.nativeWebRequests > 0) observation.harnessLog.push(`native web tool requests: ${observation.nativeWebRequests} (bypassed fixtures)`);
    observations.push(observation);
    const graded = await gradeTrial(task, observation, judge, { useJudge });
    trials.push(graded);
    say(`  ${task.id} trial ${trial + 1}/${k}: ${graded.passed ? 'PASS' : 'FAIL'}  first audio ${graded.firstAudioMs.map(value => value ?? '—').join('/')}ms`
      + `  ¥${graded.shannonCostYen.toFixed(2)}  ${graded.checks.filter(check => !check.passed).map(check => `${check.kind}(${check.detail})`).join(' ')}`
      + `${graded.budgets.filter(budget => !budget.passed).map(budget => ` ${budget.name}=${budget.observed}`).join('')}`
      + `${graded.rubric.passed ? '' : ` rubric ${graded.rubric.skipped ?? `${graded.rubric.total}/${graded.rubric.maximum}`}`}${graded.error ? ` error=${graded.error}` : ''}`);
  }
  taskResults.push(taskResult(task, trials));
}
const rate = yenPerUsd();
const run: RunResult = {
  schemaVersion: 1, startedAt, finishedAt: realNow(), set, k, judge: judge?.model ?? null,
  shannonModel: process.env.SHANNON_EVALS_MODEL?.trim() || 'claude-haiku-5-5',
  tasks: taskResults,
  totals: {
    passed: taskResults.filter(task => task.passAll).length, tasks: taskResults.length,
    shannonCostYen: Math.round(taskResults.reduce((sum, task) => sum + task.trials.reduce((inner, trial) => inner + trial.shannonCostYen, 0), 0) * 100) / 100,
    judgeCostYen: Math.round((judge?.spentUsd() ?? 0) * rate * 100) / 100,
    simulatorCostYen: Math.round((simulator?.spentUsd() ?? 0) * rate * 100) / 100,
  },
};
const directory = resultsDirectory(values.out ? resolve(values.out) : join(here, 'results'), set, startedAt);
writeResults(directory, run, observations);
console.log(summaryMarkdown(run));
console.log(`results: ${directory}`);
process.exit(run.totals.passed === run.totals.tasks ? 0 : 1);
