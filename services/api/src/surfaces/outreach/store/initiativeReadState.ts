import { DatabaseSync } from 'node:sqlite';

/**
 * The read state of her initiatives, as freshness at delivery needs it (`initiativeFreshness.ts`, owner decision 2026-10-14): the
 * scope's unread initiatives as source keys and times, and a read that leaves some of them unread. Its own connection to
 * `initiative_messages`, which `initiativeStore.ts` creates; without that table it reads nothing and marks nothing.
 */
export class SQLiteInitiativeReadState {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  /** The scope's unread initiatives, newest first (at most 200). */
  unread(scopeKey: string): Array<{ id: string; sourceItemId: string; createdAt: string }> {
    if (!this.tableExists()) return [];
    const rows = this.database.prepare(`
      SELECT initiative_id, source_item_id, created_at FROM initiative_messages
      WHERE scope_key = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 200
    `).all(scopeKey) as unknown as Array<{ initiative_id: string; source_item_id: string; created_at: string }>;
    return rows.map(row => ({ id: row.initiative_id, sourceItemId: row.source_item_id, createdAt: row.created_at }));
  }

  /** Marks read what `markRead` would (the thread's, or all), except the ids in `except`. */
  markReadExcept(scopeKey: string, threadId: string | undefined, readAt: string, except: ReadonlySet<string>): number {
    if (!this.tableExists()) return 0;
    const kept = [...except];
    const keep = kept.length ? ` AND initiative_id NOT IN (${kept.map(() => '?').join(', ')})` : '';
    const thread = threadId ? ' AND thread_id = ?' : '';
    const result = this.database.prepare(`
      UPDATE initiative_messages SET read_at = ? WHERE scope_key = ? AND read_at IS NULL${thread}${keep}
    `).run(readAt, scopeKey, ...(threadId ? [threadId] : []), ...kept);
    return Number(result.changes);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private tableExists(): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'initiative_messages'`).get());
  }
}
