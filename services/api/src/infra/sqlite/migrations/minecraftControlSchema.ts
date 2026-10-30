import type { DatabaseSync } from 'node:sqlite';
import { tableColumns } from '../sqliteOpen.js';

/** 体の操作の表と互換列。既存データの状態の補完はストアが続けて行う。 */
export function ensureMinecraftControlSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fca_body_operations (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      command_json TEXT NOT NULL, phase TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS fca_body_operations_body ON fca_body_operations(body_id,phase);
      CREATE TABLE IF NOT EXISTS fca_body_bindings(task_id TEXT PRIMARY KEY, body_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_body_sessions(id TEXT PRIMARY KEY, context_json TEXT NOT NULL, receipt_json TEXT);`);
  const have = tableColumns(db, 'fca_body_operations');
  const add = (name: string, definition: string) => {
    if (!have.has(name)) db.exec(`ALTER TABLE fca_body_operations ADD COLUMN ${name} ${definition}`);
  };
  add('state', 'TEXT');
  add('hold', "TEXT NOT NULL DEFAULT 'none'");
  add('told', 'INTEGER NOT NULL DEFAULT 0');
  add('correction_said', 'INTEGER NOT NULL DEFAULT 0');
  add('head_boot', 'TEXT');
  add('uses_json', 'TEXT');
  add('fetch_seq', 'INTEGER NOT NULL DEFAULT 0');
  add('released_by', 'TEXT');
  add('ledger_done', 'INTEGER NOT NULL DEFAULT 0');
  add('resume_of', 'TEXT');
}
