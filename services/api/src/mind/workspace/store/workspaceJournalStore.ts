import type { DatabaseSync } from 'node:sqlite';

/**
 * The workspace's journal and snapshots (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`). Additive tables, created
 * only by the API process while the workspace is switched on:
 * - `mind_workspace_journal`: append-only operations (perceive, bind, flush, and `mind_fault` traces), closed values and ids,
 *   never text; kept 7 days.
 * - `mind_workspace_snapshots`: one row per scope, the workspace as JSON (closed values) and the journal seq it covers.
 * Restore is the snapshot and the journal rows after it.
 */
export const WORKSPACE_JOURNAL_KEEP_DAYS = 7;

export interface JournalRow { seq: number; scopeKey: string; at: string; op: string; itemId: string | null; data: Record<string, unknown> }
export interface SnapshotRow { scopeKey: string; journalSeq: number; takenAt: string; state: string }

export function ensureWorkspaceSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mind_workspace_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      at TEXT NOT NULL,
      op TEXT NOT NULL,
      item_id TEXT,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mind_workspace_journal_scope ON mind_workspace_journal (scope_key, seq);
    CREATE INDEX IF NOT EXISTS mind_workspace_journal_at ON mind_workspace_journal (at);
    CREATE TABLE IF NOT EXISTS mind_workspace_snapshots (
      scope_key TEXT PRIMARY KEY,
      journal_seq INTEGER NOT NULL,
      taken_at TEXT NOT NULL,
      state_json TEXT NOT NULL
    );
  `);
}

export class SQLiteWorkspaceJournal {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureWorkspaceSchema(database);
  }

  /** Appends a batch in one transaction; answers the last seq written. */
  append(rows: ReadonlyArray<Omit<JournalRow, 'seq'>>): number {
    if (!rows.length) return this.lastSeq();
    const insert = this.database.prepare('INSERT INTO mind_workspace_journal (scope_key, at, op, item_id, data_json) VALUES (?, ?, ?, ?, ?)');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      let last = 0;
      for (const row of rows) last = Number(insert.run(row.scopeKey, row.at, row.op, row.itemId, JSON.stringify(row.data)).lastInsertRowid);
      this.database.exec('COMMIT');
      return last;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  lastSeq(): number {
    const row = this.database.prepare('SELECT MAX(seq) AS seq FROM mind_workspace_journal').get() as { seq: number | null } | undefined;
    return Number(row?.seq ?? 0);
  }

  /** A scope's operations after `seq`, oldest first, not older than `since`. */
  after(scopeKey: string, seq: number, since: string): JournalRow[] {
    return (this.database.prepare('SELECT * FROM mind_workspace_journal WHERE scope_key = ? AND seq > ? AND at >= ? ORDER BY seq')
      .all(scopeKey, seq, since) as Array<Record<string, unknown>>).map(row => ({
      seq: Number(row.seq), scopeKey: String(row.scope_key), at: String(row.at), op: String(row.op),
      itemId: row.item_id === null ? null : String(row.item_id), data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    }));
  }

  /** Every scope with a journal row or a snapshot. */
  scopes(): string[] {
    return (this.database.prepare('SELECT scope_key FROM mind_workspace_journal UNION SELECT scope_key FROM mind_workspace_snapshots ORDER BY scope_key')
      .all() as Array<{ scope_key: string }>).map(row => row.scope_key);
  }

  snapshot(scopeKey: string): SnapshotRow | null {
    const row = this.database.prepare('SELECT * FROM mind_workspace_snapshots WHERE scope_key = ?').get(scopeKey) as Record<string, unknown> | undefined;
    return row ? { scopeKey: String(row.scope_key), journalSeq: Number(row.journal_seq), takenAt: String(row.taken_at), state: String(row.state_json) } : null;
  }

  writeSnapshot(row: SnapshotRow): void {
    this.database.prepare(`
      INSERT INTO mind_workspace_snapshots (scope_key, journal_seq, taken_at, state_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET journal_seq = excluded.journal_seq, taken_at = excluded.taken_at, state_json = excluded.state_json
    `).run(row.scopeKey, row.journalSeq, row.takenAt, row.state);
  }

  /** Drops journal rows older than `before` (7 days by the contract). */
  prune(before: string): number {
    return Number(this.database.prepare('DELETE FROM mind_workspace_journal WHERE at < ?').run(before).changes);
  }
}
