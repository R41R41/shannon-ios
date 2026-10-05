import { describe, expect, it } from 'vitest';
import {
  SHANNON_PREDICTION_COEFFICIENTS,
  SHANNON_PREDICTION_DOMAINS,
  createPredictionModel,
  observeOutcome,
  predictOutcome,
  scaleVariance,
  type PredictionModel,
  type PredictionObservation,
} from '../src/index.js';

/**
 * The prediction layer of Syzygy ADR-0006 §1, stage 1: deterministic simulations of what the layer must show before
 * anything acts on it (habituation; extinction, spontaneous recovery and renewal; volatility; empirical-Bayes priors,
 * also from related information, owner answer 8).
 */
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function run(observations: readonly PredictionObservation[], model: PredictionModel = createPredictionModel()) {
  return { model, updates: observations.map(observation => observeOutcome(model, observation)) };
}

/** Forty pleasant outcomes in context A, a week later forty unpleasant ones (abruptly, or stepping down gradually first). */
function extinction(options: { extinctionContext: string; gradual: boolean }) {
  const model = createPredictionModel();
  let at = 0;
  for (let index = 0; index < 40; index += 1) { observeOutcome(model, { domain: 'touch', key: 'k', at, outcome: 0.8, context: 'A' }); at += MINUTE; }
  at = 7 * DAY;
  const steps = options.gradual ? Array.from({ length: 20 }, (_, index) => 0.8 - (1.4 * (index + 1)) / 20) : [];
  for (const outcome of [...steps, ...new Array<number>(40).fill(-0.6)]) {
    observeOutcome(model, { domain: 'touch', key: 'k', at, outcome, context: options.extinctionContext });
    at += MINUTE;
  }
  const read = (context: string, later = 0) => predictOutcome(model, { domain: 'touch', key: 'k', at: at + later, context });
  return { model, end: at, read };
}

