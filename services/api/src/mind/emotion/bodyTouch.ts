import { memoryControlFor, type CompanionStateSnapshot, type CompanionStateStore, type ShannonTouchOutcome } from '@shannon/cognition';
import { BODY_LIMITS } from '../../contracts/bodyContract.js';
import { BODY_REACTION_LIMITS } from '../../contracts/bodyReactionContract.js';
import type { SQLiteBodyReactionStore, StoredTouchBurst, TouchRecord } from '../../surfaces/body/store/bodyReactionStore.js';
import { touchExperience, type TouchExperienceWriter } from '../../surfaces/body/store/bodyTouchMemory.js';
import { reflexPartWord, type BodyTouchStance } from '../../surfaces/body/bodyTouchReflex.js';
import { TouchPredictions, stanceOutcome, type TouchPrediction, type TouchPredictionRecord } from '../prediction/predictionPorts.js';

export { touchPredictionEnabled } from '../prediction/predictionPorts.js';
import { bodyTouchPartWord, bodyTouchRegionWord } from '../../surfaces/body/bodyTouchWords.js';
import type { PredictionShadow } from '../prediction/predictionPorts.js';
import type { TouchLedger } from '../../contracts/cognitionLedgerContract.js';

/**
 * A touch reaches her: the one entrance behind both ways a touch arrives, a reaction request
 * (`POST /v1/body/reactions`) and a plain event (`POST /v1/body/events`).
 *
 * Each touch id is counted once. A touch that is new moves her feeling (the reducer event
 * `body-touched`, the one touch → feeling table in `packages/cognition`) and joins the memory
 * of its burst. A touch whose id is already known (the finished touch of a reaction asked
 * while it was going on) only brings the duration and strength up to date.
 *
 * Reflex layer (Syzygy ADR-0003): it reads and writes the shared emotion state and the
 * experience store through their own entry points, and runs no part of the turn pipeline.
 */
export interface BodyTouchDependencies {
  store: SQLiteBodyReactionStore;
  stateStore: CompanionStateStore;
  /** Where a touch becomes an experience; null where there is no experience table (a kernel without SQLite). */
  experiences: TouchExperienceWriter | null;
  /** `SHANNON_BODY_REACTIONS` and `SHANNON_BODY_INGEST` both on. */
  enabled: boolean;
  now: () => string;
  reportError?: (error: unknown) => void;
  /**
   * Syzygy ADR-0006: the prediction record. Under stage 1b (`stage2` false) a read-only tap that learns from the touch
   * beside the table; under stage 2 the record her stance is learned in. Absent or null, nothing is recorded.
   */
  prediction?: (Pick<PredictionShadow, 'touch'> & Partial<TouchPredictionRecord>) | null;
  /**
   * Syzygy ADR-0006 stage 2 (`SHANNON_PREDICTION`, on unless switched off): no table for any part; the startle moves
   * arousal, her stance is the outcome and its prediction error moves her (`bodyTouchPrediction.ts`). False: stage 1b.
   */
  stage2?: boolean;
  /** Syzygy ADR-0008 stage 1: the prediction ledger's touch port (`contracts/cognitionLedgerContract.ts`, built in `wiring/cognitionLedgerTaps.ts`); absent or null, nothing is opened. */
  ledger?: TouchLedger | null;
}

export interface FeltTouch {
  /** False when this id was already counted. */
  fresh: boolean;
  burst: StoredTouchBurst;
  /** The companion state after the touch. */
  snapshot: CompanionStateSnapshot;
  /** Stage 2: what the prediction layer took of the touch when it arrived (absent under stage 1b or for a known id). */
  prediction?: TouchPrediction;
}

export interface ObserveOptions {
  /** Stage 2: she is about to be asked how she takes it, so a stance from earlier in the episode is not carried yet. */
  awaitsStance?: boolean;
}

/** One line of what happened to her body in this sitting, for the reaction prompt. */
export interface SittingTouches {
  bursts: readonly StoredTouchBurst[];
  /** What she said because of touches lately, oldest first. */
  said: readonly string[];
  /** Of those, the lines she said while other people could hear: the only ones repeated to the model in front of others. */
  saidOpen: readonly string[];
}

export class BodyTouches {
  private readonly reportError: (error: unknown) => void;
  private readonly predictions: TouchPredictions | null;

  constructor(private readonly dependencies: BodyTouchDependencies) {
    const record = dependencies.prediction;
    const usable = record?.predict && record.recent && record.learnLater && record.stanceCompared ? record as TouchPredictionRecord : null;
    this.predictions = usable ? new TouchPredictions(usable, dependencies.ledger ?? null) : null;
    // Stage 2 learns in the prediction record. Without it (`SHANNON_PREDICTION_SHADOW=off`, a kernel without SQLite) every
    // touch would meet the same empty prior, the same startle and the same surprise: touches run as stage 1b instead. The
    // warning is for a server whose record was configured away (`null`); a kernel built without one (`undefined`) is quiet.
    if (dependencies.stage2 && !usable && dependencies.enabled && dependencies.prediction === null) {
      console.warn('Shannon touch prediction (ADR-0006 stage 2) has no prediction record: touches run as stage 1b. Set SHANNON_PREDICTION=off or switch the prediction record on.');
    }
    this.reportError = dependencies.reportError ?? (error => console.error('Shannon touch memory failed', error instanceof Error ? error.message : 'unknown'));
  }

