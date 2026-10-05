import {
  DAY,
  SHANNON_PREDICTION_COEFFICIENTS,
  SHANNON_PREDICTION_DOMAINS,
  betaStrength,
  boundedVariance,
  clamp,
  domainNoiseVolatility,
  domainPrior,
  emptyRegression,
  keyNoiseVolatility,
  learnRegression,
  noteInnovation,
  transformedOutcome,
  type Cause,
  type DomainState,
  type KeyState,
  type PredictionDomain,
  type PredictionDomainSpec,
} from './predictionDomains.js';

export {
  SHANNON_PREDICTION_COEFFICIENTS,
  SHANNON_PREDICTION_DOMAINS,
  isPredictionDomain,
  scaleVariance,
  transformedOutcome,
  type PredictionDomain,
  type PredictionDomainSpec,
  type PredictionFamily,
} from './predictionDomains.js';

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
 * until the shadow stage has fitted it (ADR-0006 §1 「覚醒」). A yes/no expectation is a Beta posterior:
 * its strength a + b grows by one per outcome and k = 1/(strength + 1) falls as evidence accumulates,
 * while volatility × elapsed time widens it again (fewer effective outcomes, a larger k).
 *
 * Priors, noise and volatility are in `predictionDomains.ts` (empirical Bayes from the other keys of
 * the domain, owner answer 8).
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

/** What she expects for this key now, without learning anything. */
export function predictOutcome(model: PredictionModel, query: PredictionQuery): Prediction {
  const domain = SHANNON_PREDICTION_DOMAINS[query.domain];
  const state = model.domains.get(query.domain);
  const key = state?.keys.get(query.key);
  const noiseVolatility = keyNoiseVolatility(key, domain, domainNoiseVolatility(state, domain));
  if (!state || !key || key.causes.length === 0) {
    const prior = domainPrior(state, domain, query.features, key);
    return { ...prior, noise: noiseVolatility.noise, volatility: noiseVolatility.volatility, count: 0, causes: 0 };
  }
  const mixture = causeMixture(key, domain, query.at, query.context ?? '', noiseVolatility.volatility);
  return { ...mixture, noise: noiseVolatility.noise, volatility: noiseVolatility.volatility, count: key.count, causes: key.causes.length };
}

/** Learns one outcome. Returns what was expected before it, and how it was taken. */
export function observeOutcome(model: PredictionModel, observation: PredictionObservation): PredictionUpdate {
  const domain = SHANNON_PREDICTION_DOMAINS[observation.domain];
  const state = ensureDomain(model, observation.domain, domain);
  let key = state.keys.get(observation.key);
  if (!key) { key = { causes: [], count: 0, moments: [0, 0, 0, 0, 0], pending: null, regression: emptyRegression(domain) }; state.keys.set(observation.key, key); }
  const y = transformedOutcome(domain, observation.outcome);
  const at = observation.at;
  const context = observation.context ?? '';
  const prior = domainPrior(state, domain, observation.features, key);
  const { noise, volatility } = keyNoiseVolatility(key, domain, domainNoiseVolatility(state, domain));
  const before = key.causes.length ? causeMixture(key, domain, at, context, volatility) : { expectation: prior.expectation, uncertainty: prior.uncertainty };
  const learn = { noise, volatility, arousal: observation.arousal ?? 0, context, domain, at };
  const coefficients = SHANNON_PREDICTION_COEFFICIENTS;
  const contextCount = contextKinds(key);
  const newLog = Math.log(coefficients.newCause) - Math.log(contextCount) + logLikelihood(domain, y, prior.expectation, prior.uncertainty, noise);
  let best = -1;
  let bestScore = newLog;
  const scores = key.causes.map((cause, index) => {
    const fit = logLikelihood(domain, y, cause.mean, predictiveVariance(cause, domain, at, volatility), noise);
    const score = Math.log(Math.max(1e-300, recencyMass(cause, at))) + Math.log(contextMatch(cause, context, contextCount)) + fit;
    if (score > bestScore) { best = index; bestScore = score; }
    return fit;
  });
  let learningRate: number;
  let cause = best;
  let newCause = false;
  if (best < 0) {
    const fresh = freshCause(domain, prior, at);
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
        key.pending = { cause: best, before: cloneCause(assigned), fresh: freshCause(domain, prior, at), logSame: 0, logNew: 0 };
      }
      const pending = key.pending;
      pending.logSame += fit;
      pending.logNew += logLikelihood(domain, y, pending.fresh.mean, predictiveVariance(pending.fresh, domain, at, volatility), noise);
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
  learnRegression(state, key, domain, observation.features, y);
  return {
    expectation: before.expectation, uncertainty: before.uncertainty, noise, volatility, outcome: y,
    error: y - before.expectation, learningRate, cause, newCause, count: key.count, causes: key.causes.length,
  };
}

