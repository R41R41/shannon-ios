import type { DatabaseSync } from 'node:sqlite';
import { LockWaitMeter, ownerDayKey, underWriteLock } from '../../../infra/sqlite/lockWaits.js';

/**
 * The memory outbox and the state of its one writer (Syzygy ADR-0008 stage 3, step F5, `docs/mind-workspace-contract.md`).
 * Additive and outside the numbered migrations, created only while `SHANNON_MEMORY_OUTBOX` is on (switched off, no table, so the
 * switched-off proof keeps every table of afb38c28).
 *
 * - `memory_outbox`: one row per proposal, appended by the proposers, applied in `seq` order by the writer. `op_id` is unique, so
 *   a proposal made again (a retried job, a replay after a restart) is stored once. A row ends `applied`, `superseded` (its subject
 *   changed under it three times, or the owner forgot what it came from), `rejected` (the codec refused it) or `failed` (five
 *   model failures).
 * - `memory_writer_state`: one row: how far the writer has applied (`applied_seq`, every row up to it is final) and its lease.
 * - `memory_writer_calls`: the model answers the writer used, by the digest of the request, so a writer that stopped between a
 *   model call and its write gives the same answer again without a second call.
 */
export function ensureMemoryOutboxSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id TEXT NOT NULL UNIQUE,
      scope_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      base_revision TEXT,
      payload_json TEXT NOT NULL,
      episode_ids_json TEXT NOT NULL DEFAULT '[]',
      disclosure_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','applied','superseded','rejected','failed')),
      outcome_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS memory_outbox_pending ON memory_outbox(status, seq);
    CREATE INDEX IF NOT EXISTS memory_outbox_subject ON memory_outbox(scope_key, subject_key, seq);
    CREATE TABLE IF NOT EXISTS memory_writer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      applied_seq INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_until TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_writer_calls (
      call_key TEXT PRIMARY KEY,
      op_seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      answer_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export type MemoryOutboxStatus = 'pending' | 'applied' | 'superseded' | 'rejected' | 'failed';

export interface MemoryOutboxRow {
  seq: number;
  opId: string;
  scopeKey: string;
  kind: string;
  origin: string;
  subjectKey: string;
  baseRevision: string | null;
  payloadJson: string;
  episodeIdsJson: string;
  disclosureJson: string | null;
  status: MemoryOutboxStatus;
  outcomeCode: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  appliedAt: string | null;
}

export interface MemoryOutboxInsert {
  opId: string; scopeKey: string; kind: string; origin: string; subjectKey: string; baseRevision: string | null;
  payloadJson: string; episodeIdsJson: string; disclosureJson: string | null;
}

interface Row {
  seq: number; op_id: string; scope_key: string; kind: string; origin: string; subject_key: string; base_revision: string | null;
  payload_json: string; episode_ids_json: string; disclosure_json: string | null; status: MemoryOutboxStatus; outcome_code: string | null;
  attempts: number; next_attempt_at: string | null; created_at: string; applied_at: string | null;
}

const COLUMNS = `seq, op_id, scope_key, kind, origin, subject_key, base_revision, payload_json, episode_ids_json, disclosure_json,
  status, outcome_code, attempts, next_attempt_at, created_at, applied_at`;

const rowOf = (row: Row): MemoryOutboxRow => Object.freeze({
  seq: Number(row.seq), opId: row.op_id, scopeKey: row.scope_key, kind: row.kind, origin: row.origin, subjectKey: row.subject_key,
  baseRevision: row.base_revision, payloadJson: row.payload_json, episodeIdsJson: row.episode_ids_json, disclosureJson: row.disclosure_json,
  status: row.status, outcomeCode: row.outcome_code, attempts: Number(row.attempts), nextAttemptAt: row.next_attempt_at,
  createdAt: row.created_at, appliedAt: row.applied_at,
});

/** The outbox on one connection. Every write that must be atomic with a memory write runs inside `underLock`. */
export class SQLiteMemoryOutbox {
  constructor(
    private readonly database: DatabaseSync,
    private readonly options: { createsSchema?: boolean; meter?: LockWaitMeter | null } = {},
  ) {
    if (options.createsSchema !== false) ensureMemoryOutboxSchema(database);
  }

  /** The lock meter of this connection's writer waits (`lockWaits.ts`). */
  get meter(): LockWaitMeter | null { return this.options.meter ?? null; }

  /** Runs `operation` under the write lock of the file (`BEGIN IMMEDIATE`; a savepoint inside a caller's transaction). */
  underLock<T>(at: string, operation: () => T): T {
    return underWriteLock(this.database, this.options.meter ?? null, ownerDayKey(at), operation, 'shannon_memory_writer');
  }

  /** Appends a proposal. A proposal with an `op_id` already stored is not stored again: answers null. */
  insert(row: MemoryOutboxInsert, at: string, status: MemoryOutboxStatus = 'pending', outcomeCode: string | null = null): number | null {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO memory_outbox
        (op_id, scope_key, kind, origin, subject_key, base_revision, payload_json, episode_ids_json, disclosure_json, status, outcome_code, attempts, created_at, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(row.opId, row.scopeKey, row.kind, row.origin, row.subjectKey, row.baseRevision, row.payloadJson, row.episodeIdsJson, row.disclosureJson,
      status, outcomeCode, at, status === 'pending' ? null : at);
    return Number(result.changes) === 1 ? Number(result.lastInsertRowid) : null;
  }

  /** Every row up to this seq is final. */
  appliedSeq(): number {
    const row = this.database.prepare('SELECT applied_seq FROM memory_writer_state WHERE id = 1').get() as { applied_seq: number } | undefined;
    return Number(row?.applied_seq ?? 0);
  }

  /** Up to `limit` pending rows after the cursor, in seq order. */
  pending(limit: number): readonly MemoryOutboxRow[] {
    return Object.freeze((this.database.prepare(`SELECT ${COLUMNS} FROM memory_outbox
      WHERE status = 'pending' AND seq > (SELECT COALESCE((SELECT applied_seq FROM memory_writer_state WHERE id = 1), 0))
      ORDER BY seq ASC LIMIT ?`).all(Math.max(1, Math.trunc(limit))) as unknown as Row[]).map(rowOf));
  }

  row(seq: number): MemoryOutboxRow | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM memory_outbox WHERE seq = ?`).get(seq) as unknown as Row | undefined;
    return row ? rowOf(row) : null;
  }

  /** Rows of a scope (every one, or of one status), for the owner's view and tests. */
  rows(options: { scopeKey?: string; status?: MemoryOutboxStatus; limit?: number } = {}): readonly MemoryOutboxRow[] {
    const where = [options.scopeKey !== undefined ? 'scope_key = ?' : '', options.status ? 'status = ?' : ''].filter(Boolean);
    const values = [...(options.scopeKey !== undefined ? [options.scopeKey] : []), ...(options.status ? [options.status] : [])];
    return Object.freeze((this.database.prepare(`SELECT ${COLUMNS} FROM memory_outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY seq ASC LIMIT ?`).all(...values, Math.max(1, Math.trunc(options.limit ?? 1_000))) as unknown as Row[]).map(rowOf));
  }

  /** Takes or renews the lease (one writer at a time); false while another writer holds an unexpired one. */
  acquireLease(owner: string, now: string, until: string): boolean {
    this.database.prepare(`INSERT OR IGNORE INTO memory_writer_state (id, applied_seq, lease_owner, lease_until, updated_at) VALUES (1, 0, NULL, NULL, ?)`).run(now);
    const changed = this.database.prepare(`UPDATE memory_writer_state SET lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = 1 AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until < ?)`).run(owner, until, now, owner, now);
    return Number(changed.changes) === 1;
  }

  /** Whether `owner` still holds the lease at `now` (checked inside the write transaction). */
  holdsLease(owner: string, now: string): boolean {
    const row = this.database.prepare('SELECT lease_owner, lease_until FROM memory_writer_state WHERE id = 1').get() as
      { lease_owner: string | null; lease_until: string | null } | undefined;
    return row?.lease_owner === owner && row.lease_until !== null && row.lease_until >= now;
  }

  releaseLease(owner: string, now: string): void {
    this.database.prepare(`UPDATE memory_writer_state SET lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = 1 AND lease_owner = ?`).run(now, owner);
  }

  /** A row's final status. */
  finish(seq: number, status: Exclude<MemoryOutboxStatus, 'pending'>, outcomeCode: string | null, at: string, attempts?: number): void {
    this.database.prepare(`UPDATE memory_outbox SET status = ?, outcome_code = ?, applied_at = ?, attempts = COALESCE(?, attempts), next_attempt_at = NULL
      WHERE seq = ? AND status = 'pending'`).run(status, outcomeCode, at, attempts ?? null, seq);
  }

  /** A model failure short of the last: tried again after `nextAttemptAt`. */
  retryLater(seq: number, attempts: number, nextAttemptAt: string, outcomeCode: string): void {
    this.database.prepare(`UPDATE memory_outbox SET attempts = ?, next_attempt_at = ?, outcome_code = ? WHERE seq = ? AND status = 'pending'`)
      .run(attempts, nextAttemptAt, outcomeCode, seq);
  }

  /** Moves the cursor over every final row after it (it never moves back, and never past a pending row). */
  advanceCursor(now: string): number {
    const next = this.database.prepare(`SELECT COALESCE(
        (SELECT MIN(seq) - 1 FROM memory_outbox WHERE status = 'pending'),
        (SELECT MAX(seq) FROM memory_outbox), 0) AS cursor`).get() as { cursor: number };
    this.database.prepare(`INSERT OR IGNORE INTO memory_writer_state (id, applied_seq, lease_owner, lease_until, updated_at) VALUES (1, 0, NULL, NULL, ?)`).run(now);
    this.database.prepare('UPDATE memory_writer_state SET applied_seq = MAX(applied_seq, ?), updated_at = ? WHERE id = 1').run(Number(next.cursor), now);
    return this.appliedSeq();
  }

  cachedCall(key: string): string | null {
    const row = this.database.prepare('SELECT answer_json FROM memory_writer_calls WHERE call_key = ?').get(key) as { answer_json: string } | undefined;
    return row?.answer_json ?? null;
  }

  storeCall(key: string, seq: number, kind: string, answerJson: string, at: string): void {
    this.database.prepare(`INSERT OR IGNORE INTO memory_writer_calls (call_key, op_seq, kind, answer_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(key, seq, kind, answerJson, at);
  }

  /** Model answers of one purpose stored since `since` (a daily cap counts them: the people facts' judge, at most 40 a day). */
  callsSince(kind: string, since: string): number {
    const row = this.database.prepare('SELECT COUNT(*) AS calls FROM memory_writer_calls WHERE kind = ? AND created_at >= ?').get(kind, since) as { calls: number };
    return Number(row.calls);
  }

  /** Model answers older than `before` are not needed again (their rows are final long since). */
  pruneCalls(before: string): void {
    this.database.prepare(`DELETE FROM memory_writer_calls WHERE created_at < ? AND op_seq <= COALESCE((SELECT applied_seq FROM memory_writer_state WHERE id = 1), 0)`).run(before);
  }

  /** The text-free payload of a refused row is replaced (a refused text is never kept). */
  static readonly REFUSED_PAYLOAD = '{}';
}
