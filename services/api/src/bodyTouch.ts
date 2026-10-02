import { memoryControlFor, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { BODY_LIMITS } from './bodyContract.js';
import { BODY_REACTION_LIMITS } from './bodyReactionContract.js';
import type { SQLiteBodyReactionStore, StoredTouchBurst, TouchRecord } from './bodyReactionStore.js';
import { touchExperience, type TouchExperienceWriter } from './bodyTouchMemory.js';

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
}

export interface FeltTouch {
  /** False when this id was already counted. */
  fresh: boolean;
  burst: StoredTouchBurst;
  /** The companion state after the touch. */
  snapshot: CompanionStateSnapshot;
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

  constructor(private readonly dependencies: BodyTouchDependencies) {
    this.reportError = dependencies.reportError ?? (error => console.error('Shannon touch memory failed', error instanceof Error ? error.message : 'unknown'));
  }

  get enabled(): boolean { return this.dependencies.enabled; }

  /** Feels and remembers one touch. Null while touches are switched off. */
  observe(scopeKey: string, touch: TouchRecord): FeltTouch | null {
    if (!this.dependencies.enabled) return null;
    const { store, stateStore } = this.dependencies;
    const at = this.dependencies.now();
    // Read before the store's own transaction: the two are separate connections to one database.
    const before = stateStore.snapshot(scopeKey);
    const receipt = store.recordTouch(scopeKey, touch, at, burstId => this.remembered(before, burstId));
    let snapshot = before;
    const age = Date.parse(at) - Date.parse(touch.occurredAt);
    if (receipt.fresh && age <= BODY_REACTION_LIMITS.feelingFreshMilliseconds && age >= -BODY_LIMITS.eventFutureSkewMilliseconds) {
      snapshot = stateStore.apply(scopeKey, { type: 'body-touched', touch: {
        kind: touch.type, countInWindow: receipt.burst.count, ownerAlone: touch.audience === 'owner',
        ...(touch.durationMs !== undefined ? { durationMs: touch.durationMs } : {}),
        ...(touch.strength !== undefined ? { strength: touch.strength } : {}),
      } });
    }
    this.remember(scopeKey, receipt.burst);
    return { fresh: receipt.fresh, burst: receipt.burst, snapshot };
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
      this.dependencies.experiences?.write(scopeKey, touchExperience(burst));
    } catch (error) { this.reportError(error); }
  }
}
