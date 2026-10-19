import type { DatabaseSync } from 'node:sqlite';

/**
 * The additions of the Minecraft body recovery (`fcaBodyRecovery.ts`), all additive and idempotent, like `fca_task_budget_estimates`:
 * not steps of the execution schema ledger, and an older build simply ignores them.
 *
 * - `fca_body_release_attempts` (L-11): how often the body was asked to release a lost step, kept across restarts so that the bound of
 *   `FCA_BODY_RELEASE_ATTEMPTS` holds for the step and not for one process.
 * - an index on `fca_task_messages(scope_key, source_task_id)` (L-9): the notice's list of the notes a lost step sent is read by their
 *   source. The table is small (292 rows in production when checked, read-only, 2026-10-19), so the index is cheap; it is made only
 *   when the table is there.
 */
export function ensureBodyRecoverySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fca_body_release_attempts (
    action_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0), updated_at TEXT NOT NULL)`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_task_messages'").get()) {
    db.exec('CREATE INDEX IF NOT EXISTS fca_task_messages_source ON fca_task_messages(scope_key,source_task_id)');
  }
  // L-1: a lost step's operations are found by their task first (`bodyOperations`); the table belongs to the body control, so, like the
  // index above, the index is made when the table is there (an older start without it reads the same rows, only by a scan).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_body_operations'").get()) {
    db.exec('CREATE INDEX IF NOT EXISTS fca_body_operations_task ON fca_body_operations(task_id)');
  }
}
