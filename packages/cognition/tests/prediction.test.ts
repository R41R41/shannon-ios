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
import { domainPrior } from '../src/predictionDomains.js';

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
    // A random walk whose steps grow with the time between outcomes (gaps of an hour and of three days, so that noise and
    // volatility can be told apart), beside a key that never changes.
    const SIGNS = [1, 1, -1, 1, -1, -1, 1, -1, -1, 1, 1, -1];
    const model = createPredictionModel();
    let at = 0;
    let walk = 0;
    for (let index = 0; index < 60; index += 1) {
      const gap = index % 2 ? 3 : 0.05;
      at += gap * DAY;
      walk = Math.max(-0.9, Math.min(0.9, walk + SIGNS[index % SIGNS.length]! * 0.15 * Math.sqrt(gap)));
      observeOutcome(model, { domain: 'touch', key: 'stable', at, outcome: 0.3 });
      observeOutcome(model, { domain: 'touch', key: 'volatile', at: at + 1, outcome: walk });
    }
    const stable = predictOutcome(model, { domain: 'touch', key: 'stable', at: at + DAY });
    const volatile = predictOutcome(model, { domain: 'touch', key: 'volatile', at: at + DAY });
    expect(volatile.volatility).toBeGreaterThan(stable.volatility * 1_000);
    expect(volatile.causes).toBe(1);
    const rate = (key: string) => observeOutcome(model, { domain: 'touch', key, at: at + 2 * DAY, outcome: 0 }).learningRate;
    expect(rate('volatile')).toBeGreaterThan(rate('stable'));
    expect(predictOutcome(model, { domain: 'touch', key: 'stable', at: at + 300 * DAY }).uncertainty)
      .toBeGreaterThan(predictOutcome(model, { domain: 'touch', key: 'stable', at: at + 3 * DAY }).uncertainty);
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

  it('learns yes/no like a Beta posterior: k falls as evidence accumulates, and time with volatility lifts it again', () => {
    const history = (model: PredictionModel) => {
      const rates: number[] = [];
      for (let index = 0; index < 50; index += 1) rates.push(observeOutcome(model, { domain: 'owner_present', key: 'evening', at: index * MINUTE, outcome: index % 4 ? 1 : 0 }).learningRate);
      return rates;
    };
    const rates = history(createPredictionModel());
    // Beta(1,1) first: 1/3, then 1/(strength + 1).
    expect(rates[0]).toBeCloseTo(1 / 3, 9);
    for (let index = 1; index < rates.length; index += 1) expect(rates[index]!).toBeLessThan(rates[index - 1]!);
    expect(rates.at(-1)!).toBeLessThan(0.05);
    const soon = createPredictionModel();
    history(soon);
    const late = createPredictionModel();
    history(late);
    const next = (model: PredictionModel, gap: number) => observeOutcome(model, { domain: 'owner_present', key: 'evening', at: 49 * MINUTE + gap, outcome: 1 }).learningRate;
    expect(next(late, 60 * DAY)).toBeGreaterThan(next(soon, MINUTE) * 2);
  });

  it('never holds an expectation less surely than the unbiased spread of its scale', () => {
    const model = createPredictionModel();
    observeOutcome(model, { domain: 'touch', key: 'k', at: 0, outcome: 0.5 });
    observeOutcome(model, { domain: 'reply_time', key: 'k', at: 0, outcome: 60 });
    for (const domain of ['touch', 'reply_time'] as const) {
      const far = predictOutcome(model, { domain, key: 'k', at: 10_000 * DAY });
      expect(far.uncertainty).toBeLessThanOrEqual(scaleVariance(SHANNON_PREDICTION_DOMAINS[domain]) + 1e-12);
    }
  });

  it('takes a prior from the other keys of the domain, never from the key itself', () => {
    const model = createPredictionModel();
    for (let index = 0; index < 20; index += 1) {
      observeOutcome(model, { domain: 'touch', key: 'a', at: index * MINUTE, outcome: 0.8 });
      observeOutcome(model, { domain: 'touch', key: 'b', at: index * MINUTE, outcome: -0.4 });
    }
    const state = model.domains.get('touch')!;
    const spec = SHANNON_PREDICTION_DOMAINS.touch;
    // For a new cause of `a`, the prior is `b`'s, and the other way round.
    expect(domainPrior(state, spec, undefined, state.keys.get('a')).expectation).toBeLessThan(-0.3);
    expect(domainPrior(state, spec, undefined, state.keys.get('b')).expectation).toBeGreaterThan(0.7);
    // A key alone in its domain starts a new cause from the unbiased prior.
    const lone = createPredictionModel();
    for (let index = 0; index < 20; index += 1) observeOutcome(lone, { domain: 'touch', key: 'only', at: index * MINUTE, outcome: 0.8 });
    const only = lone.domains.get('touch')!;
    expect(domainPrior(only, spec, undefined, only.keys.get('only'))).toEqual({ expectation: 0, uncertainty: scaleVariance(spec) });
  });

  it('lets a new key that differs from the others reach its own truth in a few outcomes', () => {
    for (const others of [['pet.head.owner', 'pet.cheek.owner'], ['pet.head.owner', 'pet.cheek.owner', 'pet.hand.owner']]) {
      const model = createPredictionModel();
      let at = 0;
      for (let index = 0; index < 30; index += 1) {
        for (const [order, key] of others.entries()) observeOutcome(model, { domain: 'touch', key, at: at + order, outcome: 0.5 + (order - 1) * 0.02 });
        at += MINUTE;
      }
      const updates = Array.from({ length: 8 }, (_, index) => observeOutcome(model, { domain: 'touch', key: 'poke.face.owner', at: at + index * MINUTE, outcome: -0.1 }));
      const after = (count: number) => Math.abs(updates[count]!.expectation + 0.1);
      // The first outcome is a surprise against the others' +0.5. Five outcomes later she is within 0.15 of −0.1 and
      // eight later within 0.1 (before the prior took the others' own uncertainty and a floor, it was not there after a hundred).
      expect(updates[0]!.expectation).toBeGreaterThan(0.3);
      expect(updates[1]!.learningRate).toBeGreaterThan(0.2);
      expect(after(5), `${others.length} other keys`).toBeLessThan(0.15);
      expect(Math.abs(predictOutcome(model, { domain: 'touch', key: 'poke.face.owner', at: at + 8 * MINUTE }).expectation + 0.1), `${others.length} other keys`).toBeLessThan(0.1);
    }
  });

  it('names where each of its coefficients comes from', () => {
    expect(SHANNON_PREDICTION_COEFFICIENTS.arousalGain).toBe(0);
    expect(SHANNON_PREDICTION_COEFFICIENTS.newCause).toBeGreaterThan(0);
    expect(SHANNON_PREDICTION_COEFFICIENTS.emptyVolatilityDays).toBe(30);
  });
});
