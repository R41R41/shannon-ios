import { describe, expect, it } from 'vitest';
import {
  SHANNON_AFFECT_COEFFICIENTS,
  SHANNON_AFFECT_DYNAMICS,
  SHANNON_EMOTION_CONTINUITY,
  SHANNON_EMOTION_TIME,
  SHANNON_MOOD_BASELINE,
  advanceAffect,
  createAffectDynamics,
  deterministicNormal,
  episodeBoundaryMs,
  impulseAffect,
  isStableMoodTilt,
  learnEpisodeGap,
  moodLoopGain,
  perceivedOutcome,
  projectAffect,
  reconsolidateTrace,
  stationaryBand,
  traceStrength,
  withinEpisodeProbability,
  type AffectDynamicsState,
} from '../src/index.js';

/** The new dynamics of Syzygy ADR-0006 §2, stage 1: deterministic simulations (no Math.random anywhere). */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A run of events `gap` apart, each with the noise of its own id. */
function seeded(state: AffectDynamicsState, events: number, gap: number, prefix: string): { state: AffectDynamicsState; values: number[][] } {
  const values: number[][] = [];
  let at = state.lastAt ?? 0;
  let current = state;
  for (let index = 0; index < events; index += 1) {
    at += gap;
    current = advanceAffect(current, at, `${prefix}:${index}`);
    values.push([current.core.valence, current.core.arousal, current.core.openness]);
  }
  return { state: current, values };
}

const stats = (values: readonly number[]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
};

describe('the core affect (DynAffect)', () => {
  it('derives its noise from event ids only: the same seed gives the same number, and the numbers are standard normal', () => {
    expect(deterministicNormal('touch|pet.head.owner|b1|2026-10-05T10:00:00.000Z')).toBe(deterministicNormal('touch|pet.head.owner|b1|2026-10-05T10:00:00.000Z'));
    const sample = stats(Array.from({ length: 20_000 }, (_, index) => deterministicNormal(`seed-${index}`)));
    expect(Math.abs(sample.mean)).toBeLessThan(0.03);
    expect(Math.abs(sample.sd - 1)).toBeLessThan(0.03);
  });

  it('stays within its stationary band σ/√(2θ) over a long seeded run, on every dimension', () => {
    expect(stationaryBand()).toBeCloseTo(SHANNON_EMOTION_CONTINUITY.settledBelow, 12);
    const first = createAffectDynamics();
    const { values, state } = seeded({ ...first, lastAt: 0 }, 30_000, 5 * MINUTE, 'long');
    expect(state.sleeps).toBe(0);
    const baseline = [SHANNON_MOOD_BASELINE.valence, SHANNON_MOOD_BASELINE.arousal, SHANNON_MOOD_BASELINE.openness];
    for (const dimension of [0, 1, 2]) {
      const series = values.map(row => row[dimension]!);
      const { mean, sd } = stats(series);
      expect(Math.abs(mean - baseline[dimension]!)).toBeLessThan(0.03);
      expect(sd / stationaryBand()).toBeGreaterThan(0.9);
      expect(sd / stationaryBand()).toBeLessThan(1.1);
      // About 99.7% inside three bands, and nothing runs away.
      expect(series.filter(value => Math.abs(value - baseline[dimension]!) > 3 * stationaryBand()).length / series.length).toBeLessThan(0.01);
      expect(Math.max(...series.map(value => Math.abs(value - baseline[dimension]!)))).toBeLessThan(5 * stationaryBand());
    }
    // The same run again is the same run.
    expect(seeded({ ...first, lastAt: 0 }, 200, 5 * MINUTE, 'long').values).toEqual(values.slice(0, 200));
  });

  it('returns to its attractor with the half-life θ gives (about 1.5 awake hours)', () => {
    const start = advanceAffect(createAffectDynamics(), 0, 'first');
    const { state } = impulseAffect(start, { key: 'touch:k', error: 0.8, learningRate: 0.5 });
    const halfLife = Math.log(2) / SHANNON_AFFECT_DYNAMICS.theta;
    expect(halfLife / HOUR).toBeCloseTo(1.513, 2);
    // Within one episode the mean path halves in one half-life (the boundary must not cut it: project inside the episode).
    const near = projectAffect(state, 10 * MINUTE);
    // The attractor itself has moved by w_δ × mood.
    const attractor = SHANNON_MOOD_BASELINE.valence + SHANNON_AFFECT_DYNAMICS.errorWeight * state.mood;
    expect((near.valence - attractor) / (state.core.valence - attractor)).toBeCloseTo(Math.exp(-SHANNON_AFFECT_DYNAMICS.theta * 10 * MINUTE), 9);
  });
});