function ensureDomain(model: PredictionModel, name: string, domain: PredictionDomainSpec): DomainState {
  let state = model.domains.get(name);
  if (!state) {
    state = { keys: new Map(), regression: emptyRegression(domain) };
    model.domains.set(name, state);
  }
  return state;
}

function freshCause(domain: PredictionDomainSpec, prior: { expectation: number; uncertainty: number }, at: number): Cause {
  const variance = boundedVariance(domain, prior.expectation, prior.uncertainty);
  const strength = domain.family === 'bernoulli' ? betaStrength(prior.expectation, variance) : 0;
  return { mean: prior.expectation, variance, strength, count: 0, lastAt: at, times: [], contexts: {} };
}

function cloneCause(cause: Cause): Cause {
  return { ...cause, times: cause.times.map(([at, weight]) => [at, weight]), contexts: { ...cause.contexts } };
}

/** The uncertainty of a cause at an instant: its own, widened by volatility over the wall-clock time since its last outcome, never past the bound. */
function predictiveVariance(cause: Cause, domain: PredictionDomainSpec, at: number, volatility: number): number {
  const own = domain.family === 'bernoulli' ? Math.max(1e-6, cause.mean * (1 - cause.mean)) / (cause.strength + 1) : cause.variance;
  return boundedVariance(domain, cause.mean, own + (cause.count > 0 ? volatility * Math.max(0, at - cause.lastAt) / DAY : 0));
}

/**
 * One learning step. Returns the learning rate. Valence and time: a Kalman step. Yes/no: a Beta posterior whose
 * strength is first reduced by the volatility since its last outcome (the widened variance as an effective count),
 * then grows by one: k = (1 + g·arousal)/(strength + 1 + g·arousal), 1/(strength + 1) with g = 0, as Beta's own update.
 */
function updateCause(
  cause: Cause, y: number,
  learn: { noise: number; volatility: number; arousal: number; context: string; domain: PredictionDomainSpec; at: number },
): number {
  const uncertainty = predictiveVariance(cause, learn.domain, learn.at, learn.volatility);
  const gain = 1 + SHANNON_PREDICTION_COEFFICIENTS.arousalGain * Math.max(0, learn.arousal);
  let rate: number;
  if (learn.domain.family === 'bernoulli') {
    const effective = betaStrength(cause.mean, uncertainty);
    rate = gain / (effective + gain);
    cause.mean = clamp(cause.mean + rate * (y - cause.mean), 1e-6, 1 - 1e-6);
    cause.strength = effective + 1;
    cause.variance = boundedVariance(learn.domain, cause.mean, cause.mean * (1 - cause.mean) / (cause.strength + 1));
  } else {
    rate = uncertainty / (uncertainty + learn.noise / gain);
    cause.mean += rate * (y - cause.mean);
    cause.variance = boundedVariance(learn.domain, cause.mean, (1 - rate) * uncertainty);
  }
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

function causeMixture(key: KeyState, domain: PredictionDomainSpec, at: number, context: string, volatility: number): { expectation: number; uncertainty: number } {
  const kinds = contextKinds(key);
  const weights = key.causes.map(cause => recencyMass(cause, at) * contextMatch(cause, context, kinds));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const share = total > 0 ? weights.map(value => value / total) : key.causes.map(() => 1 / key.causes.length);
  let expectation = 0;
  let second = 0;
  key.causes.forEach((cause, index) => {
    expectation += share[index]! * cause.mean;
    second += share[index]! * (predictiveVariance(cause, domain, at, volatility) + cause.mean ** 2);
  });
  return { expectation, uncertainty: boundedVariance(domain, expectation, second - expectation ** 2) };
}

function logLikelihood(domain: PredictionDomainSpec, y: number, mean: number, variance: number, noise: number): number {
  if (domain.family === 'bernoulli') return Math.log(Math.max(1e-12, y >= 0.5 ? mean : 1 - mean));
  const total = Math.max(1e-12, variance + noise);
  return -0.5 * (Math.log(2 * Math.PI * total) + (y - mean) ** 2 / total);
}
