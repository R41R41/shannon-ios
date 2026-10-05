/**
 * Reach measures (到達の物差し, Syzygy ADR-0003, owner decision 2026-10-05).
 *
 * A fixed scenario is run from a clean state and judged from outside: by what the stores, the
 * activity record, and the requests the model was given show, never by what the model says it did.
 * Every run that stops short of its goal names the cause from one closed vocabulary, so versions can
 * be compared on where they stop, not only on whether they pass.
 *
 * This file is the format only: no clock, no file, no model, no store.
 */

/**
 * Why a run stopped short.
 * - `tool`: one action's procedure failed (an executor, a provider call, a reader, a delivery).
 * - `build`: Shannon's construction did not give the model what it needed (context missing from the
 *   request, a tool not offered, a gate or configuration refusal, wiring that does not exist).
 * - `model_judgment`: the model had what it needed and chose wrong, or stopped.
 * - `budget`: a spending or step allowance ran out first.
 * - `timeout`: the wall clock or the scenario's own clock ran out first.
 */
export const REACH_STOP_CAUSES = ['tool', 'build', 'model_judgment', 'budget', 'timeout'] as const;
export type ReachStopCause = typeof REACH_STOP_CAUSES[number];

export const REACH_STOP_CAUSE_LABEL: Readonly<Record<ReachStopCause, string>> = Object.freeze({
  tool: '道具', build: '作り', model_judgment: 'モデルの判断', budget: '予算', timeout: '時間切れ',
});

/** The three needs of ADR-0003 the measures come from. */
export type ReachNeed = 'understand_people' | 'be_useful' | 'grow';

/** `scripted`: model-free, every model reply comes from a script. `live`: the real models, billable. */
export type ReachMode = 'scripted' | 'live';

export interface ReachCheckDefinition {
  id: string;
  /** What is judged, in one sentence. */
  description: string;
  /** `deterministic` checks are computed from evidence. An `llm` check needs `rubric` and runs only in live mode when asked for. */
  judge: 'deterministic' | 'llm';
  rubric?: string;
  /** The score (0..1) at or above which the check passes. */
  threshold: number;
}

export interface ReachScenarioDefinition {
  schemaVersion: 1;
  id: string;
  /** Raised whenever the script, the seed, or a check changes: results of different versions are not compared. */
  version: number;
  need: ReachNeed;
  /** The row of the ADR table this scenario measures. */
  measure: string;
  description: string;
  checks: readonly ReachCheckDefinition[];
  limits: {
    /** Wall clock for one run. */
    wallMilliseconds: number;
    /** Model calls or loop ticks, whichever the scenario counts. */
    maximumSteps: number;
    /** For a scenario that runs under a budget: the cap it is given. */
    budgetYen?: number;
  };
  /** What must exist on main before the live mode can run; absent, it can always run. */
  liveRequires?: string;
}

export interface ReachCheckResult {
  id: string;
  score: number;
  passed: boolean;
  /** Content-free: counts, codes, turn numbers. Never what the owner or the model said. */
  detail?: string;
  /** Set on a failed check: why it was not reached. */
  cause?: ReachStopCause;
  /** An `llm` check that was not asked for. A skipped check neither passes nor fails the run. */
  skipped?: true;
}

export interface ReachStop {
  cause: ReachStopCause;
  /** A closed code or a short content-free note (`check:recall.q1`, `ticks:300`). */
  detail: string;
}

export interface ReachCost {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  yen: number;
  /** Provider-reported usage (live) as opposed to the script's simulated usage. */
  measured: boolean;
  /** Characters of every request the model was given: the basis of the live estimate. */
  promptCharacters: number;
  /** Of `inputTokens`, what the provider read from its prompt cache (absent where the scenario does not know). */
  cachedInputTokens?: number;
  /** `yen` with the provider's discount for cached input applied; `yen` itself prices every input token in full. */
  yenWithCacheDiscount?: number;
}

export type ReachRunStatus = 'passed' | 'failed' | 'pending' | 'invalid';

export interface ReachRunRecord {
  scenarioId: string;
  scenarioVersion: number;
  /** Fingerprint of the definition: two records are comparable only when it is the same. */
  definitionFingerprint: string;
  mode: ReachMode;
  status: ReachRunStatus;
  /** Why a run is `pending` (live requirement missing) or `invalid` (the harness itself failed). */
  reason?: string;
  checks: readonly ReachCheckResult[];
  stop: ReachStop | null;
  cost: ReachCost;
  wallMilliseconds: number;
  steps: number;
  startedAt: string;
  /** Content-free numbers the scenario wants kept beside its checks. */
  metrics: Readonly<Record<string, number>>;
  /**
   * What the run was given apart from the definition: fingerprints of the scripts and seeds, and for a live
   * run the model ids and price settings (names and values of prices, never a credential).
   */
  inputs: Readonly<Record<string, string>>;
  /** Fingerprint of `inputs`: two records are comparable only when it is the same. */
  inputsFingerprint: string;
}

export interface ReachReport {
  schemaVersion: 1;
  kind: 'shannon-reach-report';
  revision: string;
  mode: ReachMode;
  generatedAt: string;
  scenarioSetFingerprint: string;
  runs: readonly ReachRunRecord[];
  totals: Readonly<Record<ReachRunStatus, number>> & { costYen: number };
}

export function emptyReachCost(): ReachCost {
  return { calls: 0, inputTokens: 0, outputTokens: 0, yen: 0, measured: false, promptCharacters: 0 };
}

export function isReachStopCause(value: unknown): value is ReachStopCause {
  return REACH_STOP_CAUSES.includes(value as ReachStopCause);
}

/** A definition the runner can use: ids unique, thresholds in range, every `llm` check has a rubric. */
export function validReachDefinition(definition: ReachScenarioDefinition): string | null {
  if (definition.schemaVersion !== 1 || !definition.id.trim() || !Number.isInteger(definition.version) || definition.version < 1) return 'header';
  const ids = new Set<string>();
  for (const check of definition.checks) {
    if (!check.id.trim() || ids.has(check.id)) return `check-id:${check.id}`;
    ids.add(check.id);
    if (!(check.threshold >= 0 && check.threshold <= 1)) return `threshold:${check.id}`;
    if (check.judge === 'llm' && !check.rubric?.trim()) return `rubric:${check.id}`;
  }
  if (!(definition.limits.wallMilliseconds > 0) || !(definition.limits.maximumSteps > 0)) return 'limits';
  return ids.size ? null : 'no-checks';
}

/** A check result from a score and a cause to name if it fails. */
export function scoredCheck(
  definition: ReachScenarioDefinition, id: string, score: number, cause: ReachStopCause, detail?: string,
): ReachCheckResult {
  const check = definition.checks.find(item => item.id === id);
  if (!check) throw new Error(`REACH_UNKNOWN_CHECK:${id}`);
  const bounded = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  const passed = bounded >= check.threshold;
  return { id, score: Math.round(bounded * 1000) / 1000, passed, ...(detail ? { detail } : {}), ...(passed ? {} : { cause }) };
}
