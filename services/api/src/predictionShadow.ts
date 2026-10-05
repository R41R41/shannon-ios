import { DatabaseSync } from 'node:sqlite';
import {
  SHARED_DAY_WINDOW,
  calibrateTemperament,
  isTouchFeeling,
  memoryControlFor,
  presentShannonFeeling,
  restoreCompanionState,
  shannonEmotionSign,
  temperamentEvidence,
  touchFeeling,
  type AffectProjection,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
  type ShannonEmotionTiming,
  type ShannonExpressiveEmotion,
  type ShannonTouchKind,
} from '@shannon/cognition';
import { OBSERVATION_RETENTION_DAYS, type AutonomyPredictionTap, type ReachOutFacts } from './autonomyLoopObservations.js';
import { BODY_LIMITS } from './bodyContract.js';
import { ownerDay } from './companionPresence.js';
import { emotionTiming } from './emotionTiming.js';
import { MOOD_HISTORY_LIMITS } from './moodHistoryContract.js';
import { createShadowMind, foldOutcome, foldOutcomes, readMind, type FoldedOutcome, type ShadowMind } from './predictionShadowFold.js';
import { SQLitePredictionStore, checkedDraft, type PredictionOutcomeDraft, type ShadowComparison } from './predictionStore.js';

/**
 * Stage 1 of Syzygy ADR-0006 (影, shadow): read-only taps that hand what already happens to the prediction layer and
 * the new dynamics, beside the existing code, and record how the two trajectories differ. Core: emotion.
 *
 * Nothing here changes an output. No tap returns anything to its caller; no state, prompt, reply, face, body answer,
 * step of her own or model request reads the shadow. The servers run the work after the caller (`defer`), so nothing
 * waits for it. Every failure is logged by name and swallowed; run at once, a transaction SQLite rolled back under a
 * caller is thrown on (as the mood history does), so the caller fails exactly as it would have at its next statement.
 *
 * The taps:
 * - a touch (`bodyTouch.ts`): its appraisal by the current table (the valence of the row it chose) is the outcome
 *   of key kind.part.who; the source is the touch's burst, the memory the owner may forget;
 * - a message of hers and what followed (`autonomyLoopObserve.ts`, in the activity loop's process): whether he
 *   answered and after how long; an away or hidden report goes to "is he there" instead (ADR-0006 §1); closeness and
 *   how often they talked seed the prior (owner answer 8);
 * - a reply's feeling (every write of `expressive-emotion-updated` that is not a touch's): the decided kind's sign ×
 *   its strength;
 * - the mood: each committed write of her state is compared (coalesced as the mood history is) and, when her clock
 *   moved, is an instant she was awake for the new clock.
 *
 * The log line and the store hold symbols and numbers only. `SHANNON_PREDICTION_SHADOW=off` switches it all off.
 */
export function predictionShadowEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled', 'no', 'none'].includes(environment.SHANNON_PREDICTION_SHADOW?.trim().toLowerCase() ?? '');
}

const DAY_MILLISECONDS = 24 * 60 * 60_000;
/** At most one awake instant per minute is kept: the awake clock writes at most once a minute too. Technical bound. */
const AWAKE_ROW_MILLISECONDS = 60_000;
/** Retention follows the source record (owner answer 7). `null`: kept until forgotten, as the conversation is. */
export const PREDICTION_RETENTION_DAYS: Readonly<Record<string, number | null>> = Object.freeze({
  touch: BODY_LIMITS.retentionDays,
  reach_out: OBSERVATION_RETENTION_DAYS,
  state: MOOD_HISTORY_LIMITS.keepDays,
  reply_feeling: null,
});

export interface ShadowTouch {
  burstId: string;
  kind: ShannonTouchKind;
  region?: string;
  surface?: string;
  audience: 'owner' | 'others';
  count: number;
  strength?: number;
  durationMs?: number;
}

export interface PredictionShadowOptions {
  database: DatabaseSync;
  /** Only the API's stores create the tables and prune; the activity loop's process writes nothing until they exist. */
  createsSchema: boolean;
  log?: (line: string) => void;
  timing?: () => ShannonEmotionTiming;
  /**
   * When a tap's work runs. The API and the loop pass `setImmediate`: after the caller's transaction and after the
   * response, so no reply, touch answer or step waits for the shadow (the loop also calls inside a transaction on another
   * connection). Default: at once (inside a caller's transaction, in a savepoint).
   */
  defer?: (task: () => void) => void;
}

