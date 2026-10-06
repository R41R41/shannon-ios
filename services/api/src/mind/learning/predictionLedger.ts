import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CompanionStateEvent, CompanionStateSnapshot } from '@shannon/cognition';
import {
  LEDGER_DOMAIN_RULES,
  calibration,
  cognitionLedgerSwitches,
  createLedgerMind,
  foldSettled,
  ledgerOutcome,
  ledgerPrediction,
  recomputeLedger,
  roundedDerived,
  sameDerived,
  type CalibrationReport,
  type LedgerDomain,
  type LedgerMind,
} from '@shannon/learning';
import { ownerDay } from '../emotion/companionPresence.js';
import { LockWaitMeter, loggedFailure, tableExists, underWriteLock } from '../../infra/sqlite/lockWaits.js';
import { ChoiceLedger, choiceLedgerEnabled } from './choiceLedger.js';
import { ValueVersions } from './valueTable.js';
import { PREDICTIONS_TABLE, SQLitePredictionLedger, type LedgerSourceKind, type StoredPrediction } from './store/sqlitePredictionLedger.js';

export type { LedgerSourceKind, StoredPrediction } from './store/sqlitePredictionLedger.js';

/**
 * The prediction ledger (Syzygy ADR-0008 stage 1, 答え合わせ; `docs/cognition-ledger-contract.md`). Core: emotion, memory.
 *
 * A prediction is opened with an id before its outcome, with what she expected then (from the ledger's own fold of its settled
 * rows, `@shannon/learning`), and settled later: matched, void, or expired. Nothing that acts reads it in this stage: no prompt,
 * state, reply or step changes. The parts that open and settle are handed functions (`predictionLedgerTaps.ts`), never this.
 *
 * Every write is deferred (after the caller and its transaction) and follows the shadow's lock discipline (`predictionShadow.ts`):
 * the fold is brought up to the table outside any transaction, and under `BEGIN IMMEDIATE` only what was settled meanwhile is
 * folded on before the insert; when rows were deleted meanwhile the lock is let go and the fold done again outside (the third
 * attempt may fold under the lock, so it always ends). The waits for the lock are measured. A failure is logged and swallowed.
 *
 * Once a day per scope, in the API's processes: open rows whose time ran out expire (a domain that expires to 0 settles 0),
 * rows older than 90 days go (owner override 5), forgetting is reconciled against the state's memory controls, and every
 * derived value is recomputed when settled rows went. One log line gives the calibration (symbols and numbers only).
 */
export const PREDICTION_LEDGER_RETENTION_DAYS = 90;
const DAY_MILLISECONDS = 24 * 60 * 60_000;

export function predictionLedgerEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return cognitionLedgerSwitches(environment).predictionLedger;
}

export interface LedgerOpening {
  domain: LedgerDomain;
  key: string;
  context: string;
  sourceKind: LedgerSourceKind;
  sourceId: string;
  choiceId?: string;
}

export interface PredictionLedgerOptions {
  database: DatabaseSync;
  /** Only the API's stores create the tables and maintain them; the activity loop's process writes nothing until they exist. */
  createsSchema: boolean;
  defer?: (task: () => void) => void;
  log?: (line: string) => void;
}

interface CacheEntry { mind: LedgerMind; count: number; maxSeq: number }

/** Under the write lock the fold could not be caught up by folding new rows alone: let go and fold outside. */
class FoldNeeded extends Error {}

export class PredictionLedger {
  readonly store: SQLitePredictionLedger;
  private readonly meter: LockWaitMeter;
  private readonly defer: (task: () => void) => void;
  private readonly log: (line: string) => void;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maintained = new Map<string, string>();
  private present = false;
  private locked = false;

  constructor(private readonly options: PredictionLedgerOptions) {
    this.store = new SQLitePredictionLedger(options.database, { createSchema: options.createsSchema });
    this.log = options.log ?? (line => console.log(line));
    this.meter = new LockWaitMeter('prediction ledger', this.log);
    this.defer = options.defer ?? (task => { setImmediate(task); });
  }

  /** Opens a prediction; the id is given at once and the row is written after the caller (nothing while the table is absent). */
  open(scopeKey: string, opening: LedgerOpening, at: string): string {
    const predictionId = randomUUID();
    this.later(() => this.within(scopeKey, at, () => {
      const entry = this.sync(scopeKey);
      const madeAt = Date.parse(at);
      const derived = roundedDerived(ledgerPrediction(entry.mind.model, { domain: opening.domain, key: opening.key, context: opening.context, at: madeAt }));
      this.store.insert({
        predictionId, scopeKey, domain: opening.domain, key: opening.key, context: opening.context, ...derived, basisSeq: entry.mind.seq,
        madeAt: at, expiresAt: new Date(madeAt + LEDGER_DOMAIN_RULES[opening.domain].expiresAfterMs).toISOString(),
        sourceKind: opening.sourceKind, sourceId: opening.sourceId, choiceId: opening.choiceId ?? null, status: 'open', outcome: null, outcomeSeq: null, settledAt: null,
      });
    }));
    return predictionId;
  }