describe('the prediction layer', () => {
  it('is deterministic: the same outcomes in the same order give the same expectations', () => {
    const script: PredictionObservation[] = Array.from({ length: 60 }, (_, index) => ({
      domain: index % 3 ? 'touch' : 'reply', key: `k${index % 4}`, at: index * 7 * MINUTE, outcome: index % 5 ? 0.4 : index % 2 ? 1 : -0.3,
      context: index % 2 ? 'A' : 'B', features: { closeness: (index % 10) / 10, talk: 0.5 },
    }));
    expect(JSON.stringify(run(script).updates)).toBe(JSON.stringify(run(script).updates));
    expect(predictOutcome(run(script).model, { domain: 'touch', key: 'k1', at: DAY }))
      .toEqual(predictOutcome(run(script).model, { domain: 'touch', key: 'k1', at: DAY }));
  });

  it('habituates: the same outcome again and again surprises less and less', () => {
    const { updates } = run(Array.from({ length: 20 }, (_, index) => ({ domain: 'touch' as const, key: 'pet.head.owner', at: index * 30_000, outcome: 0.5 })));
    const errors = updates.map(update => Math.abs(update.error));
    expect(errors[0]).toBeCloseTo(0.5, 6);
    for (let index = 1; index < errors.length; index += 1) expect(errors[index]!).toBeLessThan(errors[index - 1]!);
    expect(errors.at(-1)!).toBeLessThan(0.01 * errors[0]!);
    // An unexpected outcome after that is a large surprise again.
    const model = run(updates.map((_, index) => ({ domain: 'touch' as const, key: 'p', at: index * 30_000, outcome: 0.5 }))).model;
    expect(Math.abs(observeOutcome(model, { domain: 'touch', key: 'p', at: 20 * 30_000, outcome: -0.5 }).error)).toBeGreaterThan(0.9);
  });

  it('learns extinction as a new cause, which then recovers with time (spontaneous recovery) and in the first context (renewal)', () => {
    const same = extinction({ extinctionContext: 'A', gradual: false });
    const now = same.read('A');
    const later = same.read('A', 60 * DAY);
    expect(now.causes).toBe(2);
    expect(now.expectation).toBeLessThan(-0.3);
    // Two months later the newer cause has lost its recency advantage: the pleasant expectation comes back.
    expect(later.expectation).toBeGreaterThan(now.expectation + 0.4);
    expect(later.expectation).toBeGreaterThan(0);
    // ABA: extinguished in B, tested in A at once.
    const renewal = extinction({ extinctionContext: 'B', gradual: false });
    expect(renewal.read('B').expectation).toBeLessThan(-0.5);
    expect(renewal.read('A').expectation).toBeGreaterThan(0.2);
  });

  it('recovers less after a gradual extinction, which rewrites the old cause instead (Gershman et al. 2013)', () => {
    const abrupt = extinction({ extinctionContext: 'A', gradual: false });
    const gradual = extinction({ extinctionContext: 'A', gradual: true });
    const recovery = (item: typeof abrupt) => item.read('A', 60 * DAY).expectation - item.read('A').expectation;
    expect(recovery(gradual)).toBeLessThan(recovery(abrupt) - 0.2);
  });

  it('learns faster where outcomes keep changing (volatility), and grows unsure with wall-clock time', () => {
    const DRIFT = [0, 0.15, 0.3, 0.15, 0, -0.15, -0.3, -0.45, -0.3, -0.15];
    const model = createPredictionModel();
    for (let day = 0; day < 40; day += 1) {
      observeOutcome(model, { domain: 'touch', key: 'stable', at: day * DAY, outcome: 0.3 });
      // A slow drift: small steps that one cause follows (large jumps would be new causes, not volatility).
      observeOutcome(model, { domain: 'touch', key: 'volatile', at: day * DAY + 1, outcome: DRIFT[day % DRIFT.length]! });
    }
    const stable = predictOutcome(model, { domain: 'touch', key: 'stable', at: 40 * DAY });
    const volatile = predictOutcome(model, { domain: 'touch', key: 'volatile', at: 40 * DAY });
    expect(volatile.volatility).toBeGreaterThan(stable.volatility * 1_000);
    expect(volatile.causes).toBe(1);
    const rate = (key: string) => observeOutcome(model, { domain: 'touch', key, at: 40 * DAY + 2, outcome: 0 }).learningRate;
    expect(rate('volatile')).toBeGreaterThan(rate('stable'));
    expect(predictOutcome(model, { domain: 'touch', key: 'stable', at: 100 * DAY }).uncertainty)
      .toBeGreaterThan(predictOutcome(model, { domain: 'touch', key: 'stable', at: 41 * DAY }).uncertainty);
  });

  it('starts a new key from its domain (empirical Bayes), and an empty domain from the unbiased spread of the scale', () => {
    const empty = predictOutcome(createPredictionModel(), { domain: 'touch', key: 'new', at: 0 });
    expect(empty.expectation).toBe(0);
    expect(empty.uncertainty).toBeCloseTo(scaleVariance(SHANNON_PREDICTION_DOMAINS.touch), 9);
    expect(predictOutcome(createPredictionModel(), { domain: 'reply', key: 'new', at: 0 }).expectation).toBe(0.5);
    const model = createPredictionModel();
    for (const [key, outcome] of [['a', 0.6], ['b', 0.55], ['c', 0.65]] as const) {
      for (let index = 0; index < 8; index += 1) observeOutcome(model, { domain: 'touch', key, at: index * MINUTE, outcome });
    }
    const fresh = predictOutcome(model, { domain: 'touch', key: 'unseen', at: 10 * MINUTE });
    expect(fresh.count).toBe(0);
    expect(fresh.expectation).toBeGreaterThan(0.5);
    // The other keys agree, so the new key starts far surer than the unbiased spread.
    expect(fresh.uncertainty).toBeLessThan(scaleVariance(SHANNON_PREDICTION_DOMAINS.touch) / 4);
  });

  it('seeds the prior of the reply domain from closeness and how often they talk (owner answer 8)', () => {
    const model = createPredictionModel();
    let at = 0;
    for (let index = 0; index < 40; index += 1) {
      const close = index % 2 === 0;
      observeOutcome(model, {
        domain: 'reply', key: `share.${['morning', 'evening'][index % 4 < 2 ? 0 : 1]}.body`, at, outcome: close ? 1 : 0,
        features: close ? { closeness: 0.9, talk: 0.8 } : { closeness: 0.2, talk: 0.1 },
      });
      at += 3 * 60 * MINUTE;
    }
    const near = predictOutcome(model, { domain: 'reply', key: 'wonder.night.iphone', at, features: { closeness: 0.9, talk: 0.8 } });
    const far = predictOutcome(model, { domain: 'reply', key: 'wonder.night.iphone', at, features: { closeness: 0.2, talk: 0.1 } });
    expect(near.count).toBe(0);
    expect(near.expectation).toBeGreaterThan(0.7);
    expect(far.expectation).toBeLessThan(0.3);
    // Without features the prior is the domain's mean.
    expect(predictOutcome(model, { domain: 'reply', key: 'wonder.night.iphone', at }).expectation).toBeCloseTo(0.5, 1);
    expect(SHANNON_PREDICTION_DOMAINS.reply.features).toEqual(['closeness', 'talk']);
  });

  it('measures reply times on a log scale, and keeps yes/no expectations inside (0, 1)', () => {
    const model = createPredictionModel();
    for (let index = 0; index < 10; index += 1) observeOutcome(model, { domain: 'reply_time', key: 'k', at: index * DAY, outcome: 2_400 });
    expect(Math.exp(predictOutcome(model, { domain: 'reply_time', key: 'k', at: 10 * DAY }).expectation)).toBeGreaterThan(1_800);
    for (let index = 0; index < 50; index += 1) {
      const update = observeOutcome(model, { domain: 'reply', key: 'k', at: index * MINUTE, outcome: 1 });
      expect(update.expectation).toBeGreaterThan(0);
      expect(update.expectation).toBeLessThan(1);
    }
  });

  it('names where each of its coefficients comes from', () => {
    expect(SHANNON_PREDICTION_COEFFICIENTS.arousalGain).toBe(0);
    expect(SHANNON_PREDICTION_COEFFICIENTS.newCause).toBeGreaterThan(0);
    expect(SHANNON_PREDICTION_COEFFICIENTS.emptyVolatilityDays).toBe(30);
  });
});