describe('momentary impulses and mood', () => {
  it('turns prediction errors into impulses: an unexpected strong appraisal is an impulse of 0.90, an expected one none', () => {
    const start = advanceAffect(createAffectDynamics(), 0, 'first');
    expect(impulseAffect(start, { key: 'reply_feeling:owner', error: 0.9, learningRate: 0.5 }).impulse).toBeCloseTo(0.9, 12);
    expect(impulseAffect(start, { key: 'reply_feeling:owner', error: 0, learningRate: 0.5 }).impulse).toBe(0);
    // w_E applies only where a prediction preceded a choice of hers.
    expect(impulseAffect(start, { key: 'reply:k', error: 0, expectation: 0.4, learningRate: 0.5 }).impulse).toBe(0);
    expect(impulseAffect(start, { key: 'reply:k', error: 0, expectation: 0.4, chosen: true, learningRate: 0.5 }).impulse).toBeCloseTo(0.4, 12);
    // Surprise raises arousal either way, by the bounded step (stage 2, candidate B): the share 1 − γ toward its attractor raised by u.
    const gamma = SHANNON_AFFECT_DYNAMICS.eventForgetting;
    const surprised = impulseAffect(start, { key: 'k', error: -0.5, learningRate: 0.5, unexpected: 0.8 }).state.core;
    const a0 = SHANNON_MOOD_BASELINE.arousal;
    expect(surprised.arousal).toBeCloseTo(gamma * start.core.arousal + (1 - gamma) * (a0 + (1 - a0) * 0.8), 12);
    expect(surprised.valence).toBeCloseTo(gamma * start.core.valence + (1 - gamma) * (SHANNON_MOOD_BASELINE.valence - 0.5), 12);
  });

  it('never pins valence or arousal at the ends of the scale: each step is a weighted average of points on it (stage 2)', () => {
    let state = advanceAffect(createAffectDynamics(), 0, 'first');
    const values: number[][] = [];
    for (let index = 1; index <= 2_000; index += 1) {
      state = advanceAffect(state, index * 10_000, `flood:${index}`);
      // The worst case: an error of +2 that is fully unexpected, every ten seconds.
      state = impulseAffect(state, { key: `k${index % 3}`, error: 2, learningRate: 0.5, unexpected: 1 }).state;
      values.push([state.core.valence, state.core.arousal]);
    }
    for (const [valence, arousal] of values) {
      expect(valence).toBeLessThanOrEqual(1);
      expect(arousal).toBeLessThanOrEqual(1);
    }
    // With nothing unexpected, arousal returns toward its attractor instead of staying up.
    const calm = impulseAffect(state, { key: 'k', error: 0, learningRate: 0.5, unexpected: 0 }).state.core.arousal;
    expect(calm).toBeLessThan(state.core.arousal);
  });

  it('keeps the mood loop stable: with f = 1 one round shrinks every deviation, and a long run of good outcomes converges', () => {
    expect(isStableMoodTilt(1)).toBe(true);
    for (const outcome of [-1, 0, 1]) expect(moodLoopGain(1, SHANNON_AFFECT_DYNAMICS.moodRate, outcome, 0.5)).toBeCloseTo(1 - SHANNON_AFFECT_DYNAMICS.moodRate, 12);
    expect(isStableMoodTilt(3)).toBe(false);
    expect(perceivedOutcome(0.7, 0.9)).toBe(0.7);
    let state = advanceAffect(createAffectDynamics(), 0, 'first');
    const moods: number[] = [];
    for (let index = 1; index <= 500; index += 1) {
      state = advanceAffect(state, index * MINUTE, `good:${index}`);
      state = impulseAffect(state, { key: 'touch:k', error: perceivedOutcome(0.6, state.mood) - 0.1, learningRate: 0.3 }).state;
      moods.push(state.mood);
    }
    expect(Math.max(...moods)).toBeLessThanOrEqual(0.5 + 1e-12);
    expect(Math.abs(moods.at(-1)! - moods.at(-50)!)).toBeLessThan(0.02);
    expect(Math.abs(state.core.valence)).toBeLessThanOrEqual(1);
  });

  it('moves the valence attractor by w_δ × mood', () => {
    const state = { ...advanceAffect(createAffectDynamics(), 0, 'first'), mood: 0.2 };
    expect(projectAffect(state, 11 * MINUTE).valence).toBeGreaterThan(0);
  });
});

