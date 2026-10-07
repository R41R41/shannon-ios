import type { DatabaseSync } from 'node:sqlite';

/** The connection a cognition writer is handed (only store/ folders, infra/sqlite and wiring name SQLite itself). */
export type SqliteConnection = DatabaseSync;

const ownerDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The owner-local day (Asia/Tokyo) of an instant: the key of a once-a-day pass and of a day's line of lock waits. */
export function ownerDayKey(at: string): string {
  const time = Date.parse(at);
  return ownerDayFormat.format(new Date(Number.isFinite(time) ? time : Date.now()));
}

/**
 * The write lock of the shared SQLite file, taken the way the ADR-0006 record takes it (`predictionShadow.ts`): whatever can be
 * computed is computed outside, and `BEGIN IMMEDIATE` is held only for the writes. Syzygy ADR-0008 stage 1 measures how long
 * each writer waited for the lock (`docs/cognition-ledger-contract.md`, *Writes and locks*): one log line a day per meter gives
 * the count and the p95/p99 of the waits, and a separate database file is considered only if p99 exceeds 50 ms.
 */
export class LockWaitMeter {
  private waits: number[] = [];
  private day: string | null = null;

  constructor(private readonly name: string, private readonly log: (line: string) => void = line => console.log(line)) {}

  /** Adds one wait (ms). When the owner-local day of `at` changed, the previous day's line is logged first. */
  record(milliseconds: number, day: string): void {
    if (this.day !== null && this.day !== day) this.flush();
    this.day = day;
    // A day's writes are fewer than two thousand; the cap only keeps a runaway from growing the array.
    if (this.waits.length < 20_000) this.waits.push(Math.max(0, milliseconds));
  }

  summary(): { writes: number; p95: number; p99: number; maximum: number } {
    const sorted = [...this.waits].sort((left, right) => left - right);
    const at = (share: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]! : 0);
    return { writes: sorted.length, p95: at(0.95), p99: at(0.99), maximum: sorted.at(-1) ?? 0 };
  }

  /** Logs the day's line (symbols and numbers only) and starts over. */
  flush(): void {
    if (this.day === null || !this.waits.length) return;
    const { writes, p95, p99, maximum } = this.summary();
    this.log(`Shannon ${this.name} lock waits: day=${this.day} writes=${writes} p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${maximum.toFixed(1)}ms`);
    this.waits = [];
  }
}

/**
 * Runs `operation` under the write lock and returns what it returned. Inside a transaction a caller holds on the same
 * connection it runs in a savepoint (nothing to wait for). The wait for `BEGIN IMMEDIATE` is measured; the busy timeout of
 * the connection bounds it.
 */
export function underWriteLock<T>(database: DatabaseSync, meter: LockWaitMeter | null, day: string, operation: () => T, savepoint = 'shannon_cognition'): T {
  const nested = database.isTransaction;
  const started = performance.now();
  database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  if (!nested) meter?.record(performance.now() - started, day);
  try {
    const result = operation();
    database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    throw error;
  }
}

/** Whether a table exists: a process that does not create the tables (the activity loop) writes nothing until the API has. */
export function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** Logs a failure by name and code only (a message could quote a stored value) and goes on. */
export function loggedFailure(what: string, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.error(`Shannon ${what} failed`, error instanceof Error ? error.name : 'unknown', typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : '');
}

/**
 * Whether an error is SQLite's busy or locked answer (another connection held the write lock past the busy timeout): contention,
 * not a fault of the caller's own (stage 3 review: the workspace journal's circuit and the memory writer's model failures).
 */
export function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)) return true;
  return /database is locked|database table is locked|database schema is locked|SQLITE_BUSY|SQLITE_LOCKED/iu.test(error.message);
}