  get enabled(): boolean { return this.dependencies.enabled; }

  /** Whether stage 2 of ADR-0006 moves her: `SHANNON_PREDICTION` on and a prediction record to learn in. */
  get stage2(): boolean { return this.dependencies.stage2 === true && this.predictions !== null; }

  /** Feels and remembers one touch. Null while touches are switched off. */
  observe(scopeKey: string, touch: TouchRecord, options: ObserveOptions = {}): FeltTouch | null {
    if (!this.dependencies.enabled) return null;
    const { store, stateStore } = this.dependencies;
    const at = this.dependencies.now();
    // Read before the store's own transaction: the two are separate connections to one database.
    const before = stateStore.snapshot(scopeKey);
    const receipt = store.recordTouch(scopeKey, touch, at, burstId => this.remembered(before, burstId));
    let snapshot = before;
    const age = Date.parse(at) - Date.parse(touch.occurredAt);
    let prediction: TouchPrediction | undefined;
    if (receipt.fresh && age <= BODY_REACTION_LIMITS.feelingFreshMilliseconds && age >= -BODY_LIMITS.eventFutureSkewMilliseconds && this.stage2) {
      // Syzygy ADR-0006 stage 2: no table for any part. The startle (how unsure she was of such a touch), and the stance she
      // took for the same key earlier in this episode when there is one and she is not about to be asked.
      prediction = this.predictions!.expect(scopeKey, touch, at, receipt.burst.id);
      const carried = options.awaitsStance ? null : this.predictions!.carried(scopeKey, prediction.key, at);
      // Felt, not learned: only a stance she gives is an outcome (and the ledger's prediction of it is void).
      if (carried !== null) { prediction = { ...prediction, outcome: this.predictions!.felt(prediction, carried) }; this.predictions!.voided(scopeKey, prediction, at); }
      // The part, else the region, names the cause of a feeling (頭をなでられた): her stance is not known yet, so factual words,
      // no favour read into the verb; with neither, `factual`.
      const partWord = touch.part ? bodyTouchPartWord(touch.part) : touch.region ? bodyTouchRegionWord(touch.region) : undefined;
      snapshot = stateStore.apply(scopeKey, { type: 'body-touched', touch: {
        kind: touch.type, countInWindow: receipt.burst.count, ownerAlone: touch.audience === 'owner',
        ...(touch.durationMs !== undefined ? { durationMs: touch.durationMs } : {}),
        ...(touch.strength !== undefined ? { strength: touch.strength } : {}),
        ...(partWord ? { reflexPart: partWord, ...(touch.gesture === 'rest' ? { resting: true } : {}) } : { factual: true }),
        appraisal: { startle: prediction.startle, ...(prediction.outcome ? { outcome: prediction.outcome } : {}) },
      } });
      this.predictions!.compared(scopeKey, snapshot, at);
    } else if (receipt.fresh && age <= BODY_REACTION_LIMITS.feelingFreshMilliseconds && age >= -BODY_LIMITS.eventFutureSkewMilliseconds) {
      // Syzygy ADR-0005 stage 1b: on a part where her body flinches first only the reflex moves her, not the table.
      const reflexPart = reflexPartWord(touch.part);
      snapshot = stateStore.apply(scopeKey, { type: 'body-touched', touch: {
        kind: touch.type, countInWindow: receipt.burst.count, ownerAlone: touch.audience === 'owner',
        ...(touch.durationMs !== undefined ? { durationMs: touch.durationMs } : {}),
        ...(touch.strength !== undefined ? { strength: touch.strength } : {}),
        ...(reflexPart ? { reflexPart, ...(touch.gesture === 'rest' ? { resting: true } : {}) } : {}),
      } });
      // The shadow is handed what was felt and returns nothing (it never fails the touch). A touch moved only by the
      // reflex has no appraisal of the table to learn from: its outcome is her own stance, kept in the result table.
      if (!reflexPart) this.dependencies.prediction?.touch(scopeKey, {
        burstId: receipt.burst.id, kind: touch.type, audience: touch.audience, count: receipt.burst.count,
        ...(touch.region ? { region: touch.region } : {}), ...(touch.surface ? { surface: touch.surface } : {}),
        ...(touch.strength !== undefined ? { strength: touch.strength } : {}), ...(touch.durationMs !== undefined ? { durationMs: touch.durationMs } : {}),
      }, snapshot, at);
    }
    this.remember(scopeKey, receipt.burst);
    return { fresh: receipt.fresh, burst: receipt.burst, snapshot, ...(prediction ? { prediction } : {}) };
  }