describe('emotional memory', () => {
  const start = () => advanceAffect(createAffectDynamics(), 0, 'first');

  it('fades by a power law: a strong feeling stays above the band about as long as the current lingering table, a moderate one about as long as the mood', () => {
    const strong = impulseAffect(start(), { key: 'reply_feeling:owner', error: -0.9, learningRate: 0.5 }).state.traces[0]!;
    const moderate = impulseAffect(start(), { key: 'reply_feeling:owner', error: 0.6, learningRate: 0.5 }).state.traces[0]!;
    expect(strong.consolidated).toBe(true);
    expect(moderate.consolidated).toBe(false);
    const strongSettles = SHANNON_EMOTION_TIME.lingeringHalfLifeMs * Math.log2(0.9 / stationaryBand());
    const moderateSettles = SHANNON_EMOTION_TIME.moodHalfLifeMs * Math.log2(0.6 / stationaryBand());
    expect(traceStrength(strong, strongSettles)).toBeCloseTo(stationaryBand(), 9);
    expect(traceStrength(moderate, moderateSettles)).toBeCloseTo(stationaryBand(), 9);
    // A power law: slower than the exponential with the same first half-life, later on.
    const early = traceStrength(strong, HOUR) / 0.9;
    expect(traceStrength(strong, 20 * HOUR) / 0.9).toBeGreaterThan(early ** 20);
  });

  it('keeps as many feelings underneath as are above the band: there is no count limit', () => {
    let state = start();
    for (let index = 0; index < 8; index += 1) state = impulseAffect(state, { key: `touch:k${index}`, error: 0.8, learningRate: 0.5 }).state;
    expect(state.traces).toHaveLength(8);
  });

  it('rewrites a recalled memory only by the error, at the learning rate (reconsolidation needs a prediction error)', () => {
    const trace = impulseAffect(start(), { key: 'touch:k', error: -0.8, learningRate: 0.5 }).state.traces[0]!;
    const now = -traceStrength(trace, HOUR);
    expect(reconsolidateTrace(trace, now, 0.7, HOUR).value).toBeCloseTo(now, 12);
    const eased = reconsolidateTrace(trace, 0.2, 0.5, HOUR);
    expect(eased.value).toBeCloseTo(now + 0.5 * (0.2 - now), 12);
    expect(eased.encodedAwakeMs).toBe(HOUR);
  });

  it('habituates the feeling too: a repeated outcome recalls its trace and the trace fades with the shrinking error', () => {
    let state = start();
    const impulses: number[] = [];
    let error = 0.8;
    for (let index = 1; index <= 6; index += 1) {
      state = advanceAffect(state, index * 30_000, `pet:${index}`);
      const felt = impulseAffect(state, { key: 'touch:pet', error, learningRate: 0.5 });
      state = felt.state;
      impulses.push(felt.impulse);
      error /= 2;
    }
    for (let index = 1; index < impulses.length; index += 1) expect(impulses[index]!).toBeLessThan(impulses[index - 1]!);
    expect(Math.abs(state.traces[0]?.value ?? 0)).toBeLessThan(0.8);
  });
});

