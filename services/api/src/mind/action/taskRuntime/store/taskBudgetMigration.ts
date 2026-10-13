import type { DatabaseSync } from 'node:sqlite';

/**
 * What one FCA task has spent (Syzygy ADR-0009 stage 2, E3): its paid steps and their yen, so a task the owner asked for stops at
 * its own cap (300 yen, 40 steps; owner answer 3) with a report, and an own-time task's steps stay inside her day's budget. A
 * table of its own beside `agent_tasks` (not a state of the task), additive and made by the FCA runtime when it opens; it is not
 * a step of the execution schema ledger because nothing else reads it and an older build simply ignores it.
 */
export function ensureTaskBudgetSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fca_task_budget (
      task_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, origin TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
      yen REAL NOT NULL DEFAULT 0 CHECK (yen >= 0), capped_at TEXT, updated_at TEXT NOT NULL
    );
  `);
}
