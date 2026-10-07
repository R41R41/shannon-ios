import { randomUUID } from 'node:crypto';
import { withheldFactsSection, type StoredWithheld, type WithheldDraft, type WithheldSink } from '../../contracts/withheldActionContract.js';
import { LockWaitMeter, loggedFailure, ownerDayKey, tableExists, underWriteLock, type SqliteConnection } from '../../infra/sqlite/lockWaits.js';
import { SQLiteWithheldActions, WITHHELD_TABLE } from './store/sqliteWithheldActions.js';

/**
 * Her withheld actions (Syzygy ADR-0008 §14, `contracts/withheldActionContract.ts`). Core: approval and budget.
 *
 * The sink every part that withholds is handed (her own time's gate, her tools' gate, a session's bound), and the facts her own
 * time's next thought is shown. Writes are deferred (a refusal never waits for them, and never inside the caller's transaction),
 * under the write lock, measured; a failure is logged and swallowed. A process that does not create the table writes nothing
 * until the API has.
 */
export const WITHHELD_RETENTION_DAYS = 30;
/** What her next thought is shown: the newest of the last six hours, at most three, one per tool and reason. */
export const WITHHELD_FACTS = Object.freeze({ hours: 6, count: 3 });
const DAY = 24 * 60 * 60_000;

export class WithheldActions {
  readonly store: SQLiteWithheldActions;
  readonly sink: WithheldSink;
  private readonly meter: LockWaitMeter;
  private readonly defer: (task: () => void) => void;
  private present = false;

  constructor(private readonly options: { database: SqliteConnection; createsSchema: boolean; defer?: (task: () => void) => void; log?: (line: string) => void }) {
    this.store = new SQLiteWithheldActions(options.database, { createSchema: options.createsSchema });
    this.meter = new LockWaitMeter('withheld actions', options.log);
    this.defer = options.defer ?? (task => { setImmediate(task); });
    this.sink = (scopeKey, draft, at) => this.record(scopeKey, draft, at);
  }

  record(scopeKey: string, draft: WithheldDraft, at: string): void {
    this.defer(() => {
      if (!this.options.database.isOpen) return;
      try {
        if (!this.ready()) return;
        underWriteLock(this.options.database, this.meter, ownerDayKey(at), () => {
          this.store.insert(randomUUID(), scopeKey, draft, at);
          this.store.pruneBefore(new Date(Date.parse(at) - WITHHELD_RETENTION_DAYS * DAY).toISOString());
        }, 'shannon_withheld_actions');
      } catch (error) { loggedFailure('withheld actions', error); }
    });
  }

  /** The newest withheld actions of the last hours, one per tool and reason. */
  recent(scopeKey: string, at: string): StoredWithheld[] {
    try {
      if (!this.ready()) return [];
      const seen = new Set<string>();
      return this.store.since(scopeKey, new Date(Date.parse(at) - WITHHELD_FACTS.hours * 3_600_000).toISOString(), 50)
        .filter(item => !seen.has(`${item.tool}\u0000${item.reason}`) && seen.add(`${item.tool}\u0000${item.reason}`)).slice(0, WITHHELD_FACTS.count);
    } catch { return []; }
  }

  /** The 「止められた」 section of her next thought, or null. */
  facts(scopeKey: string, at: string, clock: (at: string) => string): string | null {
    return withheldFactsSection(this.recent(scopeKey, at), clock);
  }

  private ready(): boolean {
    if (!this.present) this.present = tableExists(this.options.database, WITHHELD_TABLE);
    return this.present;
  }
}
