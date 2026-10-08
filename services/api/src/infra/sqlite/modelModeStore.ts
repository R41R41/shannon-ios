import { DatabaseSync } from 'node:sqlite';
import type { ModelModePreference, ModelModeStore, PrimaryModelMode } from '../../contracts/modelModeContract.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

const DEFAULT: ModelModePreference = Object.freeze({ mode: 'haiku', revision: 0 });
/** Additive schema: old binaries ignore this table, and no existing state or schema-version row is rewritten. */
export function ensureModelModeSchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS primary_model_preferences (
    scope_key TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('haiku','sonnet')),
    revision INTEGER NOT NULL CHECK (revision > 0)
  )`);
}
export class SQLiteModelModeStore implements ModelModeStore {
  private readonly database: DatabaseSync;
  constructor(private readonly path: string, private readonly writable = true) {
    this.database = new DatabaseSync(path, { readOnly: !writable });
    this.database.exec('PRAGMA busy_timeout=5000');
    if (writable) {
      this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      try { ensureModelModeSchema(this.database); this.database.exec('COMMIT'); secureDatabaseFiles(path); }
      catch (error) { if (this.database.isTransaction) this.database.exec('ROLLBACK'); this.database.close(); throw error; }
    }
  }
  read(scope: string): ModelModePreference {
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='primary_model_preferences'").get()) return DEFAULT;
    const row = this.database.prepare('SELECT mode,revision FROM primary_model_preferences WHERE scope_key=?').get(scope);
    if (!row) return DEFAULT;
    if ((row.mode !== 'haiku' && row.mode !== 'sonnet') || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) throw new Error('MODEL_MODE_STORE_INVALID');
    return Object.freeze({ mode: row.mode, revision: Number(row.revision) });
  }
  compareAndSet(scope: string, expected: number, mode: PrimaryModelMode): ModelModePreference | null {
    if (!this.writable) throw new Error('MODEL_MODE_READ_ONLY');
    if (!Number.isSafeInteger(expected) || expected < 0 || !['haiku', 'sonnet'].includes(mode)) throw new Error('MODEL_MODE_INVALID');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(scope);
      if (current.revision !== expected) { this.database.exec('ROLLBACK'); return null; }
      if (current.mode === mode) { this.database.exec('COMMIT'); return current; }
      if (!Number.isSafeInteger(current.revision + 1)) throw new Error('MODEL_MODE_REVISION_EXHAUSTED');
      const next = { mode, revision: current.revision + 1 };
      this.database.prepare(`INSERT INTO primary_model_preferences(scope_key,mode,revision) VALUES(?,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET mode=excluded.mode,revision=excluded.revision`).run(scope, mode, next.revision);
      this.database.exec('COMMIT');
      return Object.freeze(next);
    } catch (error) { if (this.database.isTransaction) this.database.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.database.close(); }
}