describe('episodes and sleep', () => {
  it('starts with its boundary at the current idle cap and learns it from her own gaps', () => {
    const fresh = createAffectDynamics();
    expect(episodeBoundaryMs(fresh.boundary)).toBeCloseTo(SHANNON_EMOTION_TIME.idleCapMs, 3);
    let boundary = fresh.boundary;
    for (let index = 0; index < 300; index += 1) boundary = learnEpisodeGap(boundary, index % 5 === 0 ? 9 * HOUR : 40_000);
    const learned = episodeBoundaryMs(boundary);
    expect(learned).toBeGreaterThan(40_000);
    expect(learned).toBeLessThan(9 * HOUR);
    expect(withinEpisodeProbability(boundary, 40_000)).toBeGreaterThan(0.9);
    expect(withinEpisodeProbability(boundary, 9 * HOUR)).toBeLessThan(0.1);
  });

  it('runs the awake clock through a gap only up to the boundary, and counts a longer gap as a sleep', () => {
    const start = advanceAffect(createAffectDynamics(), 0, 'first');
    const short = advanceAffect(start, 5 * MINUTE, 'short');
    expect(short.awakeMs).toBe(5 * MINUTE);
    expect(short.sleeps).toBe(0);
    const long = advanceAffect(short, 5 * MINUTE + 8 * HOUR, 'long');
    expect(long.awakeMs - short.awakeMs).toBeCloseTo(episodeBoundaryMs(short.boundary), 3);
    expect(long.sleeps).toBe(1);
  });

  it('softens memories in sleep: a strong feeling reaches the band after about four days asleep', () => {
    const felt = impulseAffect(advanceAffect(createAffectDynamics(), 0, 'first'), { key: 'reply_feeling:owner', error: -0.9, learningRate: 0.5 }).state;
    const after = (days: number) => advanceAffect(felt, days * DAY, `sleep:${days}`);
    expect(after(3).traces).toHaveLength(1);
    expect(after(5).traces).toHaveLength(0);
    expect(Math.abs(after(2).traces[0]!.value)).toBeLessThan(0.9 * Math.exp(-SHANNON_AFFECT_DYNAMICS.sleepSoftening * (2 * DAY - SHANNON_EMOTION_TIME.idleCapMs)) + 1e-9);
  });
});

describe('the coefficient table (ADR-0006 §2.6)', () => {
  it('names a source, a literature range and an initial value for every coefficient, and marks what is unchecked', () => {
    for (const row of SHANNON_AFFECT_COEFFICIENTS) {
      expect(row.source.length, row.symbol).toBeGreaterThan(0);
      expect(row.literature.length, row.symbol).toBeGreaterThan(0);
      expect(row.initial.length, row.symbol).toBeGreaterThan(0);
    }
    expect(SHANNON_AFFECT_COEFFICIENTS.filter(row => row.verify === '要確認').map(row => row.symbol)).toEqual(['θ', 'w_E, w_δ', 'γ', 'α, kernel']);
    expect(SHANNON_AFFECT_COEFFICIENTS.find(row => row.symbol === 'openness')!.kind).toBe('assumption');
    expect(SHANNON_AFFECT_DYNAMICS.moodTilt).toBe(1);
    expect(Math.exp(-SHANNON_AFFECT_DYNAMICS.theta * 2 * HOUR)).toBeCloseTo(0.4, 12);
  });
});