interface CacheEntry { mind: ShadowMind; count: number; maxSeq: number }

class CallerTransactionLost extends Error {
  constructor(readonly original: unknown) { super('PREDICTION_SHADOW_CALLER_TRANSACTION_LOST'); }
}

export class PredictionShadow implements AutonomyPredictionTap {
  private readonly store: SQLitePredictionStore;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maintained = new Map<string, string>();
  private readonly log: (line: string) => void;
  private readonly timing: () => ShannonEmotionTiming;
  private present = false;

  constructor(private readonly options: PredictionShadowOptions) {
    this.store = new SQLitePredictionStore(options.database, { createSchema: options.createsSchema });
    this.log = options.log ?? (line => console.log(line));
    this.timing = options.timing ?? (() => emotionTiming());
  }

  /** A touch moved her feeling (`after` is the state as written). */
  touch(scopeKey: string, touch: ShadowTouch, after: CompanionStateSnapshot, at: string): void {
    this.later(() => this.within(() => {
      this.maintain(scopeKey, at);
      const appraisal = touchFeeling({
        kind: touch.kind, countInWindow: touch.count, ownerAlone: touch.audience === 'owner',
        ...(touch.strength !== undefined ? { strength: touch.strength } : {}), ...(touch.durationMs !== undefined ? { durationMs: touch.durationMs } : {}),
      }).step.mood.valence;
      const key = `${touch.kind}.${touch.region ?? 'unnamed'}.${touch.audience}`;
      const folded = this.record(scopeKey, outcome('touch', key, appraisal, touch.surface ?? 'unknown', {}, 'touch', touch.burstId, at));
      this.report('touch', key, folded, this.compare(scopeKey, 'touch', after, at));
    }));
  }

  /** A message of hers and what followed. Deferred: the loop calls inside its own transaction on another connection. */
  reachOut(scopeKey: string, facts: ReachOutFacts, at: string): void {
    this.later(() => this.within(() => {
      if (facts.unwatched) return;
      const state = this.storedState(scopeKey, at);
      const features = state ? ownerFeatures(state, at) : {};
      const band = dayBand(facts.sentAt);
      const route = facts.call ? 'call' : facts.surface ?? (facts.delivery === 'unknown' ? 'unreported' : 'body');
      const context = facts.others ? 'others' : 'alone';
      const rows: PredictionOutcomeDraft[] = [];
      if (facts.delivery === 'away' || facts.delivery === 'hidden' || facts.delivery === 'shown' || facts.delivery === 'shown_spoken') {
        rows.push(outcome('owner_present', band, facts.delivery === 'shown' || facts.delivery === 'shown_spoken' ? 1 : 0, context, {}, 'reach_out', facts.id, at));
      }
      // A message he could not have seen is not a failure of the message (ADR-0006 §1 「原因の取り違えを避ける」).
      if (facts.delivery !== 'away' && facts.delivery !== 'hidden') {
        const key = `${facts.reason}.${band}.${route}`;
        rows.push(outcome('reply', key, facts.replied ? 1 : 0, context, features, 'reach_out', facts.id, at));
        if (facts.replied) rows.push(outcome('reply_time', key, facts.repliedAfterSeconds ?? facts.waitedSeconds, context, features, 'reach_out', facts.id, at));
      }
      const comparison = state ? this.compare(scopeKey, 'reach_out', state, at) : null;
      for (const row of rows) this.report(row.domain, row.key, this.record(scopeKey, row), comparison);
    }));
  }