  /** Settles one prediction by its id: an outcome matches it, null voids it. A row that is not open is left as it is. */
  settle(scopeKey: string, predictionId: string, outcome: number | null, at: string): void {
    this.later(() => this.within(scopeKey, at, () => {
      const row = this.store.get(scopeKey, predictionId);
      if (row?.status === 'open') this.store.settle(scopeKey, predictionId, outcome === null ? 'void' : 'matched', outcome === null ? null : ledgerOutcome(row.domain, outcome), at);
    }, { catchUp: false }));
  }

  /** Settles every open prediction about one record in one domain (matching is by source kind, source id and domain). */
  settleSource(scopeKey: string, source: { sourceKind: LedgerSourceKind; sourceId: string; domain: LedgerDomain }, outcome: number | null, at: string): void {
    this.later(() => this.within(scopeKey, at, () => {
      for (const row of this.store.openForSource(scopeKey, source.sourceKind, source.sourceId, source.domain)) {
        this.store.settle(scopeKey, row.predictionId, outcome === null ? 'void' : 'matched', outcome === null ? null : ledgerOutcome(row.domain, outcome), at);
      }
    }, { catchUp: false }));
  }

  /** Every committed write of her state, in the API's processes: the daily maintenance, and forgetting at once. */
  stateWritten(scopeKey: string, state: CompanionStateSnapshot, at: string, event?: CompanionStateEvent): void {
    if (!this.options.createsSchema) return;
    this.later(() => {
      if (event?.type === 'memory-control-upserted' || event?.type === 'memory-transaction') this.reconcile(scopeKey, state);
      if (this.maintained.get(scopeKey) !== ownerDay(at)) this.maintain(scopeKey, at, state);
    });
  }

  /**
   * Expires what ran out, prunes what is older than the retention, reconciles forgetting against `state` when given, and
   * recomputes when settled rows went. Logs the day's calibration. Runs at once (the nightly pass calls it too).
   */
  maintain(scopeKey: string, at: string, state: CompanionStateSnapshot | null = null): { expired: number; pruned: number } {
    let expired = 0;
    let pruned = 0;
    this.guard(() => {
      const before = new Date(Date.parse(at) - PREDICTION_LEDGER_RETENTION_DAYS * DAY_MILLISECONDS).toISOString();
      let settledGone = 0;
      this.within(scopeKey, at, () => {
        for (const row of this.store.due(scopeKey, at)) {
          const outcome = LEDGER_DOMAIN_RULES[row.domain].expiryOutcome;
          if (this.store.settle(scopeKey, row.predictionId, 'expired', outcome, at)) expired += 1;
        }
        const gone = this.store.pruneBefore(scopeKey, before);
        pruned = gone.deleted;
        settledGone = gone.settled;
      }, { catchUp: false });
      if (settledGone) this.refresh(scopeKey);
      if (state) this.reconcile(scopeKey, state);
      this.maintained.set(scopeKey, ownerDay(at));
      this.log(calibrationLine(ownerDay(at), this.store.counts(scopeKey), this.calibration(scopeKey)));
    });
    return { expired, pruned };
  }

  /** Deletes the rows about these records and recomputes. Returns how many rows went. */
  forget(scopeKey: string, sourceIds: readonly string[]): number {
    let deleted = 0;
    this.guard(() => {
      let settled = 0;
      this.within(scopeKey, new Date().toISOString(), () => { ({ deleted, settled } = this.store.deleteSources(scopeKey, sourceIds)); }, { catchUp: false });
      if (settled) this.refresh(scopeKey);
    });
    return deleted;
  }

  /** Recomputes every derived value of a scope from its rows. */
  recompute(scopeKey: string): { rows: number; changed: number } {
    let result = { rows: 0, changed: 0 };
    this.guard(() => { result = this.refresh(scopeKey); });
    return result;
  }

  /** The calibration of a scope's settled rows (`@shannon/learning`). */
  calibration(scopeKey: string): CalibrationReport {
    const rows = this.ready() ? this.store.all(scopeKey).filter(row => row.outcome !== null) : [];
    return calibration(rows.map(row => ({ domain: row.domain, expectation: row.expectation, outcome: row.outcome!, prior: row.prior, intervalLow: row.intervalLow, intervalHigh: row.intervalHigh })));
  }

  rows(scopeKey: string): StoredPrediction[] { return this.ready() ? this.store.all(scopeKey) : []; }

  lockWaits() { return this.meter.summary(); }

  flushLockWaits(): void { this.meter.flush(); }

  private ready(): boolean {
    if (!this.present) this.present = tableExists(this.options.database, PREDICTIONS_TABLE);
    return this.present;
  }

