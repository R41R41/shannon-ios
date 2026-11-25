import { DatabaseSync } from 'node:sqlite';
import type { OnAir, OnAirControl } from '../../contracts/onAirContract.js';
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

  /** Ends it now but keeps the note the owner wrote, so that turning it on again from a button does not lose the scene. */
  end(scopeKey: string, at: string): void {
    this.database.prepare('UPDATE on_air SET until_at = ?, changed_at = ? WHERE scope_key = ?').run(at, at, scopeKey);
  }

  /** The note last written for this scope, whether or not it is on air now; '' when there is none or it cannot be read. */
  lastNote(scopeKey: string): string {
    try {
      const row = this.database.prepare('SELECT note FROM on_air WHERE scope_key = ?').get(scopeKey) as { note?: unknown } | undefined;
      return typeof row?.note === 'string' ? row.note : '';
    } catch {
      return '';
    }
  }

  clear(scopeKey: string): void {
    this.database.prepare('DELETE FROM on_air WHERE scope_key = ?').run(scopeKey);
  }

  close(): void {
    this.database.close();
  }
}

/** The button's way into the store (`OnAirControl`): the scope is the owner's and the clock is the server's; the note written last is kept. */
export function onAirControlOf(store: Pick<SQLiteOnAirStore, 'active' | 'set' | 'end' | 'lastNote'>, scopeKey: string, now: () => string): OnAirControl {
  const at = (): string => new Date(Date.parse(now())).toISOString();
  return {
    until: () => store.active(scopeKey, at())?.until ?? null,
    start: minutes => store.set(scopeKey, { until: new Date(Date.parse(at()) + minutes * 60_000).toISOString(), note: store.lastNote(scopeKey) }, at()),
    stop: () => store.end(scopeKey, at()),
  };
}
