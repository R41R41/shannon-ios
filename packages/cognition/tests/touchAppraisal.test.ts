import { describe, expect, it } from 'vitest';
import {
  InMemoryCompanionStateStore,
  SHANNON_AFFECT_DYNAMICS,
  SHANNON_MOOD_BASELINE,
  SHANNON_STANCE_OUTCOME,
  appraiseTouch,
  createPredictionModel,
  feelTouch,
  isFeltStartle,
  observeOutcome,
  predictOutcome,
  relativeUncertainty,
  startleArousal,
  touchImpact,
  unexpectedness,
  type ShannonTouch,
} from '../src/index.js';

/** Syzygy ADR-0006 stage 2: a touch's startle and her stance's prediction error (candidate B), with no table for any part. */
const NOW = '2026-10-06T09:00:00.000Z';
const gamma = SHANNON_AFFECT_DYNAMICS.eventForgetting;
const calm = { valence: 0.1, arousal: 0.3, openness: 0.4 };

describe('the prediction layer as a touch meets it', () => {
  it('startles by relative uncertainty: a key she knows nothing of fully, a known one hardly', () => {
    const model = createPredictionModel();
    const query = { domain: 'body_stance' as const, key: 'stroke.head.owner', at: 0 };
    expect(relativeUncertainty(predictOutcome(model, query))).toBeCloseTo(0.5, 9);
    for (let index = 0; index < 20; index += 1) observeOutcome(model, { ...query, at: index * 40_000, outcome: SHANNON_STANCE_OUTCOME.fine });
    const known = relativeUncertainty(predictOutcome(model, { ...query, at: 20 * 40_000 }));
    expect(known).toBeLessThan(0.1);
    expect(isFeltStartle(known)).toBe(false);
  });

  it('measures how unexpected an outcome was on her own predictive distribution', () => {
    expect(unexpectedness({ error: 0, uncertainty: 0.1, noise: 0.1 })).toBe(0);
    expect(unexpectedness({ error: 0.2, uncertainty: 0.01, noise: 0.01 })).toBeCloseTo(0.8427, 4); // erf(1)
    expect(unexpectedness({ error: 0.2, uncertainty: 0.3, noise: 0.3 })).toBeLessThan(0.25);
  });
});

describe('the bounded step (candidate B)', () => {
  it('moves valence the share 1 − γ toward attractor + w_δ δ and arousal toward its attractor raised by u', () => {
    const next = appraiseTouch(calm, { error: 0.5, expectation: 0, unexpected: 0.4 });
    expect(next.valence).toBeCloseTo(gamma * calm.valence + (1 - gamma) * (SHANNON_MOOD_BASELINE.valence + 0.5), 12);
    expect(next.arousal).toBeCloseTo(gamma * calm.arousal + (1 - gamma) * (SHANNON_MOOD_BASELINE.arousal + (1 - SHANNON_MOOD_BASELINE.arousal) * 0.4), 12);
    expect(next.openness).toBe(calm.openness);
    expect(touchImpact({ error: -0.5 })).toBe(0.5);
    expect(touchImpact({ error: 1.6 })).toBe(1);
  });

  it('holds what she expects (w_E = 0.35/0.80 × w_δ, Rutledge et al. 2014): a familiar welcome keeps her warm, a familiar refusal cool', () => {
    expect(SHANNON_AFFECT_DYNAMICS.expectationWeight).toBeCloseTo(0.4375, 12);
    // The review's case: joy carried over from chat (0.8), then a pat she expects to welcome and does.
    const warm = appraiseTouch({ ...calm, valence: 0.8 }, { error: 0, expectation: 1, unexpected: 0 });
    expect(warm.valence).toBeCloseTo(gamma * 0.8 + (1 - gamma) * 0.4375, 12);
    expect(warm.valence).toBeGreaterThan(0.6);
    let cool = calm;
    for (let index = 0; index < 30; index += 1) cool = appraiseTouch(cool, { error: 0, expectation: -1, unexpected: 0 });
    expect(cool.valence).toBeCloseTo(-0.4375, 6);
  });

  it('never pins: a hundred fully unexpected refusals in a row stay inside the scale and off its end', () => {
    let emotion = calm;
    for (let index = 0; index < 100; index += 1) emotion = appraiseTouch(emotion, { error: -2, expectation: -1, unexpected: 1 });
    expect(emotion.valence).toBeGreaterThanOrEqual(-1);
    expect(emotion.arousal).toBeLessThanOrEqual(1);
  });

  it('wakes her by the startle, never calms her by it', () => {
    expect(startleArousal(calm, 1).arousal).toBeGreaterThan(calm.arousal);
    expect(startleArousal({ ...calm, arousal: 0.9 }, 0).arousal).toBe(0.9);
    expect(startleArousal(calm, 1).valence).toBe(calm.valence);
  });
});

describe('a touch under stage 2', () => {
  const state = () => new InMemoryCompanionStateStore(() => NOW).snapshot('owner');
  const pat = (appraisal: ShannonTouch['appraisal']): ShannonTouch => ({ kind: 'pet', countInWindow: 3, ownerAlone: true, reflexPart: '頭', ...(appraisal ? { appraisal } : {}) });

  it('reads no table: a pat on the head no longer pleases her by itself (ADR-0005 owner answer 6)', () => {
    const before = state();
    const felt = feelTouch(before, pat({ startle: 0.9 }), NOW);
    expect(felt.emotion.valence).toBe(before.emotion.valence);
    expect(felt.emotion.arousal).toBeGreaterThan(before.emotion.arousal);
    // The only feeling a touch brings by itself is surprise, as strong as the startle.
    expect(felt.expressiveEmotion?.primary).toBe('surprised');
    expect(felt.expressiveEmotion?.cause).toContain('頭をなでられた');
    // The table (stage 1b, the old shape) would have made her happy.
    expect(feelTouch(before, { kind: 'pet', countInWindow: 3, ownerAlone: true }, NOW).expressiveEmotion?.primary).toBe('bashful');
  });

  it('brings no feeling at all when the startle is within her ordinary fluctuation', () => {
    const before = state();
    expect(feelTouch(before, pat({ startle: 0.05 }), NOW).expressiveEmotion).toBe(before.expressiveEmotion);
  });

  it('moves her by a stance carried from earlier in the episode, and keeps the feeling she chose then', () => {
    const store = new InMemoryCompanionStateStore(() => NOW);
    const before = store.snapshot('owner');
    const after = store.apply('owner', { type: 'body-touched', touch: pat({ startle: 0.05, outcome: { error: 0.4, expectation: 0, unexpected: 0.5 } }) });
    expect(after.emotion.valence).toBeGreaterThan(before.emotion.valence);
    expect(after.expressiveEmotion).toEqual(before.expressiveEmotion);
  });

  it('applies her decided stance as its own event', () => {
    const store = new InMemoryCompanionStateStore(() => NOW);
    const before = store.snapshot('owner');
    const after = store.apply('owner', { type: 'touch-appraised', outcome: { error: -0.8, expectation: 0, unexpected: 0.9 } });
    expect(after.emotion).toEqual(appraiseTouch(before.emotion, { error: -0.8, expectation: 0, unexpected: 0.9 }));
    expect(after.emotion.valence).toBeLessThan(before.emotion.valence);
  });
});
