import { currentShannonEmotion, resolveShannonEmotionState } from './emotionState.js';
import { SHANNON_OWNER_NAME } from './persona.js';
import {
  SHANNON_TOUCH_KINDS,
  type CompanionStateSnapshot,
  type ShannonEmotion,
  type ShannonEmotionKind,
  type ShannonExpressiveEmotion,
  type ShannonTouch,
  type ShannonTouchKind,
} from './types.js';

/**
 * What a touch does to her feeling. This is the only place a touch is read as emotion.
 *
 * A touch is an input to the one existing emotion state, not a second source: the reducer
 * event `body-touched` calls `feelTouch`, which moves the continuous mood a small bounded
 * step toward the row's mood, and resolves the conversational feeling with the same
 * resolver a reply uses (`resolveShannonEmotionState`), so carry-over, decay and the face
 * table apply to it exactly as to a feeling from conversation.
 */
export interface ShannonTouchFeelingStep {
  /** The step applies from this many touches of the kind in one sitting. */
  fromCount: number;
  primary: ShannonEmotionKind;
  intensity: number;
  /** Where the continuous mood is drawn toward, never past. */
  mood: Readonly<ShannonEmotion>;
}

export interface ShannonTouchFeeling {
  /** The touch in her own words, as the cause of the feeling and in her memory of it. */
  done: string;
  /** Ascending by `fromCount`; the last one that fits decides. */
  steps: readonly ShannonTouchFeelingStep[];
}

const step = (fromCount: number, primary: ShannonEmotionKind, intensity: number, valence: number, arousal: number, openness: number): ShannonTouchFeelingStep =>
  Object.freeze({ fromCount, primary, intensity, mood: Object.freeze({ valence, arousal, openness }) });

/** The one touch → feeling table. Being patted pleases her; repeated poking makes her sulk; being carried flusters her. */
export const SHANNON_TOUCH_FEELINGS: Readonly<Record<ShannonTouchKind, ShannonTouchFeeling>> = Object.freeze({
  pet: Object.freeze({ done: '頭をなでてもらった', steps: Object.freeze([
    step(1, 'happy', 0.50, 0.50, 0.42, 0.60), step(3, 'bashful', 0.58, 0.55, 0.45, 0.65), step(6, 'affectionate', 0.62, 0.60, 0.40, 0.70),
  ]) }),
  tickle: Object.freeze({ done: 'くすぐられた', steps: Object.freeze([
    step(1, 'giggle', 0.60, 0.35, 0.70, 0.55), step(3, 'flustered', 0.62, 0.20, 0.78, 0.50), step(5, 'cuteAngry', 0.58, 0, 0.75, 0.42),
  ]) }),
  poke: Object.freeze({ done: 'つつかれた', steps: Object.freeze([
    step(1, 'surprised', 0.45, 0.05, 0.55, 0.40), step(2, 'cuteAngry', 0.52, -0.10, 0.60, 0.36), step(4, 'sulky', 0.62, -0.25, 0.45, 0.30),
  ]) }),
  carry: Object.freeze({ done: '持ち上げて運ばれた', steps: Object.freeze([
    step(1, 'flustered', 0.60, 0.10, 0.72, 0.45), step(3, 'cuteAngry', 0.55, -0.05, 0.70, 0.40),
  ]) }),
  holdHand: Object.freeze({ done: '手をつないでもらった', steps: Object.freeze([
    step(1, 'shy', 0.52, 0.45, 0.38, 0.65), step(3, 'affectionate', 0.60, 0.55, 0.36, 0.72),
  ]) }),
});

/** The share of the distance to the row's mood one touch covers, and the most any one touch moves a mood value. */
export const SHANNON_TOUCH_MOOD_RATE = 0.18;
export const SHANNON_TOUCH_MOOD_STEP = 0.08;

const clamp = (value: number, minimum: number, maximum: number) => Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;

export function isShannonTouchKind(value: unknown): value is ShannonTouchKind {
  return typeof value === 'string' && (SHANNON_TOUCH_KINDS as readonly string[]).includes(value);
}