  /**
   * Every committed write of her state (`SQLiteCompanionRepository`'s `committed`). Forgetting is reconciled here:
   * rows whose source the owner had her forget are deleted and everything is recomputed.
   */
  stateWritten(scopeKey: string, state: CompanionStateSnapshot, at: string, event?: CompanionStateEvent): void {
    this.later(() => this.within(() => {
      this.maintain(scopeKey, at);
      if (event?.type === 'memory-control-upserted' || event?.type === 'memory-transaction') this.reconcile(scopeKey, state);
      // The touch tap records a touch with its own comparison.
      if (event?.type === 'body-touched') return;
      const feeling = event?.type === 'expressive-emotion-updated' ? decidedFeelingOutcome(event.emotion) : null;
      if (feeling !== null) {
        const folded = this.record(scopeKey, outcome('reply_feeling', 'owner', feeling, '', {}, 'reply_feeling', null, at));
        this.report('reply_feeling', 'owner', folded, this.compare(scopeKey, 'reply_feeling', state, at));
        return;
      }
      // An instant she was awake by the current clock is one for the new clock too.
      const entry = this.sync(scopeKey);
      const last = entry.mind.dynamics.lastAt;
      if (state.emotionClock?.at === at && (last === null || Date.parse(at) - last >= AWAKE_ROW_MILLISECONDS)) {
        this.record(scopeKey, outcome('awake', 'state', null, '', {}, 'state', null, at));
      }
      this.moodComparison(scopeKey, state, at);
    }));
  }

  /** Deletes the rows of these sources and recomputes. Returns how many rows went. */
  forget(scopeKey: string, sourceIds: readonly string[]): number {
    let deleted = 0;
    this.guard(() => this.within(() => { deleted = this.forgetInside(scopeKey, sourceIds); }));
    return deleted;
  }

  /** Recomputes every derived value of a scope from its rows, in order. */
  recompute(scopeKey: string): { rows: number; changed: number } {
    let result = { rows: 0, changed: 0 };
    this.guard(() => this.within(() => { result = this.recomputeInside(scopeKey, null); }));
    return result;
  }

  /** The mind as the rows make it now (for status and tests); a copy is not made, so do not change it. */
  mind(scopeKey: string): ShadowMind {
    if (!this.ready()) return createShadowMind();
    return this.sync(scopeKey).mind;
  }

  comparisons(scopeKey: string, since = ''): ShadowComparison[] {
    return this.ready() ? this.store.comparisons(scopeKey, since) : [];
  }

  private ready(): boolean {
    if (!this.present) this.present = this.store.ready();
    return this.present;
  }

  private sync(scopeKey: string): CacheEntry {
    const shape = this.store.shape(scopeKey);
    const entry = this.cache.get(scopeKey);
    if (entry && entry.count === shape.count && entry.maxSeq === shape.maxSeq) return entry;
    if (entry && shape.maxSeq >= entry.maxSeq) {
      const fresh = this.store.rows(scopeKey, entry.maxSeq);
      if (entry.count + fresh.length === shape.count) {
        for (const row of fresh) foldOutcome(entry.mind, row);
        entry.count = shape.count;
        entry.maxSeq = shape.maxSeq;
        return entry;
      }
    }
    const rows = this.store.rows(scopeKey);
    const rebuilt = { mind: foldOutcomes(rows).mind, count: rows.length, maxSeq: shape.maxSeq };
    this.cache.set(scopeKey, rebuilt);
    return rebuilt;
  }

  private record(scopeKey: string, draft: PredictionOutcomeDraft): FoldedOutcome {
    const row = checkedDraft(draft);
    const entry = this.sync(scopeKey);
    const folded = foldOutcome(entry.mind, row);
    entry.maxSeq = this.store.insert(scopeKey, row, folded);
    entry.count += 1;
    return folded;
  }

  private compare(scopeKey: string, tap: string, state: CompanionStateSnapshot, at: string): ShadowComparison {
    const next = readMind(this.sync(scopeKey).mind, at);
    const comparison: ShadowComparison = { at: new Date(Date.parse(at)).toISOString(), tap, old: oldReading(state, at, this.timing()), next: newReading(next) };
    this.store.addComparison(scopeKey, comparison);
    return comparison;
  }

