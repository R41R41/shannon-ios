import { bodyTouchPartWord, type BodyTouchPart } from './bodyTouchWords.js';

/**
 * Where only the reflex moves her (Syzygy ADR-0005 decisions 1, 2 and 5, owner answers 1 and 7 of 2026-10-05; stage 1b of
 * the body-touch design): the parts where her body flinches first, named one by one by touch vocabulary 2.
 *
 * For a touch on one of them the touch → feeling table (`touchEmotion.ts`) is not read: the reflex moves her (surprise
 * and arousal, `SHANNON_TOUCH_REFLEX`), and how she takes the touch is her own judgement in the reaction, as `stance`.
 * Nothing here, and nothing she is told, says how such a touch should feel: neither that it pleases her nor that she
 * must refuse it. A touch without a `part` (the old shape) is never one of these.
 */
export const BODY_TOUCH_REFLEX_PARTS: readonly BodyTouchPart[] = Object.freeze(['neck', 'chest', 'waist', 'leg', 'skirt']);

export const isReflexPart = (part: BodyTouchPart | undefined): part is BodyTouchPart =>
  part !== undefined && BODY_TOUCH_REFLEX_PARTS.includes(part);

/** The word of the part for the emotion state (首), or undefined when the table applies as before. */
export const reflexPartWord = (part: BodyTouchPart | undefined): string | undefined =>
  isReflexPart(part) ? bodyTouchPartWord(part) : undefined;

/**
 * How she took a touch, in her own judgement (the reaction's `stance`): welcomed it, was fine with it, was unsure,
 * disliked it, refused it. A closed vocabulary, kept in the result table without words. No step of hers or of the
 * table maps a stance to a feeling yet; the feeling is the one she chose.
 */
export const BODY_TOUCH_STANCES = ['welcome', 'fine', 'unsure', 'dislike', 'refuse'] as const;
export type BodyTouchStance = typeof BODY_TOUCH_STANCES[number];
export const isBodyTouchStance = (value: unknown): value is BodyTouchStance => BODY_TOUCH_STANCES.some(stance => stance === value);
