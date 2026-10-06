import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ROOT_VALUE, cognitionLedgerSwitches, type ValueRead } from '@shannon/learning';
import { ownerDay } from '../emotion/companionPresence.js';
import { LockWaitMeter, loggedFailure, tableExists, underWriteLock } from '../../infra/sqlite/lockWaits.js';
import { settlePending } from './rewardSettlement.js';
import { CHOICES_TABLE, SQLiteChoiceLedger, type ChoiceDraft, type StoredChoice } from './store/sqliteChoiceLedger.js';
import { PREDICTIONS_TABLE, SQLitePredictionLedger } from './store/sqlitePredictionLedger.js';

export type { ChoiceDraft, StoredChoice } from './store/sqliteChoiceLedger.js';

/**
 * The choice ledger (Syzygy ADR-0008 stage 1, 報酬系; `docs/cognition-ledger-contract.md`). Core: guard, emotion.
 *
 * A choice of hers is recorded when the gate allowed it, with the value she held then (`values`, the active version of the
 * value table; the root cell until there is one), reported when its step ended, and settled once its reward can be scored
 * (`rewardSettlement.ts`). Nothing that acts reads it in this stage: no prompt, state or step changes (the effects are step 7).
 *
 * Writes are deferred, take the write lock only for the write and are measured; failures are logged and swallowed. The
 * nightly pass (`mind/sleep/valueSleep.ts`) settles what waited, voids lost reports, and prunes after 90 days (owner override 5).
 */
export const CHOICE_RETENTION_DAYS = 90;
const DAY = 24 * 60 * 60_000;

export function choiceLedgerEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return cognitionLedgerSwitches(environment).choiceLedger;
}

/** The value of a choice in a context as the active version holds it. */
export type ValueReader = (scopeKey: string, choice: string, context: string) => ValueRead;

export interface ChoiceLedgerOptions {
  database: DatabaseSync;
  createsSchema: boolean;
  /** The same queue as the prediction ledger on this connection, so a prediction settled before a report is seen by it. */
  defer?: (task: () => void) => void;
  values?: ValueReader;
  log?: (line: string) => void;
}

export class ChoiceLedger {
  readonly store: SQLiteChoiceLedger;
  private readonly predictions: SQLitePredictionLedger;
  private readonly meter: LockWaitMeter;
  private readonly defer: (task: () => void) => void;
  private values: ValueReader;
  private present = false;

  constructor(private readonly options: ChoiceLedgerOptions) {
    this.store = new SQLiteChoiceLedger(options.database, { createSchema: options.createsSchema });
    this.predictions = new SQLitePredictionLedger(options.database, { createSchema: false });
    this.meter = new LockWaitMeter('choice ledger', options.log);
    this.defer = options.defer ?? (task => { setImmediate(task); });
    this.values = options.values ?? (() => ROOT_VALUE);
  }

  /** Where the value at choice time is read (the value table of step 5). */
  readValuesFrom(values: ValueReader): void { this.values = values; }

  /** Records a choice the gate allowed; the id is given at once and the row written after the caller. */
  choose(scopeKey: string, draft: ChoiceDraft, at: string): string {
    const choiceId = randomUUID();
    this.later(() => {
      const value = this.readValue(scopeKey, draft);
      this.write(at, () => this.store.insert({
        ...draft, choiceId, scopeKey, chosenAt: at, valueVersion: value.version, expected: value.mean, expectedSd: Math.sqrt(Math.max(0, value.variance)),
        expectedNoise: value.noise, expectedLevel: value.level, status: 'pending', success: null, subjectKind: null, subjectId: null, world: null, serve: null,
        growth: null, costYen: 0, reward: null, delta: null, unexpected: null, settleCode: null, settledAt: null, moodClaimedAt: null, moodCode: null,
      }));
    });
    return choiceId;
  }

  /** Its step ended: done or failed, what it cost, what it was about; then whatever can be settled is. */
  report(scopeKey: string, choiceId: string, report: { success: 0 | 1; costYen: number; subject?: { kind: string; id: string } }, at: string): void {
    this.later(() => this.write(at, () => {
      this.store.report(scopeKey, choiceId, report);
      this.settleNow(scopeKey, at);
    }));
  }

  /** Its step could not be scored (another runner closed it, the report was lost): void. */
  void(scopeKey: string, choiceId: string, at: string): void {
    this.later(() => this.write(at, () => { this.store.settle(scopeKey, choiceId, null, 'void', at); }));
  }

  /** A choice made and ended at once (a tool call in a conversation): recorded, reported and settled. */
  recordSettled(scopeKey: string, draft: ChoiceDraft, success: 0 | 1, at: string): string {
    const choiceId = this.choose(scopeKey, draft, at);
    this.report(scopeKey, choiceId, { success, costYen: 0 }, at);
    return choiceId;
  }

  /** Settles what can be settled now, after the caller (a story's reaction arrived, a prediction expired). */
  settleLater(scopeKey: string, at: string): void {
    this.later(() => this.write(at, () => { this.settleNow(scopeKey, at); }));
  }

  /** The nightly part: settles what waited, voids lost reports and stale credit, prunes after the retention. Runs at once. */
  sleep(scopeKey: string, at: string): { settled: number; pruned: number } {
    let result = { settled: 0, pruned: 0 };
    this.guard(() => this.write(at, () => {
      const settled = this.settleNow(scopeKey, at);
      const pruned = this.store.pruneBefore(scopeKey, new Date(Date.parse(at) - CHOICE_RETENTION_DAYS * DAY).toISOString());
      result = { settled, pruned };
    }));
    return result;
  }

  rows(scopeKey: string): StoredChoice[] { return this.ready() ? this.store.all(scopeKey) : []; }

  lockWaits() { return this.meter.summary(); }

  flushLockWaits(): void { this.meter.flush(); }

  private settleNow(scopeKey: string, at: string): number {
    return settlePending(this.store, tableExists(this.options.database, PREDICTIONS_TABLE) ? this.predictions : null, scopeKey, at);
  }

  private readValue(scopeKey: string, draft: ChoiceDraft): ValueRead {
    try { return this.values(scopeKey, draft.choice, draft.context); } catch { return ROOT_VALUE; }
  }

  private ready(): boolean {
    if (!this.present) this.present = tableExists(this.options.database, CHOICES_TABLE);
    return this.present;
  }

  private write(at: string, operation: () => void): void {
    underWriteLock(this.options.database, this.meter, ownerDay(at), operation, 'shannon_choice_ledger');
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
    } catch (error) { loggedFailure('choice ledger', error); }
  }
}
