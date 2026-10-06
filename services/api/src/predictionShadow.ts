import { DatabaseSync } from 'node:sqlite';
import {
  SHANNON_AFFECT_STEP,
  episodeBoundaryMs,
  predictOutcome,
  restoreCompanionState,
  touchFeeling,
  type Prediction,
  type PredictionQuery,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
  type ShannonEmotionTiming,
  type ShannonTouchKind,
} from '@shannon/cognition';
import { OBSERVATION_RETENTION_DAYS, type AutonomyPredictionTap, type ReachOutFacts } from './autonomyLoopObservations.js';
import { BODY_LIMITS } from './bodyContract.js';
import { ownerDay } from './companionPresence.js';
import { emotionTiming } from './emotionTiming.js';
import { MOOD_HISTORY_LIMITS } from './moodHistoryContract.js';
import { createShadowMind, foldOutcome, foldOutcomes, readMind, type FoldedOutcome, type ShadowMind } from './predictionShadowFold.js';
import { dayBand, decidedFeelingOutcome, line, newReading, oldReading, outcome, outcomeLine, ownerFeatures } from './predictionShadowReadings.js';
import { SQLitePredictionStore, checkedDraft, type PredictionOutcomeDraft, type ShadowComparison } from './predictionStore.js';

export { dayBand, decidedFeelingOutcome, ownerFeatures } from './predictionShadowReadings.js';

/**
 * Stage 1 of Syzygy ADR-0006 (影, shadow): read-only taps that hand what already happens to the prediction layer and
 * the new dynamics, beside the existing code, and record how the two trajectories differ. Core: emotion.
 *
 * Nothing here changes an output. No tap returns anything to its caller; no state, prompt, reply, face, body answer,
 * step of her own or model request reads the shadow. The servers run the work after the caller (`defer`), so nothing
 * waits for it. Every failure is logged by name and swallowed; run at once, a transaction SQLite rolled back under a
 * caller is thrown on (as the mood history does), so the caller fails exactly as it would have at its next statement.
 *
 * The write lock is never held through a fold: the mind is brought up to date first, outside any transaction; under
 * `BEGIN IMMEDIATE` only the rows that arrived in between are folded before the insert. If rows were deleted in
 * between (another process forgot something), the lock is let go and the fold done again outside. A recompute after
 * deleting rows is three steps the same way: delete, fold outside, then write back the derived values under the lock.
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
 *   moved, is an instant she was awake for the new clock; so is each advance of the awake clock in the activity loop's
 *   process (`autonomyAwakeClock.ts`), which writes the state without the repository.
 *
 * The log line and the store hold symbols and numbers only. `SHANNON_PREDICTION_SHADOW=off` switches it all off.
 */
export function predictionShadowEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled', 'no', 'none'].includes(environment.SHANNON_PREDICTION_SHADOW?.trim().toLowerCase() ?? '');
}

const DAY_MILLISECONDS = 24 * 60 * 60_000;
/** At most one awake instant per minute is kept: the awake clock writes at most once a minute too. Technical bound. */
const AWAKE_ROW_MILLISECONDS = 60_000;
/**
 * Retention follows the source record (owner answer 7). A reply's feeling carries no turn id yet (the state write does
 * not know it), so until stage 3 links it to its turn it is kept as long as the mood history.
 */
