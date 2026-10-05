import { SHANNON_EMOTION_CONTINUITY } from './emotionTime.js';
import { SHARED_DAY_WINDOW } from './temperament.js';

/**
 * The prediction layer (Syzygy ADR-0006 §1). Core: emotion.
 *
 * "Next time it will probably be like this", held as an expectation together with how sure she is
 * of it. When the outcome arrives the expectation moves by as much as it was wrong, and more when
 * she was unsure (Rescorla & Wagner 1972 in its Kalman form: Kakade & Dayan 2002, Gershman 2015).
 *
 * Pure and deterministic: no clock, no store, no randomness. The model is a fold accumulator: the
 * same observations in the same order always give the same model, so a store can recompute it from
 * its outcome rows (and must, after it deleted rows the owner asked her to forget). Outcomes are
 * numbers and keys are closed symbols; nothing here holds or accepts words.
 *
 * Per key, each latent cause is a Kalman predictor with four quantities: expectation (`mean`),
 * uncertainty of the expectation (`variance`), outcome noise and volatility. The last two are shared
 * by the causes of a key and estimated from the key's own innovations:
 *   E[δ²] − uncertainty = noise + volatility × elapsed days,
 * a method-of-moments regression that separates noise from volatility as Piray & Daw (2021) do
 * jointly (their model is a particle filter; this is its simplest deterministic analogue). Elapsed
 * time is the wall clock: the world and people change while she rests. Surprises raise the
 * volatility estimate and so the learning rate, which is the role of Pearce & Hall's (1980)
 * associability and of Behrens et al. (2007) / Mathys et al. (2011) volatility.
 *
 * Learning rate: k = (uncertainty + volatility·Δt) / (that + noise / (1 + g·arousal)), with g = 0
 * until the shadow stage has fitted it (ADR-0006 §1 「覚醒」).
 *
 * Empirical-Bayes priors: a new key, and a new cause, start from its domain. The domain keeps a
 * Bayesian linear regression of outcomes on [1, features − ½] (owner answer 8: related information
 * such as closeness and how often they talk may seed the prior); with no features this is the
 * domain mean. The prior variance is the spread of the other keys' expectations plus the
 * regression's own uncertainty, never more than the unbiased spread of the scale. A domain with no
 * outcomes starts from the uniform distribution over the outcome scale (Beta(1,1) for yes/no).
 *
 * Latent causes (Gershman, Blei & Niv 2010; Gershman et al. 2017), simplified and deterministic:
 * - each outcome goes to the cause with the highest posterior: prior ∝ recency mass × context
 *   match (a Chinese-restaurant prior with a power-law temporal kernel of the form of §2.4), and a
 *   new cause has prior ∝ α and the domain prior as its predictive;
 * - an outcome the assigned cause explains worse than a fresh cause would opens a run; while the
 *   run lasts it also trains a provisional fresh cause, and once the run's evidence for "a new
 *   cause" beats the prior odds (α against the old cause's recency mass), the old cause is restored
 *   to its state before the run and the run becomes the new cause (extinction is learned apart);
 *   an outcome the old cause explains well ends the run (small errors rewrite the cause, as in
 *   reconsolidation; Gershman et al. 2013: gradual extinction does not come back);
 * - the expectation is the mixture of existing causes by the same prior: as time passes the
 *   recency advantage of the newer cause fades and the older, larger cause returns (spontaneous
 *   recovery); in another context the cause learned there loses weight (renewal).
 * The new-cause prior enters the assignment, not the expectation; with no cause yet the expectation
 * is the domain prior.
 */