  /** Coalesced as the mood history: a changed face is not known here, so a value moved by `moodStep` or `everyMinutes` passed. */
  private moodComparison(scopeKey: string, state: CompanionStateSnapshot, at: string): void {
    const previous = this.store.latestComparison(scopeKey, 'mood');
    const old = oldReading(state, at, this.timing());
    if (previous && Date.parse(at) - Date.parse(previous.at) < MOOD_HISTORY_LIMITS.everyMinutes * 60_000
      && (['valence', 'arousal', 'openness', 'present'] as const).every(name => Math.abs(old[name] - previous.old[name]) < MOOD_HISTORY_LIMITS.moodStep)) return;
    this.compare(scopeKey, 'mood', state, at);
  }

  private reconcile(scopeKey: string, state: CompanionStateSnapshot): void {
    const forgotten = this.store.sourceIds(scopeKey).filter(id => {
      const control = memoryControlFor(state, id);
      return control !== undefined && control.status !== 'active';
    });
    if (forgotten.length) this.forgetInside(scopeKey, forgotten);
  }

  private forgetInside(scopeKey: string, sourceIds: readonly string[]): number {
    const { deleted, earliest } = this.store.deleteSources(scopeKey, sourceIds);
    if (!deleted) return 0;
    const result = this.recomputeInside(scopeKey, earliest);
    this.log(line(`forgot sources=${sourceIds.length} rows=${deleted} recomputed=${result.rows} changed=${result.changed}`));
    return deleted;
  }

  /** Folds every row again; rewrites the derived values that differ; drops comparisons made with rows that are gone. */
  private recomputeInside(scopeKey: string, from: string | null): { rows: number; changed: number } {
    const rows = this.store.rows(scopeKey);
    const { mind, folded } = foldOutcomes(rows);
    let changed = 0;
    rows.forEach((row, index) => {
      const derived = folded[index]!;
      const same = (left: number | null, right: number | null) => (left === null ? right === null : right !== null && Math.abs(left - right) < 5e-7);
      if (!same(row.expectation, derived.expectation) || !same(row.uncertainty, derived.uncertainty) || !same(row.error, derived.error)
        || !same(row.learningRate, derived.learningRate) || !same(row.cause, derived.cause)) {
        this.store.updateDerived(row.seq, derived);
        changed += 1;
      }
    });
    if (from) this.store.deleteComparisonsFrom(scopeKey, from);
    this.cache.set(scopeKey, { mind, count: rows.length, maxSeq: this.store.shape(scopeKey).maxSeq });
    return { rows: rows.length, changed };
  }

  /** Once per owner day and scope, in the API's processes: rows older than their source's retention go, and the rest is recomputed. */
  private maintain(scopeKey: string, at: string): void {
    if (!this.options.createsSchema) return;
    const day = ownerDay(at);
    if (this.maintained.get(scopeKey) === day) return;
    this.maintained.set(scopeKey, day);
    const time = Date.parse(at);
    let deleted = 0;
    let earliest: string | null = null;
    for (const [kind, days] of Object.entries(PREDICTION_RETENTION_DAYS)) {
      if (days === null) continue;
      const pruned = this.store.prune(scopeKey, kind, new Date(time - days * DAY_MILLISECONDS).toISOString());
      deleted += pruned.deleted;
      if (pruned.earliest && (!earliest || pruned.earliest < earliest)) earliest = pruned.earliest;
    }
    this.store.pruneComparisons(new Date(time - MOOD_HISTORY_LIMITS.keepDays * DAY_MILLISECONDS).toISOString());
    if (deleted) this.recomputeInside(scopeKey, null);
  }

