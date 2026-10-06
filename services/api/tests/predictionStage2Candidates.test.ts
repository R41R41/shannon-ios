import { describe, expect, it } from 'vitest';
import { SHANNON_AFFECT_DYNAMICS } from '@shannon/cognition';
import {
  CANDIDATES,
  RUTLEDGE_GAMMA,
  dayTrajectory,
  expectedStances,
  extinction,
  firstAndHundredth,
  gammaSensitivity,
  habituation,
  longRun,
  moodLoop,
  report,
  sensitive,
} from './predictionStage2Candidates.js';

/**
 * Syzygy ADR-0006 stage 2, study only: the candidates for how a touch's prediction error moves her feeling
 * (`predictionStage2Candidates.ts`). These tests pin the findings of `docs/` note and print the report; nothing in
 * `src/` reads any of it.
 */
// Long seeded runs (20,000 outcomes for each candidate): a loaded machine may need more than the default 30 s.
describe('ADR-0006 stage 2 study: how the impact of a touch is applied', { timeout: 180_000 }, () => {
  it('reproduces the shadow (now B) exactly, and confirms the stage-1 finding with the stage-1 form: valence pinned, arousal saturated', () => {
    const day = dayTrajectory();
    for (const [index, comparison] of day.comparisons.entries()) {
      const replayed = day.shadowReplay[index]!.next;
      expect(replayed.valence).toBeCloseTo(comparison.next.valence, 5);
      expect(replayed.arousal).toBeCloseTo(comparison.next.arousal, 5);
      expect(replayed.mood).toBeCloseTo(comparison.next.mood, 5);
    }
    expect(day.summary.current.valenceMaxAbs).toBeGreaterThanOrEqual(0.99);
    expect(day.summary.current.arousalMax).toBeGreaterThanOrEqual(0.99);
    expect(longRun().current.pinnedArousal).toBeGreaterThan(0.9);
  });

  it('keeps every candidate inside the scale, and B and C off its ends in a long random run', () => {
    const run = longRun();
    for (const candidate of CANDIDATES) {
      expect(run[candidate].valenceMin).toBeGreaterThanOrEqual(-1);
      expect(run[candidate].valenceMax).toBeLessThanOrEqual(1);
      expect(run[candidate].arousalMin).toBeGreaterThanOrEqual(0);
      expect(run[candidate].arousalMax).toBeLessThanOrEqual(1);
    }
    for (const candidate of ['A', 'B', 'C'] as const) {
      expect(run[candidate].pinnedValence).toBeLessThan(0.01);
      expect(run[candidate].pinnedArousal).toBeLessThan(0.01);
    }
    // A flood of welcomes: B returns to her attractor as they become expected; C follows her appraisal to the end of the scale.
    expect(run.B.floodPinnedValence).toBe(0);
    expect(run.C.floodPinnedValence).toBeGreaterThan(0.9);
  });

  it('habituates in valence under B: the first pat moves her most, the twentieth hardly at all; C stays where her appraisal is', () => {
    const pats = habituation();
    for (let index = 1; index < 10; index += 1) expect(Math.abs(pats.B[index]!.impact)).toBeLessThan(Math.abs(pats.B[index - 1]!.impact));
    // What is left after habit is the expectation she holds (w_E × 0.5, Rutledge's EV term), not neutral: B0 (no E) fell to 0.
    expect(pats.B[19]!.valence).toBeCloseTo(SHANNON_AFFECT_DYNAMICS.expectationWeight * 0.5, 1);
    expect(Math.abs(pats.B0[19]!.valence)).toBeLessThan(0.05);
    expect(pats.C[19]!.valence).toBeGreaterThan(0.45);
    // A moves no core value itself: what moves is the mood's pull and her ordinary fluctuation (the band).
    expect(Math.max(...pats.A.map(item => Math.abs(item.valence)))).toBeLessThan(0.15);
    const fh = firstAndHundredth();
    // The hundredth pat, taken the same way, is a fifth of the first in strength and less than half in the step of valence.
    expect(fh.B.first.impact).toBeGreaterThan(4 * Math.abs(fh.B.hundredth.impact));
    expect(fh.B.first.valenceStep).toBeGreaterThan(2 * Math.abs(fh.B.hundredth.valenceStep));
  });

  it('shares extinction, spontaneous recovery, renewal and reinstatement: they live in the prediction layer', () => {
    const result = extinction();
    for (const candidate of CANDIDATES) {
      expect(result[candidate].afterExtinction).toBeLessThan(-0.2);
      expect(result[candidate].recovered30d).toBeGreaterThan(result[candidate].afterExtinction + 0.4);
      expect(result[candidate].reinstated).toBeGreaterThan(result[candidate].beforeReminder);
      expect(result[candidate].afterExtinction).toBeCloseTo(result.current.afterExtinction, 9);
    }
  });

  it('holds a familiar welcome warm and a familiar refusal cool (the E term), where B0 pulled both to neutral', () => {
    const held = expectedStances();
    expect(held.B.welcomeFrom08.first).toBeGreaterThan(0.6);
    expect(held.B0.welcomeFrom08.first).toBeLessThan(0.5);
    expect(held.B.refuseFrom0.fifth).toBeLessThan(-0.35);
    expect(held.B.refuseFrom0.fifth).toBeGreaterThan(-0.45);
  });

  it('keeps the mood loop stable at the edge of the f condition, for every candidate', () => {
    const loop = moodLoop();
    expect(loop.stableTilt[0]).toBeLessThan(1);
    expect(loop.stableTilt[1]).toBeGreaterThan(1);
    for (const candidate of CANDIDATES) expect(loop.runs[candidate].maxAbsMood).toBeLessThan(1);
  });

  it('on a sensitive part: startles less as touches there become known, avoids after a refusal, and is more surprised by someone unknown', () => {
    const result = sensitive();
    const steps = result.B.steps;
    expect(steps[0]!.startle).toBeGreaterThan(steps[2]!.startle);
    expect(steps[2]!.valence).toBeLessThan(steps[0]!.valence);
    expect(result.B.avoidAwakeMs).toBeGreaterThan(0);
    expect(result.B.strangerNextDay.startle).toBeGreaterThan(result.B.ownerNextDay.startle);
    expect(Math.abs(result.B.strangerNextDay.impact)).toBeGreaterThan(Math.abs(result.B.ownerNextDay.impact));
  });

  it('brings the day close to the current dynamics again under B, off the ends of the scale across the literature range of γ', () => {
    const day = dayTrajectory();
    expect(day.summary.B.valenceMaxAbs).toBeLessThan(0.95);
    expect(day.summary.B.meanAbsDeltaValence).toBeLessThan(0.6 * day.summary.current.meanAbsDeltaValence);
    expect(day.summary.B.arousalMax).toBeLessThan(0.95);
    const range = gammaSensitivity();
    expect(range.map(item => item.gamma)).toEqual([RUTLEDGE_GAMMA - 0.3, RUTLEDGE_GAMMA, RUTLEDGE_GAMMA + 0.3]);
    for (const item of range) {
      expect(item.dayMaxAbsValence).toBeLessThan(0.95);
      expect(item.twentiethValence).toBeLessThan(item.peakValence);
    }
    console.log(report());
  });
});
