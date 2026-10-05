import { stableFingerprint } from '../report.js';
import {
  emptyReachCost, isReachStopCause, validReachDefinition,
  type ReachCheckResult, type ReachCost, type ReachMode, type ReachReport, type ReachRunRecord,
  type ReachScenarioDefinition, type ReachStop,
} from './format.js';

/** What a driver hands back: the judged checks and the content-free evidence around them. */
export interface ReachDriverOutcome {
  checks: readonly ReachCheckResult[];
  /** A stop the run itself hit (its clock, its steps, its budget), apart from any failed check. */
  stop?: ReachStop | null;
  cost?: ReachCost;
  steps?: number;
  metrics?: Readonly<Record<string, number>>;
  /** Fingerprints of scripts and seeds, model ids and price settings: see `ReachRunRecord.inputs`. */
  inputs?: Readonly<Record<string, string>>;
}

/** The live requirement of the scenario is not met: nothing was run, nothing was spent. */
export interface ReachPending { pending: string; inputs?: Readonly<Record<string, string>> }

export interface ReachDriverContext {
  mode: ReachMode;
  /** Aborted when the scenario's wall clock runs out; a driver stops between steps and returns what it has. */
  signal: AbortSignal;
}

export type ReachDriver = (context: ReachDriverContext) => Promise<ReachDriverOutcome | ReachPending>;

export interface ReachRunOptions {
  mode: ReachMode;
  startedAt: string;
  /** A millisecond clock for the wall time; `performance.now` in a run, a fixed counter in a test. */
  clock: () => number;
  /** Extra time after the scenario's wall clock before the run is abandoned without the driver's evidence. */
  graceMilliseconds?: number;
}

export function reachDefinitionFingerprint(definition: ReachScenarioDefinition): string {
  return stableFingerprint(definition);
}

/**
 * Runs one scenario through its driver and makes the record: the wall clock is enforced, missing
 * checks count as failed, an unknown check or a throwing driver makes the run `invalid`, and the
 * stop is the run's own stop or else the cause of the first failed check in definition order.
 */
export async function runReachScenario(
  definition: ReachScenarioDefinition, driver: ReachDriver, options: ReachRunOptions,
): Promise<ReachRunRecord> {
  const base = {
    scenarioId: definition.id, scenarioVersion: definition.version,
    definitionFingerprint: reachDefinitionFingerprint(definition), mode: options.mode, startedAt: options.startedAt,
  };
  const recorded = (inputs: Readonly<Record<string, string>> = {}) => ({ inputs, inputsFingerprint: stableFingerprint(inputs) });
  const invalid = (reason: string, wallMilliseconds = 0): ReachRunRecord => ({
    ...base, status: 'invalid', reason, checks: [], stop: null, cost: emptyReachCost(), wallMilliseconds, steps: 0, metrics: {}, ...recorded(),
  });
  const problem = validReachDefinition(definition);
  if (problem) return invalid(`definition:${problem}`);

  const started = options.clock();
  const controller = new AbortController();
  const wall = definition.limits.wallMilliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: ReachDriverOutcome | ReachPending | 'abandoned';
  try {
    const abandon = new Promise<'abandoned'>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        timer = setTimeout(() => resolve('abandoned'), options.graceMilliseconds ?? 30_000);
      }, wall);
    });
    outcome = await Promise.race([driver({ mode: options.mode, signal: controller.signal }), abandon]);
  } catch (error) {
    return invalid(`driver:${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`, Math.round(options.clock() - started));
  } finally {
    if (timer) clearTimeout(timer);
  }
  const wallMilliseconds = Math.round(options.clock() - started);
  if (outcome !== 'abandoned' && 'pending' in outcome) {
    return { ...base, status: 'pending', reason: outcome.pending, checks: [], stop: null, cost: emptyReachCost(), wallMilliseconds, steps: 0, metrics: {}, ...recorded(outcome.inputs) };
  }
  const evidence: ReachDriverOutcome = outcome === 'abandoned'
    ? { checks: [], stop: { cause: 'timeout', detail: 'wall-clock:abandoned' } }
    : outcome;
  const known = new Map(definition.checks.map(check => [check.id, check]));
  const unknown = evidence.checks.find(check => !known.has(check.id));
  if (unknown) return invalid(`unknown-check:${unknown.id}`, wallMilliseconds);
  const timedOut = controller.signal.aborted;
  const runStop: ReachStop | null = evidence.stop ?? (timedOut ? { cause: 'timeout', detail: 'wall-clock' } : null);
  const checks: ReachCheckResult[] = definition.checks.map(check => evidence.checks.find(item => item.id === check.id)
    ?? { id: check.id, score: 0, passed: false, detail: 'not-judged', cause: runStop?.cause ?? 'build' });
  const judged = checks.filter(check => !check.skipped);
  const firstFailed = judged.find(check => !check.passed);
  const stop = runStop ?? (firstFailed ? { cause: firstFailed.cause ?? 'model_judgment', detail: `check:${firstFailed.id}` } : null);
  return {
    ...base,
    status: !firstFailed && !runStop ? 'passed' : 'failed',
    checks, stop, cost: evidence.cost ?? emptyReachCost(), wallMilliseconds,
    steps: evidence.steps ?? 0, metrics: evidence.metrics ?? {}, ...recorded(evidence.inputs),
  };
}