  /** Brings the cached fold up to the table: new settled rows are folded on; anything else is a fold from scratch, never under the lock. */
  private sync(scopeKey: string): CacheEntry {
    const shape = this.store.settledShape(scopeKey);
    const entry = this.cache.get(scopeKey);
    if (entry && entry.count === shape.count && entry.maxSeq === shape.maxSeq) return entry;
    if (entry && shape.maxSeq >= entry.maxSeq) {
      const fresh = this.store.settledAfter(scopeKey, entry.maxSeq);
      if (entry.count + fresh.length === shape.count) {
        for (const row of fresh) foldSettled(entry.mind, row);
        entry.count = shape.count;
        entry.maxSeq = shape.maxSeq;
        return entry;
      }
    }
    if (this.locked) throw new FoldNeeded();
    const settled = this.store.settledAfter(scopeKey, 0);
    const mind = createLedgerMind();
    for (const row of settled) foldSettled(mind, row);
    const rebuilt = { mind, count: settled.length, maxSeq: settled.at(-1)?.outcomeSeq ?? 0 };
    this.cache.set(scopeKey, rebuilt);
    return rebuilt;
  }

  /** Folds every row again outside the lock; under it, writes back what differs unless a settled row went meanwhile (then again). */
  private refresh(scopeKey: string): { rows: number; changed: number } {
    this.cache.delete(scopeKey);
    for (let attempt = 0; ; attempt += 1) {
      const outside = this.store.all(scopeKey);
      let done: { rows: number; changed: number } | null = null;
      this.within(scopeKey, new Date().toISOString(), () => {
        const rows = attempt < 2 ? outside : this.store.all(scopeKey);
        const settled = rows.filter(row => row.outcomeSeq !== null);
        const maxSeq = settled.reduce((highest, row) => Math.max(highest, row.outcomeSeq!), 0);
        // A settled row that went (or was added below the last place) meanwhile changes the fold: fold again.
        if (this.store.settledShape(scopeKey, maxSeq).count !== settled.length) return;
        const { derived, mind } = recomputeLedger(rows);
        let changed = 0;
        for (const row of rows) {
          const value = derived.get(row.predictionId)!;
          if (!sameDerived(row, value)) { this.store.updateDerived(scopeKey, row.predictionId, value); changed += 1; }
        }
        this.cache.set(scopeKey, { mind, count: settled.length, maxSeq: mind.seq });
        done = { rows: rows.length, changed };
      }, { catchUp: false });
      if (done) return done;
    }
  }

  /** Rows about a record the owner had her forget (any status but active) are deleted, and the rest recomputed. */
  private reconcile(scopeKey: string, state: CompanionStateSnapshot): void {
    if (!this.ready()) return;
    const controls = new Map(state.memoryControls.map(control => [control.memoryId, control]));
    const forgotten = this.store.sourceIds(scopeKey).filter(id => {
      const control = controls.get(id);
      return control !== undefined && control.status !== 'active';
    });
    if (forgotten.length) this.forget(scopeKey, forgotten);
  }

  /** One write transaction, with the fold caught up outside it first (`catchUp`); see the class comment. */
  private within(scopeKey: string, at: string, operation: () => void, options: { catchUp: boolean } = { catchUp: true }): void {
    if (!this.ready()) return;
    const day = ownerDay(Number.isFinite(Date.parse(at)) ? at : new Date().toISOString());
    for (let attempt = 0; ; attempt += 1) {
      if (options.catchUp) this.sync(scopeKey);
      this.locked = attempt < 2;
      try {
        underWriteLock(this.options.database, this.meter, day, operation, 'shannon_prediction_ledger');
        return;
      } catch (error) {
        this.cache.delete(scopeKey);
        if (!(error instanceof FoldNeeded)) throw error;
      } finally {
        this.locked = false;
      }
    }
  }

  private later(operation: () => void): void {
    this.defer(() => {
      if (!this.options.database.isOpen) return;
      this.guard(operation);
    });
  }

  private guard(operation: () => void): void {
    try {
      if (this.ready()) operation();
    } catch (error) { loggedFailure('prediction ledger', error); }
  }
}

/** The day's line: counts by status and, per domain, n, Brier, κ and the 80 % coverage. Symbols and numbers only. */
export function calibrationLine(day: string, counts: Record<string, number>, report: CalibrationReport): string {
  const number = (value: number | null) => (value === null ? '-' : value.toFixed(3));
  const domains = report.domains.map(item => `${item.domain}:n=${item.n},brier=${number(item.brier)},kappa=${number(item.skill)}${item.coverage80 === null ? '' : `,cover=${number(item.coverage80)}`}`);
  return `Shannon prediction ledger: day=${day} ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(' ')}${domains.length ? ` ${domains.join(' ')}` : ''}`;
}

/** For a process that holds no store of the API (the activity loop): its own connection, or null under the switches. */
export function configuredPredictionLedger(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string,
): { ledger: PredictionLedger; choices: ChoiceLedger | null; close(): void } | null {
  if (!predictionLedgerEnabled(environment)) return null;
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const ledger = new PredictionLedger({ database, createsSchema: false });
  // Her choices share the connection and the queue: a prediction settled before a report is seen by its settlement.
  const choices = choiceLedgerEnabled(environment) ? new ChoiceLedger({ database, createsSchema: false }) : null;
  // V at choice time is read from the value table's active version on the same connection.
  if (choices) choices.readValuesFrom(new ValueVersions({ database, createsSchema: false }).reader);
  return { ledger, choices, close: () => { ledger.flushLockWaits(); choices?.flushLockWaits(); if (database.isOpen) database.close(); } };
}