export const PREDICTION_RETENTION_DAYS: Readonly<Record<string, number>> = Object.freeze({
  touch: BODY_LIMITS.retentionDays,
  reach_out: OBSERVATION_RETENTION_DAYS,
  state: MOOD_HISTORY_LIMITS.keepDays,
  reply_feeling: MOOD_HISTORY_LIMITS.keepDays,
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
  /** Only the API's stores create the tables, prune and reconcile; the activity loop's process writes nothing until they exist. */
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

/** Under the write lock the mind could not be caught up by folding new rows alone: let go and fold outside. */
class FoldNeeded extends Error {}

export class PredictionShadow implements AutonomyPredictionTap {
  private readonly store: SQLitePredictionStore;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maintained = new Map<string, string>();
  private readonly log: (line: string) => void;
  private readonly timing: () => ShannonEmotionTiming;
  private present = false;
  /** True while this shadow holds the write lock and may not fold from scratch. */
  private locked = false;

  constructor(private readonly options: PredictionShadowOptions) {
    this.store = new SQLitePredictionStore(options.database, { createSchema: options.createsSchema });
    this.log = options.log ?? (text => console.log(text));
    this.timing = options.timing ?? (() => emotionTiming());
  }

  /** A touch moved her feeling (`after` is the state as written). */
  touch(scopeKey: string, touch: ShadowTouch, after: CompanionStateSnapshot, at: string): void {
    this.later(() => {
      this.maintain(scopeKey, at, after);
      this.within(scopeKey, () => {
        const appraisal = touchFeeling({
          kind: touch.kind, countInWindow: touch.count, ownerAlone: touch.audience === 'owner',
          ...(touch.strength !== undefined ? { strength: touch.strength } : {}), ...(touch.durationMs !== undefined ? { durationMs: touch.durationMs } : {}),
        }).step.mood.valence;
        const key = `${touch.kind}.${touch.region ?? 'unnamed'}.${touch.audience}`;
        const folded = this.record(scopeKey, outcome('touch', key, appraisal, touch.surface ?? 'unknown', {}, 'touch', touch.burstId, at));
        this.log(outcomeLine('touch', key, folded, this.compare(scopeKey, 'touch', after, at)));
      });
    });
  }

  /**
   * A message of hers and what followed. Deferred: the loop calls inside its own transaction on another connection, so
   * a step whose transaction is rolled back afterwards may still leave its rows.
   */
  reachOut(scopeKey: string, facts: ReachOutFacts, at: string): void {
    if (facts.unwatched) return;
    this.later(() => {
      const state = this.storedState(scopeKey, at);
      this.within(scopeKey, () => {
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
          // Censored at the wait: an answer after it is no answer here, so a time is only ever one inside the wait.
          if (facts.replied) rows.push(outcome('reply_time', key, facts.repliedAfterSeconds ?? facts.waitedSeconds, context, features, 'reach_out', facts.id, at));
        }
        const comparison = state ? this.compare(scopeKey, 'reach_out', state, at) : null;
        for (const row of rows) this.log(outcomeLine(row.domain, row.key, this.record(scopeKey, row), comparison));
      });
    });
  }

  /** The awake clock advanced in the activity loop's process (`autonomyAwakeClock.ts`): an instant she was awake. */
  awake(scopeKey: string, at: string): void {
    this.later(() => this.within(scopeKey, () => this.awakeInstant(scopeKey, at)));
  }

  /**
   * Every committed write of her state (`SQLiteCompanionRepository`'s `committed`). Forgetting is reconciled here:
   * rows whose source the owner had her forget are deleted and everything is recomputed (and once a day in `maintain`).
   */
  stateWritten(scopeKey: string, state: CompanionStateSnapshot, at: string, event?: CompanionStateEvent): void {
    this.later(() => {
      this.maintain(scopeKey, at, state);
      if (event?.type === 'memory-control-upserted' || event?.type === 'memory-transaction') this.reconcile(scopeKey, state);
      // A touch records its own comparison (the stage-1b tap, or stage 2's after the touch and after her stance): one per event.
      if (event?.type === 'body-touched' || event?.type === 'touch-appraised') return;
      this.within(scopeKey, () => {
        const feeling = event?.type === 'expressive-emotion-updated' ? decidedFeelingOutcome(event.emotion) : null;
        if (feeling !== null) {
          const folded = this.record(scopeKey, outcome('reply_feeling', 'owner', feeling, '', {}, 'reply_feeling', null, at));
          this.log(outcomeLine('reply_feeling', 'owner', folded, this.compare(scopeKey, 'reply_feeling', state, at)));
          return;
        }
        // An instant she was awake by the current clock is one for the new clock too.
        if (state.emotionClock?.at === at) this.awakeInstant(scopeKey, at);
        this.moodComparison(scopeKey, state, at);
      });
    });
  }

  /**
   * Stage 2 (`SHANNON_PREDICTION`): what she expects of a key now. The one read a touch needs before she reacts, so it is
   * done at once, and it is a read only: the cached mind is brought up to the table by folding the rows that arrived since
   * (a cold fold happens once per process, and every state write already warms it after the caller). It takes no lock and
   * writes nothing. Null when the record is not there or cannot be read; it never fails the touch.
   */
  predict(scopeKey: string, query: PredictionQuery): Prediction | null {
    let prediction: Prediction | null = null;
    this.guard(() => { prediction = predictOutcome(this.sync(scopeKey).mind.model, query); });
    return prediction;
  }

  /** Stage 2: the newest outcome of a key (one indexed read), with the episode boundary she has learned; null when there is none. */
  recent(scopeKey: string, domain: string, key: string): { outcome: number; at: number; boundaryMs: number } | null {
    let recent: { outcome: number; at: number; boundaryMs: number } | null = null;
    this.guard(() => {
      const latest = this.store.latest(scopeKey, domain, key);
      if (latest) recent = { outcome: latest.outcome, at: Date.parse(latest.observedAt), boundaryMs: episodeBoundaryMs(this.sync(scopeKey).mind.dynamics.boundary) };
    });
    return recent;
  }

  /**
   * Stage 2: learns a stance she gave, after the caller (`defer`), as every other tap does: the daily maintenance, the write
   * lock and the insert never run in the touch's request. Her feeling has already moved by the error read before it.
   */
  learnLater(scopeKey: string, draft: PredictionOutcomeDraft, state: CompanionStateSnapshot): void {
    this.later(() => {
      this.maintain(scopeKey, draft.observedAt, state);
      this.within(scopeKey, () => { this.log(outcomeLine(draft.domain, draft.key, this.record(scopeKey, draft), null)); });
    });
  }

  /** Stage 2: the comparison after a touch moved her (`after` is the state as written), after the caller. */
  stanceCompared(scopeKey: string, after: CompanionStateSnapshot, at: string): void {
    this.later(() => this.within(scopeKey, () => { this.compare(scopeKey, 'touch', after, at); }));
  }

  /** Deletes the rows of these sources and recomputes. Returns how many rows went. */
  forget(scopeKey: string, sourceIds: readonly string[]): number {
    let deleted = 0;
    this.guard(() => { deleted = this.forgetSources(scopeKey, sourceIds); });
    return deleted;
  }

  /** Recomputes every derived value of a scope from its rows, in order. */
  recompute(scopeKey: string): { rows: number; changed: number } {
    let result = { rows: 0, changed: 0 };
    this.guard(() => { if (this.ready()) result = this.refresh(scopeKey); });
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

  /** Brings the cached mind up to the table: new rows are folded on; anything else is a fold from scratch, never under the lock. */
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
    if (this.locked) throw new FoldNeeded();
    const rows = this.store.rows(scopeKey);
    const rebuilt = { mind: foldOutcomes(rows).mind, count: rows.length, maxSeq: rows.at(-1)?.seq ?? 0 };
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

  private awakeInstant(scopeKey: string, at: string): void {
    const last = this.sync(scopeKey).mind.dynamics.lastAt;
    if (last === null || Date.parse(at) - last >= AWAKE_ROW_MILLISECONDS) this.record(scopeKey, outcome('awake', 'state', null, '', {}, 'state', null, at));
  }

  private compare(scopeKey: string, tap: string, state: CompanionStateSnapshot, at: string): ShadowComparison {
    const next = readMind(this.sync(scopeKey).mind, at);
    const comparison: ShadowComparison = { at: new Date(Date.parse(at)).toISOString(), tap, old: oldReading(state, at, this.timing()), next: newReading(next), dynamics: SHANNON_AFFECT_STEP };
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

  /** Rows whose source the owner had her forget (any status but active) are deleted, and the rest recomputed. */
  private reconcile(scopeKey: string, state: CompanionStateSnapshot): void {
    if (!this.ready()) return;
    const controls = new Map(state.memoryControls.map(control => [control.memoryId, control]));
    const forgotten = this.store.sourceIds(scopeKey).filter(id => {
      const control = controls.get(id);
      return control !== undefined && control.status !== 'active';
    });
    if (forgotten.length) this.forgetSources(scopeKey, forgotten);
  }

  private forgetSources(scopeKey: string, sourceIds: readonly string[]): number {
    if (!this.ready()) return 0;
    let deleted = 0;
    this.within(scopeKey, () => {
      const result = this.store.deleteSources(scopeKey, sourceIds);
      deleted = result.deleted;
      if (result.earliest) this.store.deleteComparisonsFrom(scopeKey, result.earliest);
    }, { catchUp: false });
    if (!deleted) return 0;
    const result = this.refresh(scopeKey);
    this.log(line(`forgot sources=${sourceIds.length} rows=${deleted} recomputed=${result.rows} changed=${result.changed}`));
    return deleted;
  }

  /**
   * Folds every row again outside the lock, then under it folds on what arrived meanwhile and rewrites the derived values
   * that differ. If rows were deleted meanwhile, it folds again; the third time it reads and folds the table under the
   * lock, so that a fold made outside it is never used once the table has changed under it.
   */
  private refresh(scopeKey: string): { rows: number; changed: number } {
    for (let attempt = 0; ; attempt += 1) {
      const rows = this.store.rows(scopeKey);
      const { mind, folded } = foldOutcomes(rows);
      const done: { result: { rows: number; changed: number } | null } = { result: null };
      this.within(scopeKey, () => {
        const shape = this.store.shape(scopeKey);
        let current = { rows, mind, folded, later: this.store.rows(scopeKey, rows.at(-1)?.seq ?? 0) };
        if (rows.length + current.later.length !== shape.count) {
          if (attempt < 2) return;
          const table = this.store.rows(scopeKey);
          current = { rows: table, ...foldOutcomes(table), later: [] };
        }
        const last = current.rows.at(-1)?.seq ?? 0;
        const later = current.later;
        for (const row of later) foldOutcome(current.mind, row);
        let changed = 0;
        current.rows.forEach((row, index) => {
          const derived = current.folded[index]!;
          const same = (left: number | null, right: number | null) => (left === null ? right === null : right !== null && Math.abs(left - right) < 5e-7);
          if (!same(row.expectation, derived.expectation) || !same(row.uncertainty, derived.uncertainty) || !same(row.error, derived.error)
            || !same(row.learningRate, derived.learningRate) || !same(row.cause, derived.cause)) {
            this.store.updateDerived(row.seq, derived);
            changed += 1;
          }
        });
        this.cache.set(scopeKey, { mind: current.mind, count: shape.count, maxSeq: Math.max(last, later.at(-1)?.seq ?? 0) });
        done.result = { rows: current.rows.length + later.length, changed };
      }, { catchUp: false });
      if (done.result) return done.result;
    }
  }

  /**
   * Once per owner day and scope, in the API's processes: rows older than their source's retention go (then a
   * recompute), and forgetting is reconciled against the state, also for what a lost deferred task or a time with the
   * switch off left behind.
   */
  private maintain(scopeKey: string, at: string, state: CompanionStateSnapshot): void {
    if (!this.options.createsSchema || !this.ready()) return;
    const day = ownerDay(at);
    if (this.maintained.get(scopeKey) === day) return;
    const time = Date.parse(at);
    let deleted = 0;
    this.within(scopeKey, () => {
      for (const [kind, days] of Object.entries(PREDICTION_RETENTION_DAYS)) deleted += this.store.prune(scopeKey, kind, new Date(time - days * DAY_MILLISECONDS).toISOString()).deleted;
      this.store.pruneComparisons(new Date(time - MOOD_HISTORY_LIMITS.keepDays * DAY_MILLISECONDS).toISOString());
    }, { catchUp: false });
    if (deleted) this.refresh(scopeKey);
    this.reconcile(scopeKey, state);
    // Only once all of it went through: a failure is tried again at the next write.
    this.maintained.set(scopeKey, day);
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

  /**
   * One write transaction. First, outside it, the mind is brought up to date (`catchUp`); under the lock only rows that
   * arrived meanwhile are folded on. When that is not enough the lock is let go and the whole is tried again (the third
   * time it may fold under the lock, so that it always ends).
   */
  private within(scopeKey: string, operation: () => void, options: { catchUp: boolean } = { catchUp: true }): void {
    if (!this.ready()) return;
    const database = this.options.database;
    for (let attempt = 0; ; attempt += 1) {
      if (options.catchUp) this.sync(scopeKey);
      const nested = database.isTransaction;
      database.exec(nested ? 'SAVEPOINT shannon_prediction' : 'BEGIN IMMEDIATE');
      this.locked = attempt < 2;
      try {
        operation();
        database.exec(nested ? 'RELEASE shannon_prediction' : 'COMMIT');
        return;
      } catch (error) {
        this.cache.delete(scopeKey);
        if (nested && !database.isTransaction) throw new CallerTransactionLost(error);
        if (database.isTransaction) database.exec(nested ? 'ROLLBACK TO shannon_prediction; RELEASE shannon_prediction' : 'ROLLBACK');
        if (!(error instanceof FoldNeeded)) throw error;
      } finally {
        this.locked = false;
      }
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
    try {
      if (this.ready()) operation();
    } catch (error) {
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
