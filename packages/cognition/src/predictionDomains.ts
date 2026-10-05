import { SHANNON_EMOTION_CONTINUITY } from './emotionTime.js';
import { SHARED_DAY_WINDOW } from './temperament.js';

/**
 * The domains of the prediction layer and the state it folds (Syzygy ADR-0006 §1). Core: emotion. Pure.
 *
 * This half holds what a key starts from and how sure it may be:
 * - Empirical-Bayes priors. A new key, and a new cause, start from the other keys of their domain: a Bayesian linear
 *   regression of their outcomes on [1, features − ½] (owner answer 8: closeness and how often they talk may seed the
 *   prior; with no features it is the other keys' mean). Its variance is the law of total variance over the other
 *   keys (the spread of their expectations plus their mean uncertainty) and the regression's own uncertainty, never
 *   below the noise floor; with fewer than three other keys, and with none, the uniform distribution over the outcome
 *   scale (Beta(1,1) for yes/no).
 * - Noise and volatility per key from its own innovations: E[δ²] − uncertainty = noise + volatility × elapsed days,
 *   a constrained least-squares analogue of Piray & Daw's (2021) joint estimate, held toward the domain's average by
 *   one observation's worth each. For yes/no outcomes the noise is the Bernoulli variance and only volatility is fitted.
 * - Bounds: an expectation is never held less surely than the unbiased spread of its scale, and a yes/no expectation
 *   never less surely than the uniform Beta(1,1) holds it.
 */

export const DAY = 24 * 3_600_000;

export type PredictionFamily = 'bernoulli' | 'log_time' | 'gaussian';

export interface PredictionDomainSpec {
  family: PredictionFamily;
  /** The outcome scale. `log_time` holds ln(seconds) on [lower, upper]. */
  lower: number;
  upper: number;
  /** The outcome is how good or bad it was for her, on the valence scale [−1, 1]: it moves her feeling (§2.2). */
  valence: boolean;
  /** Related information that may seed a key's prior (owner answer 8): names of features, each in [0, 1]. */
  features: readonly string[];
}

const spec = (family: PredictionFamily, lower: number, upper: number, valence: boolean, features: readonly string[]): PredictionDomainSpec =>
  Object.freeze({ family, lower, upper, valence, features: Object.freeze([...features]) });

/**
 * What she predicts (ADR-0006 §1, the table 「何を予想するか」), for the domains stage 1 observes.
 * - `reply`: whether the owner answers a message of hers. Key: reason × time of day × route. Prior features: closeness, talk.
 * - `reply_time`: after how long he answers (ln seconds; censored at the loop's wait: a later answer is no answer).
 * - `owner_present`: whether he is there (her body reported away or hidden: not a failure of her message).
 * - `touch`: how a touch was received, on the valence scale. Key: kind × part × who may have touched.
 * - `reply_feeling`: how a moment of conversation felt, on the valence scale (the decided feeling's sign × strength).
 */
export const SHANNON_PREDICTION_DOMAINS = Object.freeze({
  reply: spec('bernoulli', 0, 1, false, ['closeness', 'talk']),
  reply_time: spec('log_time', 0, Math.log(86_400), false, ['closeness', 'talk']),
  owner_present: spec('bernoulli', 0, 1, false, []),
  touch: spec('gaussian', -1, 1, true, []),
  reply_feeling: spec('gaussian', -1, 1, true, []),
});
export type PredictionDomain = keyof typeof SHANNON_PREDICTION_DOMAINS;

export function isPredictionDomain(value: string): value is PredictionDomain {
  return Object.prototype.hasOwnProperty.call(SHANNON_PREDICTION_DOMAINS, value);
}

/**
 * The prediction layer's coefficients. Each is (a) a published model's value, (b) estimated from her own data,
 * (c) given by the model itself, or else marked as a modelling assumption (ADR-0006 原則 3).
 */