  /**
   * Stage 2: her reaction to a touch is decided. Her stance is learned as the outcome, and its prediction error moves her
   * valence and arousal. Without a stance (a late or failed model) the stance she gave for the same key in this episode is
   * felt the same way and not learned. Returns the outcome, or null when nothing moved her (stage 1b, a stance already
   * carried at arrival, none known: only the startle moved her).
   */
  settle(scopeKey: string, felt: FeltTouch, stance: BodyTouchStance | null): { outcome: ShannonTouchOutcome; snapshot: CompanionStateSnapshot } | null {
    const prediction = felt.prediction;
    const predictions = this.predictions;
    if (!this.stage2 || !predictions || !prediction || prediction.outcome) return null;
    const at = this.dependencies.now();
    const { stateStore } = this.dependencies;
    let outcome: ShannonTouchOutcome;
    // Asked when the deferred write runs: a burst the owner had her forget while she was deciding is not learned.
    const stillRemembered = () => this.remembered(stateStore.snapshot(scopeKey), felt.burst.id);
    if (stance !== null) outcome = predictions.learn(scopeKey, prediction, felt.burst.id, stanceOutcome(stance), at, stateStore.snapshot(scopeKey), stillRemembered);
    else {
      const carried = predictions.carried(scopeKey, prediction.key, at);
      if (carried === null) return null;
      outcome = predictions.felt(prediction, carried);
      predictions.voided(scopeKey, prediction, at);
    }
    const snapshot = stateStore.apply(scopeKey, { type: 'touch-appraised', outcome });
    predictions.compared(scopeKey, snapshot, at);
    // Her stance is known now: the memory of the burst is worded by it (favour only when she took it as welcome or fine).
    // A burst the owner had her forget meanwhile keeps its memory as forgetting left it: it is not rewritten.
    const burst = this.dependencies.store.burst(scopeKey, felt.burst.id);
    if (burst && this.remembered(snapshot, burst.id)) this.remember(scopeKey, burst);
    return { outcome, snapshot };
  }

  /** What touch vocabulary 2 kept for a touch id (its part, side, gesture, reflex); null for an id never counted. */
  detail(scopeKey: string, touchId: string): ReturnType<SQLiteBodyReactionStore['touchDetail']> {
    return this.dependencies.store.touchDetail(scopeKey, touchId);
  }

  /** Stage 2: her stances on a part with the owner alone, newest first, without what the owner had her forget. */
  stances(scopeKey: string, part: string, snapshot: CompanionStateSnapshot, at: string): BodyTouchStance[] {
    return this.dependencies.store.stanceHistory(scopeKey, part, 'owner', at).filter(row => this.remembered(snapshot, row.burstId)).map(row => row.stance);
  }

  /** She said a line because of this burst: it becomes part of the memory. */
  said(scopeKey: string, burstId: string, text: string, others: boolean): void {
    const burst = this.dependencies.store.addSaid(scopeKey, burstId, text, others);
    if (burst) this.remember(scopeKey, burst);
  }

  /** What happened to her body in the last half hour, without what the owner had her forget. */
  sitting(scopeKey: string, snapshot: CompanionStateSnapshot, at: string): SittingTouches {
    const since = new Date(Date.parse(at) - BODY_REACTION_LIMITS.sittingMilliseconds).toISOString();
    const bursts = this.dependencies.store.recentBursts(scopeKey, since, at, 12).filter(burst => this.remembered(snapshot, burst.id));
    return {
      bursts: bursts.slice(0, BODY_REACTION_LIMITS.sittingKinds),
      said: [...bursts].reverse().flatMap(burst => burst.said).slice(-BODY_REACTION_LIMITS.saidLines),
      saidOpen: [...bursts].reverse().flatMap(burst => burst.saidOpen).slice(-BODY_REACTION_LIMITS.saidLines),
    };
  }

  /** A memory the owner had her forget is neither continued nor told to the reaction model. */
  private remembered(snapshot: CompanionStateSnapshot, burstId: string): boolean {
    const control = memoryControlFor(snapshot, burstId);
    return !control || control.status === 'active';
  }

  /** A failure here loses the memory of one touch, never the answer or the feeling. */
  private remember(scopeKey: string, burst: StoredTouchBurst): void {
    try {
      // Stage 2 keeps the touched part in the memory (首をつつかれた) and words a burst with favour only when every stance she
      // gave in it was welcome or fine; stage 1b words it as it did.
      const favour = this.stage2 && this.dependencies.experiences ? this.dependencies.store.burstStances(scopeKey, burst.id) : [];
      this.dependencies.experiences?.write(scopeKey, touchExperience(burst, this.stage2
        ? { parts: true, favour: favour.length > 0 && favour.every(stance => stance === 'welcome' || stance === 'fine') } : {}));
    } catch (error) { this.reportError(error); }
  }
}
