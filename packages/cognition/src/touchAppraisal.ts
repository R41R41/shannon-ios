import { SHANNON_AFFECT_DYNAMICS, boundedAffectStep, stationaryBand } from './affectDynamics.js';
import type { ShannonEmotion, ShannonTouchOutcome } from './types.js';

/**
 * How a touch moves her feeling once her stance is the outcome (Syzygy ADR-0006 stage 2, candidate B of
 * `docs/testing/prediction-stage2-impact-study.md`, approved by the owner on 2026-10-06). Core: emotion. Pure.
 *
 * Under `SHANNON_PREDICTION` (on by default) no part of her body reads the touch → feeling table any more (ADR-0005
 * owner answer 6: no automatic joy when her head is patted). A touch does two things:
 * - the startle, at once and before she has taken it: arousal rises by how unsure she was of what such a touch is for
 *   her (`relativeUncertainty`, Nassar et al. 2012). A touch she knows well hardly startles her; a first one does.
 * - the appraisal, once her stance is known (her own, or the one she took in this episode): the stance is the outcome of
 *   key gesture.part.who, and its prediction error moves valence and arousal by the bounded step of `affectDynamics.ts`.
 *   What she feels is hers (the feeling she chose); how strongly is the error's size (w_δ × δ, §2.2): the first pat
 *   moves her more than the hundredth taken the same way (habituation), and an unexpected one moves her again.
 *
 * Between events the stored state still fades by the half-life table until stage 3 replaces it.
 */

/**
 * Her stance as an outcome on the valence scale: equal-interval scoring of the five ordered stances (Likert 1932). A
 * measurement assumption, to be fitted against the strength of the feeling she chose (ADR-0006 原則 3).
 */
export const SHANNON_STANCE_OUTCOME = Object.freeze({ welcome: 1, fine: 0.5, unsure: 0, dislike: -0.5, refuse: -1 });
export type ShannonTouchStance = keyof typeof SHANNON_STANCE_OUTCOME;

export type { ShannonTouchAppraisal, ShannonTouchOutcome } from './types.js';

const clamp = (value: number, minimum: number, maximum: number) => (Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum);

/** The startle: arousal the share 1 − γ toward its attractor raised by the startle, never lowered by it (a reflex wakes). */
export function startleArousal(emotion: ShannonEmotion, startle: number): ShannonEmotion {
  const stepped = boundedAffectStep(emotion, emotion.valence, clamp(startle, 0, 1));
  return { ...emotion, arousal: Math.max(emotion.arousal, stepped.arousal) };
}

/** The appraisal's step: valence the share 1 − γ toward (attractor + w_δ × error), arousal toward its attractor raised by u. */
export function appraiseTouch(emotion: ShannonEmotion, outcome: ShannonTouchOutcome): ShannonEmotion {
  const { attractor, errorWeight } = SHANNON_AFFECT_DYNAMICS;
  const stepped = boundedAffectStep(emotion, attractor.valence + errorWeight * clamp(outcome.error, -2, 2), outcome.unexpected);
  return { ...stepped, openness: emotion.openness };
}

/** How strongly she feels the touch: |w_δ × error|, never past the scale. */
export function touchImpact(outcome: Pick<ShannonTouchOutcome, 'error'>): number {
  return clamp(Math.abs(SHANNON_AFFECT_DYNAMICS.errorWeight * outcome.error), 0, 1);
}

/** Whether a startle is large enough to be told from her ordinary fluctuation (§2.1: the stationary band). */
export function isFeltStartle(startle: number): boolean {
  return clamp(startle, 0, 1) >= stationaryBand();
}