export const SHANNON_PREDICTION_COEFFICIENTS = Object.freeze({
  /**
   * α, how readily an outcome is given a new latent cause (Gershman, Blei & Niv 2010). ADR-0006 §2.6: start from the
   * source's simulation value, then fit to her data. 要確認: the value here (0.1) has not yet been checked against the
   * source's simulations; replace it with theirs before stage 2. At 1 a key whose outcomes come days apart opened a cause
   * for almost every outcome early on (its recency mass is below α); 0.1 keeps a steady key in one cause.
   */
  newCause: 0.1,
  /**
   * The temporal kernel of the cause prior, K(Δ) = (1 + Δ/τ)^(−d) on the wall clock: the power-law form of §2.4
   * (Gershman et al. 2017 use a power-law kernel over trials). Her outcomes come days apart, so τ is one day here.
   * 要確認: τ = 1 day and d = 1 are assumptions, to be fitted to her data.
   */
  recencyMs: DAY,
  recencyExponent: 1,
  /** g, arousal's gain on learning (McGaugh 2004, Nassar et al. 2012). No transferable value: 0, compared in the shadow. */
  arousalGain: 0,
  /** An empty domain's volatility: the unbiased scale variance spread over the closeness window. Modelling assumption. */
  emptyVolatilityDays: SHARED_DAY_WINDOW,
  /** How many past instants a cause keeps exactly for its recency; older ones are merged by weight. Technical bound. */
  kernelMemory: 64,
});

export interface Cause {
  mean: number;
  variance: number;
  /** Yes/no only: the Beta posterior's strength a + b (variance = mean·(1 − mean)/(strength + 1)). */
  strength: number;
  count: number;
  lastAt: number;
  /** [instant, weight] of the outcomes it explained, for its recency mass. */
  times: Array<[number, number]>;
  contexts: Record<string, number>;
}

export interface Pending { cause: number; before: Cause; fresh: Cause; logSame: number; logNew: number }

/** Σ x xᵀ and Σ x y of outcomes on [1, features − ½]. */
export interface Regression { xx: number[][]; xy: number[]; n: number }

export interface KeyState {
  causes: Cause[];
  count: number;
  /** Moments of the innovations: Σ1, Σdt, Σdt², Σz, Σdt·z (dt in days; z = δ² − uncertainty, less the Bernoulli variance). */
  moments: [number, number, number, number, number];
  pending: Pending | null;
  /** This key's share of the domain's regression, taken out when the prior is the other keys'. */
  regression: Regression;
}

export interface DomainState { keys: Map<string, KeyState>; regression: Regression }

export function emptyRegression(domain: PredictionDomainSpec): Regression {
  const size = 1 + domain.features.length;
  return { xx: Array.from({ length: size }, () => new Array<number>(size).fill(0)), xy: new Array<number>(size).fill(0), n: 0 };
}

export function scaleVariance(domain: PredictionDomainSpec): number {
  return (domain.upper - domain.lower) ** 2 / 12;
}

/** The outcome on the domain's scale: 0/1, clamped valence, or ln of the seconds. */
export function transformedOutcome(domain: PredictionDomainSpec, value: number): number {
  if (domain.family === 'bernoulli') return value >= 0.5 ? 1 : 0;
  const raw = domain.family === 'log_time' ? Math.log(Math.max(1, value)) : value;
  return clamp(Number.isFinite(raw) ? raw : domain.lower, domain.lower, domain.upper);
}

function featureVector(domain: PredictionDomainSpec, features: Readonly<Record<string, number>> | undefined): number[] {
  return [1, ...domain.features.map(name => clamp(finite(features?.[name], 0.5), 0, 1) - 0.5)];
}

/** Adds one outcome to the domain's regression and to the key's share of it. */
export function learnRegression(state: DomainState, key: KeyState, domain: PredictionDomainSpec, features: Readonly<Record<string, number>> | undefined, y: number): void {
  const x = featureVector(domain, features);
  for (const regression of [state.regression, key.regression]) {
    for (let row = 0; row < x.length; row += 1) {
      regression.xy[row]! += x[row]! * y;
      for (let column = 0; column < x.length; column += 1) regression.xx[row]![column]! += x[row]! * x[column]!;
    }
    regression.n += 1;
  }
}