/** The row of the table for this touch, with how firmly and how long it was felt (0.7–1.3). */
export function touchFeeling(touch: ShannonTouch): { done: string; step: ShannonTouchFeelingStep; weight: number; intensity: number } {
  const row = SHANNON_TOUCH_FEELINGS[touch.kind];
  const count = Math.max(1, Math.trunc(clamp(touch.countInWindow, 1, 9_999)));
  const chosen = [...row.steps].reverse().find(item => count >= item.fromCount) ?? row.steps[0]!;
  const strength = clamp(touch.strength ?? 0.5, 0, 1);
  const lasting = clamp((touch.durationMs ?? 0) / 10_000, 0, 1);
  return {
    done: row.done, step: chosen,
    weight: 0.7 + strength * 0.3 + lasting * 0.3,
    intensity: clamp(chosen.intensity + (strength - 0.5) * 0.16 + lasting * 0.08, 0.3, 0.9),
  };
}

/** Why she feels it, in the stored state's words. Shown to the owner as the cause of 「いま」. */
export function touchCause(touch: ShannonTouch): string {
  const count = Math.max(1, Math.trunc(clamp(touch.countInWindow, 1, 9_999)));
  return `${touch.ownerAlone === false ? '' : `${SHANNON_OWNER_NAME}に`}${SHANNON_TOUCH_FEELINGS[touch.kind].done}${count > 1 ? `（続けて${count}回目）` : ''}`;
}

/** Whom the feeling is toward: the owner, unless someone else may have been the one touching. */
export function touchTarget(touch: Pick<ShannonTouch, 'ownerAlone'>): string {
  return touch.ownerAlone === false ? '触れた人' : SHANNON_OWNER_NAME;
}

/** Whether a stored feeling came from a touch (its cause is one of the table's own wordings). */
export function isTouchFeeling(emotion: Pick<ShannonExpressiveEmotion, 'cause'> | undefined): boolean {
  return emotion !== undefined && SHANNON_TOUCH_KINDS.some(kind => emotion.cause.includes(SHANNON_TOUCH_FEELINGS[kind].done));
}

/**
 * Whether the feeling she has now stays when she is touched. A feeling from conversation that still
 * carries is kept when an override holds it (safety, grief, emergency, accuracy) or when it is
 * presently stronger than `intensity`; a feeling that itself came from a touch always gives way.
 */
export function keepsFeelingThroughTouch(previous: ShannonExpressiveEmotion | undefined, intensity: number, now: string): boolean {
  if (!previous || isTouchFeeling(previous)) return false;
  const present = currentShannonEmotion(previous, now);
  if (present.primary === 'neutral') return false;
  return previous.overrideReason !== undefined || present.intensity > intensity;
}

/**
 * The emotion state after one touch. Pure. The mood moves by at most `SHANNON_TOUCH_MOOD_STEP`
 * per value and never past the row's mood, so any number of touches stays bounded. A feeling from
 * conversation that is held by an override or is stronger than the touch's is not replaced; only
 * the mood moves then.
 */
export function feelTouch(
  state: Pick<CompanionStateSnapshot, 'emotion' | 'expressiveEmotion'>,
  touch: ShannonTouch,
  now: string,
): { emotion: ShannonEmotion; expressiveEmotion: ShannonExpressiveEmotion } {
  const felt = touchFeeling(touch);
  const toward = (current: number, target: number) =>
    clamp((target - current) * SHANNON_TOUCH_MOOD_RATE * felt.weight, -SHANNON_TOUCH_MOOD_STEP, SHANNON_TOUCH_MOOD_STEP);
  const emotion: ShannonEmotion = {
    valence: clamp(state.emotion.valence + toward(state.emotion.valence, felt.step.mood.valence), -1, 1),
    arousal: clamp(state.emotion.arousal + toward(state.emotion.arousal, felt.step.mood.arousal), 0, 1),
    openness: clamp(state.emotion.openness + toward(state.emotion.openness, felt.step.mood.openness), 0, 1),
  };
  const previous = state.expressiveEmotion;
  if (previous && keepsFeelingThroughTouch(previous, felt.intensity, now)) return { emotion, expressiveEmotion: previous };
  const resolved = resolveShannonEmotionState({
    ...(previous ? { previous } : {}),
    provisionalPrimary: felt.step.primary, provisionalIntensity: felt.intensity,
    transcript: '', now, target: touchTarget(touch),
  });
  return { emotion, expressiveEmotion: Object.freeze({ ...resolved, cause: touchCause(touch) }) };
}