export function buildReachReport(
  runs: readonly ReachRunRecord[],
  context: { revision: string; mode: ReachMode; generatedAt: string },
): ReachReport {
  const count = (status: ReachRunRecord['status']) => runs.filter(run => run.status === status).length;
  const costYen = Math.round(runs.reduce((sum, run) => sum + run.cost.yen, 0) * 100) / 100;
  return {
    schemaVersion: 1, kind: 'shannon-reach-report', revision: context.revision, mode: context.mode, generatedAt: context.generatedAt,
    scenarioSetFingerprint: stableFingerprint(runs.map(run => `${run.scenarioId}:${run.definitionFingerprint}`).sort()),
    runs,
    totals: { passed: count('passed'), failed: count('failed'), pending: count('pending'), invalid: count('invalid'), costYen },
  };
}

/** A report as this code writes it, checked down to every run and check before it is compared with. */
export function isReachReport(value: unknown): value is ReachReport {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.schemaVersion === 1 && row.kind === 'shannon-reach-report' && Array.isArray(row.runs)
    && typeof row.revision === 'string' && isMode(row.mode) && typeof row.generatedAt === 'string'
    && typeof row.scenarioSetFingerprint === 'string' && row.runs.every(isRunRecord);
}

const STATUSES = new Set(['passed', 'failed', 'pending', 'invalid']);
const isMode = (value: unknown) => value === 'scripted' || value === 'live';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringRecord = (value: unknown, check: (item: unknown) => boolean) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value as Record<string, unknown>).every(check);

function isRunRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  const cost = run.cost as Record<string, unknown> | null | undefined;
  const stop = run.stop as Record<string, unknown> | null | undefined;
  return typeof run.scenarioId === 'string' && isNumber(run.scenarioVersion) && typeof run.definitionFingerprint === 'string'
    && isMode(run.mode) && STATUSES.has(run.status as string) && isNumber(run.wallMilliseconds) && isNumber(run.steps)
    && typeof run.inputsFingerprint === 'string' && isStringRecord(run.inputs, item => typeof item === 'string')
    && isStringRecord(run.metrics, isNumber)
    && Boolean(cost) && typeof cost === 'object' && ['calls', 'inputTokens', 'outputTokens', 'yen', 'promptCharacters'].every(key => isNumber(cost![key]))
    && (stop === null || (typeof stop === 'object' && isReachStopCause(stop?.cause) && typeof stop?.detail === 'string'))
    && Array.isArray(run.checks) && run.checks.every(check => {
      const item = check as Record<string, unknown> | null;
      return Boolean(item) && typeof item!.id === 'string' && isNumber(item!.score) && typeof item!.passed === 'boolean'
        && (item!.cause === undefined || isReachStopCause(item!.cause));
    });
}