/**
 * The prior of a new key or a new cause: the regression of the *other* keys' outcomes on the features (with no
 * features, their mean), with the spread of the other keys' expectations and the regression's own uncertainty,
 * never wider than the scale. `own` is left out (ADR-0006 §1: 「同じ領域のほかの鍵の平均とばらつき」).
 */
export function domainPrior(
  state: DomainState | undefined, domain: PredictionDomainSpec, features: Readonly<Record<string, number>> | undefined, own?: KeyState,
): { expectation: number; uncertainty: number } {
  const scale = scaleVariance(domain);
  const middle = (domain.lower + domain.upper) / 2;
  const x = featureVector(domain, features);
  const n = (state?.regression.n ?? 0) - (own?.regression.n ?? 0);
  if (!state || n <= 0) return { expectation: middle, uncertainty: boundedVariance(domain, middle, scale) };
  const noise = domain.family === 'bernoulli' ? 0.25 : domainNoiseVolatility(state, domain, own).noise;
  const xx = state.regression.xx.map((row, i) => row.map((value, j) => value - (own?.regression.xx[i]![j] ?? 0)));
  const xy = state.regression.xy.map((value, i) => value - (own?.regression.xy[i] ?? 0));
  const precision = xx.map((row, i) => row.map((value, j) => value / noise + (i === j ? 1 / scale : 0)));
  const target = xy.map((value, i) => value / noise + (i === 0 ? middle / scale : 0));
  const beta = solve(precision, target);
  const spreadOfX = solve(precision, x);
  let mean = 0;
  let parameterVariance = 0;
  for (let i = 0; i < x.length; i += 1) { mean += beta[i]! * x[i]!; parameterVariance += x[i]! * spreadOfX[i]!; }
  mean = clamp(mean, domain.lower, domain.upper);
  if (domain.family === 'bernoulli') mean = clamp(mean, 1 / (n + 2), (n + 1) / (n + 2));
  // Law of total variance: how far the other keys' expectations lie apart, plus how unsure each of them still is. With
  // fewer than three other keys that spread is not known, and a new key starts from the unbiased spread of the scale;
  // with more it is never below the noise floor, so that a new key, and a new cause, can still move.
  const others = [...state.keys.values()].filter(key => key !== own && key.causes.length > 0).map(dominant);
  if (others.length < 3) return { expectation: mean, uncertainty: boundedVariance(domain, mean, scale) };
  const between = sampleVariance(others.map(cause => cause.mean));
  const within = others.reduce((sum, cause) => sum + cause.variance, 0) / others.length;
  return { expectation: mean, uncertainty: boundedVariance(domain, mean, Math.max(noiseFloor(domain), between + within + Math.max(0, parameterVariance))) };
}

const dominant = (key: KeyState): Cause => key.causes.reduce((best, cause) => (cause.count > best.count ? cause : best));

/**
 * Never less sure than the unbiased spread: the scale's variance for valence and time, and for yes/no what the uniform
 * Beta(1,1) holds at that mean (mean·(1 − mean)/3).
 */
export function boundedVariance(domain: PredictionDomainSpec, mean: number, variance: number): number {
  const value = Math.max(1e-12, variance);
  return Math.min(value, domain.family === 'bernoulli' ? Math.max(1e-12, mean * (1 - mean) / 3) : scaleVariance(domain));
}

/** The Beta strength (a + b) a yes/no expectation held with this variance has. At least the uniform prior's 2. */
export function betaStrength(mean: number, variance: number): number {
  return Math.max(2, Math.max(1e-6, mean * (1 - mean)) / Math.max(1e-12, variance) - 1);
}

/**
 * The average noise and volatility of the domain's other keys that have outcomes (`own` is left out); with none, the
 * unbiased ones.
 */
