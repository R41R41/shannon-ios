import { randomUUID } from 'node:crypto';
import { ROOT_VALUE, cognitionLedgerSwitches, skillRoutingSwitches, type ValueRead } from '@shannon/learning';
import { LockWaitMeter, loggedFailure, tableExists, underWriteLock, ownerDayKey, type SqliteConnection } from '../../infra/sqlite/lockWaits.js';
import { settleConversation, settlePending } from './rewardSettlement.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
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

export function choiceLedgerEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  return cognitionLedgerSwitches(environment).choiceLedger;
}

/** The value of a choice in a context as the active version holds it. */
export type ValueReader = (scopeKey: string, choice: string, context: string) => ValueRead;

export interface ChoiceLedgerOptions {
  database: SqliteConnection;
  createsSchema: boolean;
  /**
   * Syzygy ADR-0008 stage 2, owner answer I-3 (`SHANNON_CONVERSATION_REWARD`): her conversation choices are scored by closed
   * signals and settled by the owner's next turn. Default: the switch as the environment says.
   */
  conversation?: boolean;
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
  readonly conversation: boolean;

  constructor(private readonly options: ChoiceLedgerOptions) {
    this.store = new SQLiteChoiceLedger(options.database, { createSchema: options.createsSchema });
    this.predictions = new SQLitePredictionLedger(options.database, { createSchema: false });
    this.meter = new LockWaitMeter('choice ledger', options.log);
    this.defer = options.defer ?? (task => { setImmediate(task); });
    this.values = options.values ?? (() => ROOT_VALUE);
    this.conversation = options.conversation ?? skillRoutingSwitches(serverEnvironment()).conversationReward;
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
        expectedNoise: value.noise, expectedLevel: value.level, expectedN: value.n, status: 'pending', success: null, subjectKind: null, subjectId: null, world: null, serve: null,
        growth: null, costYen: 0, reward: null, delta: null, unexpected: null, settleCode: null, settledAt: null, moodClaimedAt: null, moodCode: null,
      }));
    });
    return choiceId;
  }

  /**
   * Stage 2 (owner answer I-3): a conversation choice (a tool call that ran, the tier of a turn) at the end of its turn, with G
   * (`conversationGrowth`) and the Talk whose next turn of the owner's settles it (`settleTalk`). Nothing while switched off.
   */
  recordConversation(scopeKey: string, draft: ChoiceDraft, growth: number, talkId: string, at: string): string | null {
    if (!this.conversation) return null;
    const choiceId = this.choose(scopeKey, draft, at);
    this.report(scopeKey, choiceId, { success: growth, costYen: 0, subject: { kind: 'talk', id: talkId } }, at);
    return choiceId;
  }

  /** The owner's next turn in a Talk, as S (`nextTurnServe`): settles the conversation choices of the turn before. */
  settleTalk(scopeKey: string, talkId: string, serve: number, at: string): void {
    if (!this.conversation) return;
    this.later(() => this.write(at, () => {
      settleConversation(this.store, scopeKey, talkId, serve, 'next_turn', at);
    }));
  }

  /** Its step ended: done or failed, what it cost, what it was about; then whatever can be settled is. */
  report(scopeKey: string, choiceId: string, report: { success: number; costYen: number; subject?: { kind: string; id: string } }, at: string): void {
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
    return settlePending(this.store, tableExists(this.options.database, PREDICTIONS_TABLE) ? this.predictions : null, scopeKey, at, { conversation: this.conversation });
  }

  private readValue(scopeKey: string, draft: ChoiceDraft): ValueRead {
    try { return this.values(scopeKey, draft.choice, draft.context); } catch { return ROOT_VALUE; }
  }

  private ready(): boolean {
    if (!this.present) this.present = tableExists(this.options.database, CHOICES_TABLE);
    return this.present;
  }

  private write(at: string, operation: () => void): void {
    underWriteLock(this.options.database, this.meter, ownerDayKey(at), operation, 'shannon_choice_ledger');
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
