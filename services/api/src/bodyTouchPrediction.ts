import {
  SHANNON_STANCE_OUTCOME,
  createPredictionModel,
  observeOutcome,
  predictOutcome,
  relativeUncertainty,
  unexpectedness,
  type CompanionStateSnapshot,
  type Prediction,
  type ShannonTouchOutcome,
} from '@shannon/cognition';
import type { BodyTouchGesture } from './bodyContract.js';
import type { TouchRecord } from './bodyReactionStore.js';
import type { BodyTouchStance } from './bodyTouchReflex.js';
import type { PredictionShadow } from './predictionShadow.js';
import { outcome } from './predictionShadowReadings.js';

/**
 * Stage 2 of Syzygy ADR-0006 (the body): a touch is predicted, and her stance is its outcome. Core: emotion.
 *
 * - Key: gesture.part.who. The gesture and part of touch vocabulary 2 (for a touch in the old shape, the gesture its type
 *   means and its region); who is `owner` when he is alone with her, else `unknown` (her body cannot tell who touched
 *   her, ADR-0005 decision 6). Context: the surface her body was on.
 * - Before she reacts: the startle is the relative uncertainty of that key (`relativeUncertainty`).
 * - Her stance (the reaction's `stance`, `SHANNON_STANCE_OUTCOME`) is learned as the outcome, at once, in the same record
 *   the shadow keeps (`shannon_prediction_outcomes`, domain `body_stance`, source: the touch's burst, so forgetting the
 *   touch forgets it and recomputes). A touch she is not asked about takes the stance she took for the same key within
 *   the episode she has learned (§2.5: the boundary from her own gaps); without one, only the startle moves her.
 * - Without the record (`SHANNON_PREDICTION_SHADOW=off`, or a kernel without SQLite) every touch is met with the empty
 *   prior: nothing is learned, so there is no habituation, and nothing is kept.
 *
 * `SHANNON_PREDICTION=off` switches stage 2 off: stage 1b exactly (the table, the reflex on the parts where her body
 * flinches first, the stage-1 shadow tap).
 */
export function touchPredictionEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled', 'no', 'none'].includes(environment.SHANNON_PREDICTION?.trim().toLowerCase() ?? '');
}

export const BODY_STANCE_DOMAIN = 'body_stance';

/** The record stage 2 learns in: the prediction shadow's, read and written at once. */
export type TouchPredictionRecord = Pick<PredictionShadow, 'predict' | 'recent' | 'learnNow' | 'stanceCompared'>;

/** The gesture a touch in the old shape means: holding is the hand's; elsewhere a hand resting there. */
function gestureOf(touch: Pick<TouchRecord, 'type' | 'gesture' | 'part'>): BodyTouchGesture {
  if (touch.gesture) return touch.gesture;
  switch (touch.type) {
    case 'pet': return 'stroke';
    case 'poke': return 'poke';
    case 'tickle': return 'tickle';
    case 'carry': return 'carry';
    case 'holdHand': return touch.part === undefined || touch.part === 'hand' ? 'hold' : 'rest';
  }
}

/** gesture.part.who, from closed vocabularies only. */
export function touchPredictionKey(touch: Pick<TouchRecord, 'type' | 'gesture' | 'part' | 'region' | 'audience'>): string {
  return `${gestureOf(touch)}.${touch.part ?? touch.region ?? 'unnamed'}.${touch.audience === 'owner' ? 'owner' : 'unknown'}`;
}

/** What stage 2 took of one touch when it arrived: carried on `FeltTouch` to the reaction. */
export interface TouchPrediction {
  key: string;
  context: string;
  startle: number;
  /** Set when the touch's stance is already known (carried from earlier in the episode): nothing more is learned for it. */
  outcome?: ShannonTouchOutcome;
}

export class TouchPredictions {
  constructor(private readonly record: TouchPredictionRecord | null) {}

  /** The key, and the startle before she has taken the touch. */
  expect(scopeKey: string, touch: TouchRecord, at: string): TouchPrediction {
    const key = touchPredictionKey(touch);
    const context = touch.surface ?? 'unknown';
    const query = { domain: BODY_STANCE_DOMAIN, key, at: Date.parse(at), context } as const;
    const prediction: Prediction = this.record?.predict(scopeKey, query) ?? predictOutcome(createPredictionModel(), query);
    return { key, context, startle: relativeUncertainty(prediction) };
  }

  /** The stance outcome she took for this key within the episode she has learned, or null. */
  carried(scopeKey: string, key: string, at: string): number | null {
    const recent = this.record?.recent(scopeKey, BODY_STANCE_DOMAIN, key) ?? null;
    if (!recent) return null;
    const gap = Date.parse(at) - recent.at;
    return gap >= 0 && gap <= recent.boundaryMs ? recent.outcome : null;
  }

  /** Learns the stance as the outcome of the touch's key, at once. Returns its error and how unexpected it was. */
  learn(scopeKey: string, prediction: TouchPrediction, burstId: string, stance: number, at: string, state: CompanionStateSnapshot): ShannonTouchOutcome {
    const draft = outcome(BODY_STANCE_DOMAIN, prediction.key, stance, prediction.context, {}, 'touch', burstId, at);
    const folded = this.record?.learnNow(scopeKey, draft, state) ?? null;
    if (folded && folded.error !== null && folded.unexpected !== null) return { error: folded.error, unexpected: folded.unexpected };
    // No record: the empty prior, learning nothing.
    const update = observeOutcome(createPredictionModel(), { domain: BODY_STANCE_DOMAIN, key: prediction.key, at: Date.parse(at), context: prediction.context, outcome: stance });
    return { error: update.error, unexpected: unexpectedness(update) };
  }

  compared(scopeKey: string, after: CompanionStateSnapshot, at: string): void {
    this.record?.stanceCompared(scopeKey, after, at);
  }
}

/** Her stance as the outcome on the valence scale. */
export const stanceOutcome = (stance: BodyTouchStance): number => SHANNON_STANCE_OUTCOME[stance];