const DAY = 24 * 3_600_000;

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
 * - `reply_time`: after how long he answers (ln seconds, bounded by the observation's own bound of one day).
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

interface Cause {
  mean: number;
  variance: number;
  count: number;
  lastAt: number;
  /** [instant, weight] of the outcomes it explained, for its recency mass. */
  times: Array<[number, number]>;
  contexts: Record<string, number>;
}

interface Pending { cause: number; before: Cause; fresh: Cause; logSame: number; logNew: number }

interface KeyState {
  causes: Cause[];
  count: number;
  /** Moments of the innovations: Σ1, Σdt, Σdt², Σz, Σdt·z (dt in days; z = δ² − uncertainty, less the Bernoulli variance). */
  moments: [number, number, number, number, number];
  pending: Pending | null;
}

interface DomainState { keys: Map<string, KeyState>; xx: number[][]; xy: number[]; n: number }

/** The fold accumulator. Opaque: read it through `predictOutcome`. */
export interface PredictionModel { readonly domains: Map<string, DomainState> }

export interface PredictionQuery {
  domain: PredictionDomain;
  key: string;
  /** Wall-clock instant (ms). */
  at: number;
  context?: string;
  features?: Readonly<Record<string, number>>;
}

export interface Prediction {
  /** On the domain's scale (ln seconds for `log_time`). */
  expectation: number;
  /** Variance of the expectation. */
  uncertainty: number;
  noise: number;
  /** Per day. */
  volatility: number;
  /** Outcomes seen for this key. */
  count: number;
  causes: number;
}

export interface PredictionObservation extends PredictionQuery {
  /** Raw outcome: 0/1, seconds for `log_time`, valence for `gaussian`. */
  outcome: number;
  /** Arousal when it happened, for g. */
  arousal?: number;
}

export interface PredictionUpdate extends Prediction {
  /** The outcome on the domain's scale. */
  outcome: number;
  /** Outcome − expectation. */
  error: number;
  learningRate: number;
  /** Index of the cause that took the outcome, after any split. */
  cause: number;
  newCause: boolean;
}

export function createPredictionModel(): PredictionModel {
  return { domains: new Map() };
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

/** What she expects for this key now, without learning anything. */
export function predictOutcome(model: PredictionModel, query: PredictionQuery): Prediction {
  const domain = SHANNON_PREDICTION_DOMAINS[query.domain];
  const state = model.domains.get(query.domain);
  const key = state?.keys.get(query.key);
  const noiseVolatility = keyNoiseVolatility(key, domain, domainNoiseVolatility(state, domain));
  if (!state || !key || key.causes.length === 0) {
    const prior = domainPrior(state, domain, query.features);
    return { ...prior, noise: noiseVolatility.noise, volatility: noiseVolatility.volatility, count: 0, causes: 0 };
  }
  const mixture = causeMixture(key, query.at, query.context ?? '', noiseVolatility.volatility);
  return { ...mixture, noise: noiseVolatility.noise, volatility: noiseVolatility.volatility, count: key.count, causes: key.causes.length };
}

/** Learns one outcome. Returns what was expected before it, and how it was taken. */
export function observeOutcome(model: PredictionModel, observation: PredictionObservation): PredictionUpdate {
  const domain = SHANNON_PREDICTION_DOMAINS[observation.domain];
  const state = ensureDomain(model, observation.domain, domain);
  let key = state.keys.get(observation.key);
  if (!key) { key = { causes: [], count: 0, moments: [0, 0, 0, 0, 0], pending: null }; state.keys.set(observation.key, key); }
  const y = transformedOutcome(domain, observation.outcome);
  const at = observation.at;
  const context = observation.context ?? '';
  const prior = domainPrior(state, domain, observation.features);
  const { noise, volatility } = keyNoiseVolatility(key, domain, domainNoiseVolatility(state, domain));
  const before = key.causes.length ? causeMixture(key, at, context, volatility) : { expectation: prior.expectation, uncertainty: prior.uncertainty };
  const learn = { noise, volatility, arousal: observation.arousal ?? 0, context, domain, at };
  const coefficients = SHANNON_PREDICTION_COEFFICIENTS;
  const contextCount = contextKinds(key);
  const newLog = Math.log(coefficients.newCause) - Math.log(contextCount) + logLikelihood(domain, y, prior.expectation, prior.uncertainty, noise);
  let best = -1;
  let bestScore = newLog;
  const scores = key.causes.map((cause, index) => {
    const fit = logLikelihood(domain, y, cause.mean, predictiveVariance(cause, at, volatility), noise);
    const score = Math.log(Math.max(1e-300, recencyMass(cause, at))) + Math.log(contextMatch(cause, context, contextCount)) + fit;
    if (score > bestScore) { best = index; bestScore = score; }
    return fit;
  });
  let learningRate: number;
  let cause = best;
  let newCause = false;
  if (best < 0) {
    const fresh = freshCause(prior, at);
    noteInnovation(key, domain, fresh, y, at);
    learningRate = updateCause(fresh, y, learn);
    key.causes.push(fresh);
    key.pending = null;
    cause = key.causes.length - 1;
    newCause = true;
  } else {
    const assigned = key.causes[best]!;
    const fit = scores[best]!;
    const freshFit = logLikelihood(domain, y, prior.expectation, prior.uncertainty, noise);
    noteInnovation(key, domain, assigned, y, at);
    if (fit < freshFit) {
      if (!key.pending || key.pending.cause !== best) {
        key.pending = { cause: best, before: cloneCause(assigned), fresh: freshCause(prior, at), logSame: 0, logNew: 0 };
      }
      const pending = key.pending;
      pending.logSame += fit;
      pending.logNew += logLikelihood(domain, y, pending.fresh.mean, predictiveVariance(pending.fresh, at, volatility), noise);
      const freshRate = updateCause(pending.fresh, y, learn);
      learningRate = updateCause(assigned, y, learn);
      const oldOdds = Math.log(Math.max(1e-300, recencyMass(pending.before, at))) + Math.log(contextMatch(pending.before, context, contextCount));
      if (pending.logNew + Math.log(coefficients.newCause) - Math.log(contextCount) >= pending.logSame + oldOdds) {
        key.causes[best] = pending.before;
        key.causes.push(pending.fresh);
        cause = key.causes.length - 1;
        learningRate = freshRate;
        newCause = true;
        key.pending = null;
      }
    } else {
      key.pending = null;
      learningRate = updateCause(assigned, y, learn);
    }
  }
  key.count += 1;
  learnRegression(state, domain, observation.features, y);
  return {
    expectation: before.expectation, uncertainty: before.uncertainty, noise, volatility, outcome: y,
    error: y - before.expectation, learningRate, cause, newCause, count: key.count, causes: key.causes.length,
  };
}

function ensureDomain(model: PredictionModel, name: string, domain: PredictionDomainSpec): DomainState {
  let state = model.domains.get(name);
  if (!state) {
    const size = 1 + domain.features.length;
    state = { keys: new Map(), xx: Array.from({ length: size }, () => new Array<number>(size).fill(0)), xy: new Array<number>(size).fill(0), n: 0 };
    model.domains.set(name, state);
  }
  return state;
}

function featureVector(domain: PredictionDomainSpec, features: Readonly<Record<string, number>> | undefined): number[] {
  return [1, ...domain.features.map(name => clamp(finite(features?.[name], 0.5), 0, 1) - 0.5)];
}

function learnRegression(state: DomainState, domain: PredictionDomainSpec, features: Readonly<Record<string, number>> | undefined, y: number): void {
  const x = featureVector(domain, features);
  for (let row = 0; row < x.length; row += 1) {
    state.xy[row]! += x[row]! * y;
    for (let column = 0; column < x.length; column += 1) state.xx[row]![column]! += x[row]! * x[column]!;
  }
  state.n += 1;
}

/**
 * The prior of a new key or a new cause: the domain's regression on its features (with no features, its mean),
 * with the spread of the other keys' expectations and the regression's own uncertainty, never wider than the scale.
 */
function domainPrior(state: DomainState | undefined, domain: PredictionDomainSpec, features: Readonly<Record<string, number>> | undefined): { expectation: number; uncertainty: number } {
  const scale = scaleVariance(domain);
  const middle = (domain.lower + domain.upper) / 2;
  const x = featureVector(domain, features);
  if (!state || state.n === 0) return { expectation: middle, uncertainty: boundedVariance(domain, middle, scale) };
  const noise = domain.family === 'bernoulli' ? 0.25 : domainNoiseVolatility(state, domain).noise;
  const size = x.length;
  const precision = state.xx.map((row, i) => row.map((value, j) => value / noise + (i === j ? 1 / scale : 0)));
  const target = state.xy.map((value, i) => value / noise + (i === 0 ? middle / scale : 0));
  const beta = solve(precision, target);
  const spreadOfX = solve(precision, x);
  let mean = 0;
  let parameterVariance = 0;
  for (let i = 0; i < size; i += 1) { mean += beta[i]! * x[i]!; parameterVariance += x[i]! * spreadOfX[i]!; }
  mean = clamp(mean, domain.lower, domain.upper);
  if (domain.family === 'bernoulli') mean = clamp(mean, 1 / (state.n + 2), (state.n + 1) / (state.n + 2));
  const means = [...state.keys.values()].filter(key => key.causes.length > 0).map(dominantMean);
  const spread = means.length >= 2 ? sampleVariance(means) : scale;
  return { expectation: mean, uncertainty: boundedVariance(domain, mean, Math.min(scale, spread + Math.max(0, parameterVariance))) };
}

const dominantMean = (key: KeyState): number => key.causes.reduce((best, cause) => (cause.count > best.count ? cause : best)).mean;

/** A yes/no expectation is never held less firmly than the uniform prior holds it (Beta(1,1): mean·(1 − mean)/3). */
function boundedVariance(domain: PredictionDomainSpec, mean: number, variance: number): number {
  const value = Math.max(1e-12, variance);
  return domain.family === 'bernoulli' ? Math.min(value, Math.max(1e-12, mean * (1 - mean) / 3)) : value;
}

/** The domain's average noise and volatility over keys that have outcomes; for an empty domain, the unbiased ones. */
function domainNoiseVolatility(state: DomainState | undefined, domain: PredictionDomainSpec): { noise: number; volatility: number } {
  const empty = { noise: domain.family === 'bernoulli' ? 0.25 : scaleVariance(domain), volatility: scaleVariance(domain) / SHANNON_PREDICTION_COEFFICIENTS.emptyVolatilityDays };
  const keys = state ? [...state.keys.values()].filter(key => key.count > 0) : [];
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
function keyNoiseVolatility(key: KeyState | undefined, domain: PredictionDomainSpec, prior: { noise: number; volatility: number }): { noise: number; volatility: number } {
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

function noteInnovation(key: KeyState, domain: PredictionDomainSpec, cause: Cause, y: number, at: number): void {
  const dt = cause.count > 0 ? Math.max(0, at - cause.lastAt) / DAY : 0;
  const bernoulliVariance = domain.family === 'bernoulli' ? cause.mean * (1 - cause.mean) : 0;
  const z = (y - cause.mean) ** 2 - cause.variance - bernoulliVariance;
  const moments = key.moments;
  moments[0] += 1; moments[1] += dt; moments[2] += dt * dt; moments[3] += z; moments[4] += dt * z;
}

function freshCause(prior: { expectation: number; uncertainty: number }, at: number): Cause {
  return { mean: prior.expectation, variance: prior.uncertainty, count: 0, lastAt: at, times: [], contexts: {} };
}

function cloneCause(cause: Cause): Cause {
  return { ...cause, times: cause.times.map(([at, weight]) => [at, weight]), contexts: { ...cause.contexts } };
}

function predictiveVariance(cause: Cause, at: number, volatility: number): number {
  return cause.variance + (cause.count > 0 ? volatility * Math.max(0, at - cause.lastAt) / DAY : 0);
}

/** One Kalman step. Returns the learning rate. */
function updateCause(
  cause: Cause, y: number,
  learn: { noise: number; volatility: number; arousal: number; context: string; domain: PredictionDomainSpec; at: number },
): number {
  const prior = predictiveVariance(cause, learn.at, learn.volatility);
  const bernoulli = learn.domain.family === 'bernoulli';
  const uncertainty = bernoulli ? boundedVariance(learn.domain, cause.mean, prior) : prior;
  const noise = (bernoulli ? Math.max(1e-6, cause.mean * (1 - cause.mean)) : learn.noise)
    / (1 + SHANNON_PREDICTION_COEFFICIENTS.arousalGain * Math.max(0, learn.arousal));
  const rate = uncertainty / (uncertainty + noise);
  cause.mean += rate * (y - cause.mean);
  if (bernoulli) cause.mean = clamp(cause.mean, 1e-6, 1 - 1e-6);
  cause.variance = boundedVariance(learn.domain, cause.mean, (1 - rate) * uncertainty);
  cause.count += 1;
  cause.lastAt = Math.max(cause.lastAt, learn.at);
  cause.times.push([learn.at, 1]);
  compressTimes(cause.times);
  cause.contexts[learn.context] = (cause.contexts[learn.context] ?? 0) + 1;
  return rate;
}

/** Keeps the newest instants exact and merges the two oldest by weight. */
function compressTimes(times: Array<[number, number]>): void {
  while (times.length > SHANNON_PREDICTION_COEFFICIENTS.kernelMemory) {
    const [first, second] = [times[0]!, times[1]!];
    const weight = first[1] + second[1];
    times.splice(0, 2, [(first[0] * first[1] + second[0] * second[1]) / weight, weight]);
  }
}

/** Σ K(at − t) over the outcomes a cause explained. */
function recencyMass(cause: Cause, at: number): number {
  const { recencyMs, recencyExponent } = SHANNON_PREDICTION_COEFFICIENTS;
  return cause.times.reduce((sum, [time, weight]) => sum + weight * (1 + Math.max(0, at - time) / recencyMs) ** -recencyExponent, 0);
}

/** How many contexts a key has seen, plus one for an unseen one. */
function contextKinds(key: KeyState): number {
  const seen = new Set<string>();
  for (const cause of key.causes) for (const name of Object.keys(cause.contexts)) seen.add(name);
  return seen.size + 1;
}

/** Laplace-smoothed share of the cause's outcomes seen in this context. */
function contextMatch(cause: Cause, context: string, kinds: number): number {
  return ((cause.contexts[context] ?? 0) + 1) / (cause.count + kinds);
}

function causeMixture(key: KeyState, at: number, context: string, volatility: number): { expectation: number; uncertainty: number } {
  const kinds = contextKinds(key);
  const weights = key.causes.map(cause => recencyMass(cause, at) * contextMatch(cause, context, kinds));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const share = total > 0 ? weights.map(value => value / total) : key.causes.map(() => 1 / key.causes.length);
  let expectation = 0;
  let second = 0;
  key.causes.forEach((cause, index) => {
    expectation += share[index]! * cause.mean;
    second += share[index]! * (predictiveVariance(cause, at, volatility) + cause.mean ** 2);
  });
  return { expectation, uncertainty: Math.max(1e-12, second - expectation ** 2) };
}

function logLikelihood(domain: PredictionDomainSpec, y: number, mean: number, variance: number, noise: number): number {
  if (domain.family === 'bernoulli') return Math.log(Math.max(1e-12, y >= 0.5 ? mean : 1 - mean));
  const total = Math.max(1e-12, variance + noise);
  return -0.5 * (Math.log(2 * Math.PI * total) + (y - mean) ** 2 / total);
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

const finite = (value: number | undefined, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
