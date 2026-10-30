import type { DatabaseSync } from 'node:sqlite';
import { tableColumns } from '../sqliteOpen.js';

/** 見る要求の既存スキーマとsource列を、従来と同じ順に用意する。 */
export function ensureBodyLookSchema(database: DatabaseSync): void {
  database.exec(`
      CREATE TABLE IF NOT EXISTS body_looks (
        look_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        day_key TEXT NOT NULL,
        owner_asked INTEGER NOT NULL DEFAULT 0 CHECK (owner_asked IN (0, 1)),
        outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'seeing', 'seen', 'refused', 'discarded', 'expired', 'failed')),
        code TEXT,
        frame_received_at TEXT,
        completed_at TEXT,
        source TEXT NOT NULL DEFAULT 'camera' CHECK (source IN ('camera', 'screen'))
      );
      CREATE INDEX IF NOT EXISTS body_looks_scope_time ON body_looks (scope_key, requested_at DESC);
      CREATE INDEX IF NOT EXISTS body_looks_scope_day ON body_looks (scope_key, day_key);
    `);
  // A table made before looks had a source gets the column (the API and the activity loop both open this table).
  const columns = tableColumns(database, 'body_looks');
  if (!columns.has('source')) {
    try {
      database.exec("ALTER TABLE body_looks ADD COLUMN source TEXT NOT NULL DEFAULT 'camera' CHECK (source IN ('camera', " + "'screen'))");
    } catch (error) {
      // The other process added it first.
      const again = tableColumns(database, 'body_looks');
      if (!again.has('source')) throw error;
    }
  }
}
