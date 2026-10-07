import type { DatabaseSync } from 'node:sqlite';
import { checkedMindInboxDraft, type MindInboxDraft, type StoredMindInboxRow } from '../../../contracts/mindInboxContract.js';

/**
 * `mind_inbox` (Syzygy ADR-0008 stage 3, `contracts/mindInboxContract.ts`): rows of closed fields that another process (her own
 * time, a worker) hands the mind. The API process creates the table while the workspace is on and tails it; a writer in another
 * process writes only once the table exists, so with the workspace off nothing is written anywhere. Kept 7 days.
 */
export const MIND_INBOX_KEEP_DAYS = 7;

export function ensureMindInboxSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mind_inbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      code TEXT NOT NULL,
      audience TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      tool TEXT,
      reason TEXT,
      delta_minutes INTEGER,
      ref TEXT
    );
    CREATE INDEX IF NOT EXISTS mind_inbox_at ON mind_inbox (at);
  `);
}

export class SQLiteMindInbox {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureMindInboxSchema(database);
  }

  get available(): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'mind_inbox'`).get());
  }

  /** One row; false when the table does not exist (the workspace is off in the API process). Throws on a value that is not closed. */
  append(scopeKey: string, draft: MindInboxDraft, at: string): boolean {
    const row = checkedMindInboxDraft(draft);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}$/u.test(scopeKey) || !Number.isFinite(Date.parse(at))) throw new Error('MIND_INBOX_SCOPE');
    if (!this.available) return false;
    this.database.prepare(`
      INSERT INTO mind_inbox (scope_key, at, kind, code, audience, source, source_id, tool, reason, delta_minutes, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, new Date(Date.parse(at)).toISOString(), row.kind, row.code, row.audience, row.source, row.sourceId, row.tool, row.reason, row.deltaMinutes, row.ref);
    return true;
  }

  /** Rows after `seq`, oldest first, not older than `since`. */
  after(seq: number, since: string, limit = 100): StoredMindInboxRow[] {
    return (this.database.prepare('SELECT * FROM mind_inbox WHERE seq > ? AND at >= ? ORDER BY seq LIMIT ?').all(seq, since, limit) as Array<Record<string, unknown>>)
      .map(row => ({
        seq: Number(row.seq), scopeKey: String(row.scope_key), at: String(row.at), kind: String(row.kind) as StoredMindInboxRow['kind'],
        code: String(row.code), audience: String(row.audience) as StoredMindInboxRow['audience'], source: String(row.source) as StoredMindInboxRow['source'],
        sourceId: String(row.source_id), tool: row.tool === null ? null : String(row.tool), reason: row.reason === null ? null : String(row.reason),
        deltaMinutes: row.delta_minutes === null ? null : Number(row.delta_minutes), ref: row.ref === null ? null : String(row.ref),
      }));
  }

  lastSeq(): number {
    const row = this.database.prepare('SELECT MAX(seq) AS seq FROM mind_inbox').get() as { seq: number | null } | undefined;
    return Number(row?.seq ?? 0);
  }

  prune(before: string): number {
    return Number(this.database.prepare('DELETE FROM mind_inbox WHERE at < ?').run(before).changes);
  }
}
