import type { DatabaseSync } from 'node:sqlite';
import { ensureTaskBudgetSchema } from './taskBudgetMigration.js';

/** What one FCA task has spent (`fca_task_budget`; Syzygy ADR-0009 stage 2, E3). */
export interface TaskSpent { readonly steps: number; readonly yen: number; readonly cappedAt: string | null }

export class TaskBudgetStore {
  constructor(private readonly db: DatabaseSync) {
    ensureTaskBudgetSchema(db);
  }

  spent(taskId: string): TaskSpent {
    const row = this.db.prepare('SELECT steps, yen, capped_at FROM fca_task_budget WHERE task_id = ?').get(taskId);
    if (!row) return { steps: 0, yen: 0, cappedAt: null };
    return { steps: Number(row.steps), yen: Number(row.yen), cappedAt: row.capped_at ? String(row.capped_at) : null };
  }

  /** One paid step of the task, and its yen. */
  add(taskId: string, scopeKey: string, origin: string, yen: number, at: string): TaskSpent {
    this.db.prepare(`
      INSERT INTO fca_task_budget (task_id, scope_key, origin, steps, yen, updated_at) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET steps = steps + 1, yen = yen + excluded.yen, updated_at = excluded.updated_at
    `).run(taskId, scopeKey, origin, Math.max(0, yen), at);
    return this.spent(taskId);
  }

  capped(taskId: string, scopeKey: string, origin: string, at: string): void {
    this.db.prepare(`
      INSERT INTO fca_task_budget (task_id, scope_key, origin, capped_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET capped_at = COALESCE(capped_at, excluded.capped_at), updated_at = excluded.updated_at
    `).run(taskId, scopeKey, origin, at, at);
  }
}