export function domainNoiseVolatility(state: DomainState | undefined, domain: PredictionDomainSpec, own?: KeyState): { noise: number; volatility: number } {
  const empty = { noise: domain.family === 'bernoulli' ? 0.25 : scaleVariance(domain), volatility: scaleVariance(domain) / SHANNON_PREDICTION_COEFFICIENTS.emptyVolatilityDays };
  const keys = state ? [...state.keys.values()].filter(key => key !== own && key.count > 0) : [];
  if (!keys.length) return empty;
  const estimates = keys.map(key => keyNoiseVolatility(key, domain, empty));
  return {
    noise: estimates.reduce((sum, item) => sum + item.noise, 0) / estimates.length,
    volatility: estimates.reduce((sum, item) => sum + item.volatility, 0) / estimates.length,
  };
}

/**
 * Noise and volatility of a key from its innovations: E[z] = noise + volatility·dt (dt in days), a least-squares fit
 * held toward the domain's values by one observation's worth each (ridge), so that a key whose outcomes all came
 * close together learns its noise without inventing a volatility. For yes/no outcomes the noise is the Bernoulli
 * variance itself and only the volatility is estimated.
 */
export function keyNoiseVolatility(key: KeyState | undefined, domain: PredictionDomainSpec, prior: { noise: number; volatility: number }): { noise: number; volatility: number } {
  if (!key || key.count === 0) return prior;
  const [n, sd, sdd, sz, sdz] = key.moments;
  if (domain.family === 'bernoulli') {
    return { noise: 0.25, volatility: Math.max(1e-9, (sdz + prior.volatility) / (sdd + 1)) };
  }
  const a = n + 1;
  const b = sd;
  const d = sdd + 1;
  const determinant = a * d - b * b;
  const floor = noiseFloor(domain);
  const noise = (d * (sz + prior.noise) - b * (sdz + prior.volatility)) / determinant;
  const volatility = (a * (sdz + prior.volatility) - b * (sz + prior.noise)) / determinant;
  // Constrained least squares: a value held at its bound, the other is fitted again given it.
  if (noise < floor) return { noise: floor, volatility: Math.max(1e-9, (sdz - floor * sd + prior.volatility) / d) };
  if (volatility < 1e-9) return { noise: Math.max(floor, (sz - 1e-9 * sd + prior.noise) / a), volatility: 1e-9 };
  return { noise, volatility };
}

/**
 * The least outcome noise. On the valence scale it is the square of the stationary band (§2.1): a difference in how
 * good something was that is smaller than her ordinary fluctuation cannot be told apart, so it is not a surprise.
 * Elsewhere a ten-thousandth of the scale's variance keeps the arithmetic finite.
 */
function noiseFloor(domain: PredictionDomainSpec): number {
  return domain.valence ? SHANNON_EMOTION_CONTINUITY.settledBelow ** 2 : scaleVariance(domain) * 1e-4;
}

/**
 * Adds one innovation to the key's moments. The first outcome of a fresh cause is left out: its error measures how
 * well the other keys' prior fitted this key, not this key's own noise or volatility.
 */
export function noteInnovation(key: KeyState, domain: PredictionDomainSpec, cause: Cause, y: number, at: number): void {
  if (cause.count === 0) return;
  const dt = Math.max(0, at - cause.lastAt) / DAY;
  const bernoulliVariance = domain.family === 'bernoulli' ? cause.mean * (1 - cause.mean) : 0;
  const z = (y - cause.mean) ** 2 - cause.variance - bernoulliVariance;
  const moments = key.moments;
  moments[0] += 1; moments[1] += dt; moments[2] += dt * dt; moments[3] += z; moments[4] += dt * z;
}

/** Gaussian elimination with partial pivoting; the systems here are at most 3 × 3 and positive definite. */
function solve(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const lead = rows[column]![column]!;
    if (Math.abs(lead) < 1e-15) continue;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row]![column]! / lead;
      for (let index = column; index <= size; index += 1) rows[row]![index]! -= factor * rows[column]![index]!;
    }
  }
  return rows.map((row, index) => (Math.abs(row[index]!) < 1e-15 ? 0 : row[size]! / row[index]!));
}

function sampleVariance(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

export const finite = (value: number | undefined, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
export const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
