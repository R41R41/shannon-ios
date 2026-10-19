import { HIGH_ENERGY, LOW_ENERGY, MOOD_LIKE, NEGATIVE, POSITIVE } from './emotionState.js';
import type { ShannonExpressiveEmotion } from './types.js';

/** How far one shown feeling draws her numeric mood toward where its kind lies, at full intensity. */
export const FEELING_MOOD_SHARE = 0.15;
/** Where a kind lies: pleasant or unpleasant, lively or quiet (a kind that is neither leaves that axis where it is). */
export const FEELING_MOOD_TARGET = Object.freeze({ pleasant: 0.6, unpleasant: -0.6, lively: 0.75, quiet: 0.2 });

/**
 * The feeling her reply was written with, drawn into her numeric mood (owner 2026-10-19, item 15: the mood was moved only by counting
 * his words, so a cross or glad reply left it where it was and every question raised her arousal). A shown feeling of her own (a state of
 * hers, `MOOD_LIKE`) draws valence and arousal a share of the way toward where its kind lies, scaled by its intensity; a tone, a reaction,
 * her answer to him (an apology, concern) or a hidden feeling moves nothing. Read from the kind, never from numbers the model wrote.
 * Null when nothing moves.
 */
export function feelingMoodStep(mood: { valence: number; arousal: number }, feeling: ShannonExpressiveEmotion | undefined)
  : { valence: number; arousal: number } | null {
  if (!feeling || feeling.visibility === 'hidden' || !MOOD_LIKE.has(feeling.primary)) return null;
  const kind = feeling.primary, share = FEELING_MOOD_SHARE * (Number.isFinite(feeling.intensity) ? Math.max(0, Math.min(1, feeling.intensity)) : 0);
  const valence = POSITIVE.has(kind) ? FEELING_MOOD_TARGET.pleasant : NEGATIVE.has(kind) ? FEELING_MOOD_TARGET.unpleasant : mood.valence;
  const arousal = HIGH_ENERGY.has(kind) ? FEELING_MOOD_TARGET.lively : LOW_ENERGY.has(kind) ? FEELING_MOOD_TARGET.quiet : mood.arousal;
  const step = { valence: (valence - mood.valence) * share, arousal: (arousal - mood.arousal) * share };
  return Math.abs(step.valence) < 0.001 && Math.abs(step.arousal) < 0.001 ? null : step;
}

/** The mood with a shown feeling drawn into it (`feelingMoodStep`); the same object when nothing moves. */
export function moodWithFeeling<T extends { valence: number; arousal: number }>(mood: T, feeling: ShannonExpressiveEmotion | undefined): T {
  const step = feelingMoodStep(mood, feeling);
  if (!step) return mood;
  return { ...mood, valence: Math.min(1, Math.max(-1, mood.valence + step.valence)), arousal: Math.min(1, Math.max(0, mood.arousal + step.arousal)) };
}
