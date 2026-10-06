import {
  SHANNON_STANCE_OUTCOME,
  createPredictionModel,
  predictOutcome,
  relativeUncertainty,
  unexpectedness,
  type CompanionStateSnapshot,
  type Prediction,
  type ShannonTouchOutcome,
} from '@shannon/cognition';
import type { BodyTouchGesture } from './bodyContract.js';
import type { TouchLedger } from './mind/learning/predictionLedgerTaps.js';
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
 * - Her stance (the reaction's `stance`, `SHANNON_STANCE_OUTCOME`) is learned as the outcome in the same record the shadow
 *   keeps (`shannon_prediction_outcomes`, domain `body_stance`, source: the touch's burst, so forgetting the touch forgets
 *   it and recomputes). Only a stance she gave is an outcome. A touch she is not asked about is felt with the stance she
 *   gave for the same key within the episode she has learned (§2.5: the boundary from her own gaps), against what she
 *   expects now, and is not learned again: one refusal followed by ten plain pokes is one refusal, not eleven (a carried
 *   stance learned as new evidence would harden the expectation and flatten her feeling). Without one, only the startle.
 * - Stage 2 needs the record: without it (`SHANNON_PREDICTION_SHADOW=off`, or a kernel without SQLite) touches run as
 *   stage 1b and a warning says so (`bodyTouch.ts`).
 *
 * `SHANNON_PREDICTION=off` switches stage 2 off: stage 1b exactly (the table, the reflex on the parts where her body
 * flinches first, the stage-1 shadow tap).
 */
export function touchPredictionEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled', 'no', 'none'].includes(environment.SHANNON_PREDICTION?.trim().toLowerCase() ?? '');
}

export const BODY_STANCE_DOMAIN = 'body_stance';

/** The record stage 2 learns in: the prediction shadow's, read and written at once. */
export type TouchPredictionRecord = Pick<PredictionShadow, 'predict' | 'recent' | 'learnLater' | 'stanceCompared'>;

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
  /** What she expected of the key when the touch arrived (valence scale), its uncertainty and the outcome noise. */
  expectation: number;
  uncertainty: number;
  noise: number;
  /** Set when the touch's stance is already known (carried from earlier in the episode): nothing more is learned for it. */
  outcome?: ShannonTouchOutcome;
  /** Syzygy ADR-0008 stage 1: the id of the ledger's prediction of her stance (matched by her stance, void when carried). */
  ledgerId?: string;
}

export class TouchPredictions {
  constructor(private readonly record: TouchPredictionRecord, private readonly ledger: TouchLedger | null = null) {}

  /** The key, and the startle before she has taken the touch. With the ledger and the burst, the prediction of her stance is opened. */
  expect(scopeKey: string, touch: TouchRecord, at: string, burstId?: string): TouchPrediction {
    const key = touchPredictionKey(touch);
    const context = touch.surface ?? 'unknown';
    const query = { domain: BODY_STANCE_DOMAIN, key, at: Date.parse(at), context } as const;
    // A record that cannot be read now meets the empty prior for this touch (never a failed touch).
    const prediction: Prediction = this.record.predict(scopeKey, query) ?? predictOutcome(createPredictionModel(), query);
    const ledgerId = this.ledger && burstId ? this.ledger.open(scopeKey, { key, context, burstId }, at) : null;
    return { key, context, startle: relativeUncertainty(prediction), expectation: prediction.expectation, uncertainty: prediction.uncertainty, noise: prediction.noise, ...(ledgerId ? { ledgerId } : {}) };
  }

  /** Syzygy ADR-0008 stage 1: her stance was carried, not given: the ledger's prediction is void. */
  voided(scopeKey: string, prediction: TouchPrediction, at: string): void {
    if (prediction.ledgerId) this.ledger?.settle(scopeKey, prediction.ledgerId, null, at);
  }

  /** How a stance outcome is felt against what she expects, without learning anything (a carried stance). */
  felt(prediction: TouchPrediction, stance: number): ShannonTouchOutcome {
    const error = stance - prediction.expectation;
    return { error, expectation: prediction.expectation, unexpected: unexpectedness({ error, uncertainty: prediction.uncertainty, noise: prediction.noise }) };
  }

  /** The stance she gave for this key within the episode she has learned (her newest learned outcome), or null. */
  carried(scopeKey: string, key: string, at: string): number | null {
    const recent = this.record.recent(scopeKey, BODY_STANCE_DOMAIN, key);
    if (!recent) return null;
    const gap = Date.parse(at) - recent.at;
    return gap >= 0 && gap <= recent.boundaryMs ? recent.outcome : null;
  }

  /**
   * A stance she gave: felt now against what she expects at this moment (a read), and learned as the outcome of the key
   * after the caller (`learnLater`): no write in the touch's request.
   */
  learn(
    scopeKey: string, prediction: TouchPrediction, burstId: string, stance: number, at: string, state: CompanionStateSnapshot,
    remembered: () => boolean,
  ): ShannonTouchOutcome {
    const now = this.record.predict(scopeKey, { domain: BODY_STANCE_DOMAIN, key: prediction.key, at: Date.parse(at), context: prediction.context });
    const outcome = this.felt(now ? { ...prediction, expectation: now.expectation, uncertainty: now.uncertainty, noise: now.noise } : prediction, stance);
    this.record.learnLater(scopeKey, outcome_(prediction, burstId, stance, at), state, remembered);
    if (prediction.ledgerId) this.ledger?.settle(scopeKey, prediction.ledgerId, stance, at);
    return outcome;
  }

  compared(scopeKey: string, after: CompanionStateSnapshot, at: string): void {
    this.record.stanceCompared(scopeKey, after, at);
  }
}

const outcome_ = (prediction: TouchPrediction, burstId: string, stance: number, at: string) =>
  outcome(BODY_STANCE_DOMAIN, prediction.key, stance, prediction.context, {}, 'touch', burstId, at);

/** Her stance as the outcome on the valence scale. */
export const stanceOutcome = (stance: BodyTouchStance): number => SHANNON_STANCE_OUTCOME[stance];
