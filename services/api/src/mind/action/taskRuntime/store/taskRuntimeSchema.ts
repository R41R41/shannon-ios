import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority } from '../taskRuntimePorts.js';
export function ensureTaskRuntimeSchema(db: DatabaseSync, authority: TaskAuthority): void {
    db.exec(`CREATE TABLE IF NOT EXISTS fca_task_checkpoints (
      task_id TEXT PRIMARY KEY REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
      checkpoint_json TEXT, wait_reason TEXT, stop_requested INTEGER NOT NULL DEFAULT 0,
      step_id TEXT, lease_json TEXT, last_admission INTEGER NOT NULL DEFAULT 0, observed_messages_json TEXT);
      CREATE TABLE IF NOT EXISTS fca_task_dispatch_order (
      scope_key TEXT PRIMARY KEY, last_admission INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_task_messages (
      scope_key TEXT NOT NULL, message_id TEXT NOT NULL, source_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      target_task_id TEXT NOT NULL REFERENCES agent_tasks(task_id), text TEXT NOT NULL, received_at TEXT NOT NULL,
      consumed_by TEXT, PRIMARY KEY(scope_key,message_id));
      CREATE INDEX IF NOT EXISTS fca_task_inbox ON fca_task_messages(target_task_id,consumed_by);
      CREATE TABLE IF NOT EXISTS fca_task_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      step_id TEXT NOT NULL UNIQUE, entries_json TEXT NOT NULL, committed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_task_segment_receipts (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
      lease_json TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'completed');`);
    authority.transaction(() => {
      if (!db.prepare('PRAGMA table_info(fca_task_checkpoints)').all().some(row => row.name === 'observed_messages_json')) {
        db.exec('ALTER TABLE fca_task_checkpoints ADD COLUMN observed_messages_json TEXT');
      }
      if (!db.prepare('PRAGMA table_info(fca_task_checkpoints)').all().some(row => row.name === 'last_admission')) {
        db.exec('ALTER TABLE fca_task_checkpoints ADD COLUMN last_admission INTEGER NOT NULL DEFAULT 0');
      }
      if (!db.prepare('PRAGMA table_info(fca_task_segment_receipts)').all().some(row => row.name === 'state')) {
        db.exec("ALTER TABLE fca_task_segment_receipts ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'");
      }
    });
}