  /** The stored state of a scope, read only, for the activity loop's process (which holds no state store). */
  private storedState(scopeKey: string, at: string): CompanionStateSnapshot | null {
    try {
      const database = this.options.database;
      if (!database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'companion_states'`).get()) return null;
      const row = database.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scopeKey) as unknown as { snapshot_json: string } | undefined;
      return row ? restoreCompanionState(scopeKey, JSON.parse(row.snapshot_json), at) : null;
    } catch { return null; }
  }

  private report(domain: string, key: string, folded: FoldedOutcome, comparison: ShadowComparison | null): void {
    const parts = [
      `tap=${domain}`, `key=${key}`, `n=${folded.count}`, `e=${signed(folded.expectation)}`, `sd=${fixed(folded.uncertainty === null ? null : Math.sqrt(folded.uncertainty))}`,
      `y=${signed(folded.outcome)}`, `d=${signed(folded.error)}`, `k=${fixed(folded.learningRate)}`, `c=${folded.cause ?? '-'}${folded.newCause ? '+' : ''}`,
      ...(folded.impulse !== null ? [`i=${signed(folded.impulse)}`] : []),
      ...(comparison ? [
        `| old v=${signed(comparison.old.valence)} a=${fixed(comparison.old.arousal)} p=${signed(comparison.old.present)}`,
        `| new v=${signed(comparison.next.valence)} a=${fixed(comparison.next.arousal)} m=${signed(comparison.next.mood)} p=${signed(comparison.next.present)}`,
        `epi=${Math.round(comparison.next.boundaryMs / 60_000)}m`,
      ] : []),
    ];
    this.log(line(parts.join(' ')));
  }

  private within(operation: () => void): void {
    if (!this.ready()) return;
    const database = this.options.database;
    const nested = database.isTransaction;
    database.exec(nested ? 'SAVEPOINT shannon_prediction' : 'BEGIN IMMEDIATE');
    try {
      operation();
      database.exec(nested ? 'RELEASE shannon_prediction' : 'COMMIT');
    } catch (error) {
      this.cache.clear();
      if (nested && !database.isTransaction) throw new CallerTransactionLost(error);
      if (database.isTransaction) database.exec(nested ? 'ROLLBACK TO shannon_prediction; RELEASE shannon_prediction' : 'ROLLBACK');
      throw error;
    }
  }

  /** Runs a tap's work when `defer` says; a store closed meanwhile (a shutdown) is skipped quietly. */
  private later(operation: () => void): void {
    const defer = this.options.defer;
    if (!defer) { this.guard(operation); return; }
    defer(() => {
      if (!this.options.database.isOpen) return;
      // Deferred, nothing is thrown on: there is no caller left to fail.
      try { this.guard(operation); } catch (error) { failed(error); }
    });
  }

  /** Logs by name and code only (a message could quote a stored value) and goes on. */
  private guard(operation: () => void): void {
    try { operation(); } catch (error) {
      if (error instanceof CallerTransactionLost) throw error.original;
      failed(error);
    }
  }
}

function failed(error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.error('Shannon prediction shadow failed', error instanceof Error ? error.name : 'unknown', typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : '');
}

/** For a process that holds no store of the API (the activity loop): its own connection, or null under the switch. */
export function configuredPredictionShadow(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string, options: { log?: (line: string) => void } = {},
): { shadow: PredictionShadow; close(): void } | null {
  if (!predictionShadowEnabled(environment)) return null;
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const shadow = new PredictionShadow({ database, createsSchema: false, ...(options.log ? { log: options.log } : {}), defer: task => { setImmediate(task); } });
  return { shadow, close: () => { if (database.isOpen) database.close(); } };
}

function outcome(
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

/** The owner-local quarter of the day a message went out in. */
export function dayBand(at: string): 'night' | 'morning' | 'afternoon' | 'evening' {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(new Date(Date.parse(at) || 0)));
  return hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** The current dynamics at an instant: mood values as stored, and what she feels now signed by its kind (a kind without a sign counts as pleasant). */
function oldReading(state: CompanionStateSnapshot, at: string, timing: ShannonEmotionTiming): ShadowComparison['old'] {
  const present = presentShannonFeeling(state, at, timing);
  const showing = present.primary !== 'neutral' && present.visibility !== 'hidden';
  return {
    valence: state.emotion.valence, arousal: state.emotion.arousal, openness: state.emotion.openness,
    present: showing ? (shannonEmotionSign(present.primary) < 0 ? -1 : 1) * present.intensity : 0,
  };
}

function newReading(next: AffectProjection): ShadowComparison['next'] {
  return {
    valence: next.valence, arousal: next.arousal, openness: next.openness, present: next.present, mood: next.mood,
    awakeMs: next.awakeMs, boundaryMs: next.boundaryMs,
  };
}

function signed(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function fixed(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(2);
}

/** Symbols and numbers only. */
function line(text: string): string {
  return `Shannon prediction shadow: ${text.replace(/[^A-Za-z0-9_.:=+|\- ]/gu, '_').slice(0, 400)}`;
}
