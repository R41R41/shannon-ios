import { DatabaseSync } from 'node:sqlite';
import type { OnAir } from '../../contracts/onAirContract.js';
import { secureDatabaseFiles } from '../sqlite/sqliteStoreContext.js';

/**
 * 「収録中」, one row per scope (`contracts/onAirContract.ts`), on a connection of its own. A scope with no row is not on air, a row past its end is
 * not on air, and so is a row that cannot be read: a wrong "on air" puts a call to viewers into an ordinary talk, a wrong "not on air" only leaves it
 * out, so every doubt is "not on air". The route writes it; the spoken reply's prompt only reads it (the operations snapshot's store is not used,
 * because that one is kept out of every prompt).
 */
export class SQLiteOnAirStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS on_air (
        scope_key TEXT NOT NULL PRIMARY KEY,
        until_at TEXT NOT NULL,
        note TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
    `);
    secureDatabaseFiles(path);
  }

  /** The state now, or null when it was never set, has lapsed, or cannot be read. `now` is an ISO time. */
  active(scopeKey: string, now: string): OnAir | null {
    try {
      const row = this.database.prepare('SELECT until_at, note FROM on_air WHERE scope_key = ?')
        .get(scopeKey) as { until_at?: unknown; note?: unknown } | undefined;
      if (!row || typeof row.until_at !== 'string' || typeof row.note !== 'string') return null;
      const until = Date.parse(row.until_at), at = Date.parse(now);
      return Number.isFinite(until) && Number.isFinite(at) && until > at ? { until: row.until_at, note: row.note } : null;
    } catch {
      return null;
    }
  }

  set(scopeKey: string, state: OnAir, at: string): void {
    this.database.prepare(`
      INSERT INTO on_air (scope_key, until_at, note, changed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET until_at = excluded.until_at, note = excluded.note, changed_at = excluded.changed_at
    `).run(scopeKey, state.until, state.note, at);
  }

  clear(scopeKey: string): void {
    this.database.prepare('DELETE FROM on_air WHERE scope_key = ?').run(scopeKey);
  }

  close(): void {
    this.database.close();
  }
}
