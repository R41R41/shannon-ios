import {
  SHARED_DAY_WINDOW,
  calibrateTemperament,
  isTouchFeeling,
  presentShannonFeeling,
  shannonEmotionSign,
  temperamentEvidence,
  type AffectProjection,
  type CompanionStateSnapshot,
  type ShannonEmotionTiming,
  type ShannonExpressiveEmotion,
} from '@shannon/cognition';
import { ownerDay } from '../emotion/companionPresence.js';
import type { FoldedOutcome } from './predictionShadowFold.js';
import type { PredictionOutcomeDraft, ShadowComparison } from './store/predictionStore.js';

/**
 * What the prediction shadow reads from what happened, and how it words its log line (Syzygy ADR-0006 stage 1).
 * Core: emotion. Pure: symbols and numbers in, symbols and numbers out.
 */

export function outcome(
  domain: string, key: string, value: number | null, context: string, features: Readonly<Record<string, number>>,
  sourceKind: string, sourceId: string | null, observedAt: string,
): PredictionOutcomeDraft {
  return { domain, key, outcome: value, context, features, sourceKind, sourceId, observedAt };
}

/** A reply's decided feeling as an outcome on the valence scale, or null: none, neutral, going on, or a touch's. */
export function decidedFeelingOutcome(emotion: ShannonExpressiveEmotion | undefined): number | null {
  if (!emotion || emotion.primary === 'neutral' || emotion.continued === true || isTouchFeeling(emotion)) return null;
  return shannonEmotionSign(emotion.primary) * Math.min(1, Math.max(0, emotion.intensity));
}

/** Closeness and how often they talked (days of the closeness window), the prior features of owner answer 8. */
export function ownerFeatures(state: CompanionStateSnapshot, at: string): Record<string, number> {
  const today = ownerDay(at);
  return {
    closeness: calibrateTemperament(state, today).closeness,
    talk: Math.min(1, temperamentEvidence(state, today).sharedDays / SHARED_DAY_WINDOW),
  };
}

/** The owner-local quarter of the day a message went out in (one source with the cognition ledger: `contracts/cognitionLedgerContract.ts`). */
export { dayBand } from '../../contracts/cognitionLedgerContract.js';

/** The current dynamics at an instant: mood values as stored, and what she feels now signed by its kind (a kind without a sign counts as pleasant). */
export function oldReading(state: CompanionStateSnapshot, at: string, timing: ShannonEmotionTiming): ShadowComparison['old'] {
  const present = presentShannonFeeling(state, at, timing);
  const showing = present.primary !== 'neutral' && present.visibility !== 'hidden';
  return {
    valence: state.emotion.valence, arousal: state.emotion.arousal, openness: state.emotion.openness,
    present: showing ? (shannonEmotionSign(present.primary) < 0 ? -1 : 1) * present.intensity : 0,
  };
}

export function newReading(next: AffectProjection): ShadowComparison['next'] {
  return {
    valence: next.valence, arousal: next.arousal, openness: next.openness, present: next.present, mood: next.mood,
    awakeMs: next.awakeMs, boundaryMs: next.boundaryMs,
  };
}

/** One recorded outcome, with the comparison when there is one. */
export function outcomeLine(domain: string, key: string, folded: FoldedOutcome, comparison: ShadowComparison | null): string {
  return line([
    `tap=${domain}`, `key=${key}`, `n=${folded.count}`, `e=${signed(folded.expectation)}`, `sd=${fixed(folded.uncertainty === null ? null : Math.sqrt(folded.uncertainty))}`,
    `y=${signed(folded.outcome)}`, `d=${signed(folded.error)}`, `k=${fixed(folded.learningRate)}`, `c=${folded.cause ?? '-'}${folded.newCause ? '+' : ''}`,
    ...(folded.impulse !== null ? [`i=${signed(folded.impulse)}`] : []),
    ...(comparison ? [
      `| old v=${signed(comparison.old.valence)} a=${fixed(comparison.old.arousal)} p=${signed(comparison.old.present)}`,
      `| new v=${signed(comparison.next.valence)} a=${fixed(comparison.next.arousal)} m=${signed(comparison.next.mood)} p=${signed(comparison.next.present)}`,
      `epi=${Math.round(comparison.next.boundaryMs / 60_000)}m`,
    ] : []),
  ].join(' '));
}

function signed(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function fixed(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(2);
}

/** Symbols and numbers only. */
export function line(text: string): string {
  return `Shannon prediction shadow: ${text.replace(/[^A-Za-z0-9_.:=+|\- ]/gu, '_').slice(0, 400)}`;
}
