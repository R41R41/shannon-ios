import type { DatabaseSync } from 'node:sqlite';
import { ensureTaskBudgetSchema } from './taskBudgetMigration.js';

/**
 * What one FCA task has spent (`fca_task_budget`; Syzygy ADR-0009 stage 2, E3). `yen` is the confirmed spend. `estimatedYen` is the
 * upper bound of charges nobody confirmed (a request that timed out or lost its connection; `fca_task_budget_estimates`), and
 * `openEstimatedYen` the part of it the owner has not yet been asked about: only that part counts toward the task's cap check, and only
 * up to a share of the cap (`fcaBudgetWiring.ts`).
 */
export interface TaskSpent {
  readonly steps: number; readonly yen: number; readonly cappedAt: string | null;
  readonly estimatedYen: number; readonly openEstimatedYen: number;
}

export class TaskBudgetStore {
  constructor(private readonly db: DatabaseSync) {
    ensureTaskBudgetSchema(db);
  }

  spent(taskId: string): TaskSpent {
    const row = this.db.prepare('SELECT steps, yen, capped_at FROM fca_task_budget WHERE task_id = ?').get(taskId);
    const estimates = this.db.prepare(`SELECT COALESCE(SUM(yen),0) AS total, COALESCE(SUM(CASE WHEN acknowledged_at IS NULL THEN yen END),0) AS open
      FROM fca_task_budget_estimates WHERE task_id = ?`).get(taskId);
    const estimated = { estimatedYen: Number(estimates?.total ?? 0), openEstimatedYen: Number(estimates?.open ?? 0) };
    if (!row) return { steps: 0, yen: 0, cappedAt: null, ...estimated };
    return { steps: Number(row.steps), yen: Number(row.yen), cappedAt: row.capped_at ? String(row.capped_at) : null, ...estimated };
  }

  /** One paid step of the task, and its confirmed yen (0 for a step whose only charge is an unconfirmed one). */
  add(taskId: string, scopeKey: string, origin: string, yen: number, at: string): TaskSpent {
    this.db.prepare(`
      INSERT INTO fca_task_budget (task_id, scope_key, origin, steps, yen, updated_at) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET steps = steps + 1, yen = yen + excluded.yen, updated_at = excluded.updated_at
    `).run(taskId, scopeKey, origin, Math.max(0, yen), at);
    return this.spent(taskId);
  }

  /** The upper bound of a charge nobody confirmed, under a key of its own (one step's, `<action>:<generation>`). Added to if the key repeats. */
  addEstimate(taskId: string, scopeKey: string, origin: string, requestKey: string, yen: number, at: string): void {
    this.db.prepare(`
      INSERT INTO fca_task_budget_estimates (task_id, request_key, scope_key, origin, yen, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, request_key) DO UPDATE SET yen = yen + excluded.yen
    `).run(taskId, requestKey, scopeKey, origin, Math.max(0, yen), at);
  }

  /**
   * The actual charge of an estimated one has become known: the estimate is replaced by it (the actual is added to the confirmed spend,
   * and no step is counted again). False: no such estimate. Nothing calls this yet; the provider's answers to a lost request are not
   * read back, so this is the single place where a later reconciliation of the bill would land.
   */
  settleEstimate(taskId: string, requestKey: string, actualYen: number, at: string): boolean {
    const removed = this.db.prepare('DELETE FROM fca_task_budget_estimates WHERE task_id = ? AND request_key = ?').run(taskId, requestKey);
    if (Number(removed.changes) === 0) return false;
    this.db.prepare('UPDATE fca_task_budget SET yen = yen + ?, updated_at = ? WHERE task_id = ?').run(Math.max(0, actualYen), at, taskId);
    return true;
  }

  /** The owner has been asked (the task was paused): the estimates so far no longer count toward a pause, though they stay on record. */
  acknowledgeEstimates(taskId: string, at: string): void {
    this.db.prepare('UPDATE fca_task_budget_estimates SET acknowledged_at = ? WHERE task_id = ? AND acknowledged_at IS NULL').run(at, taskId);
  }

  capped(taskId: string, scopeKey: string, origin: string, at: string): void {
    this.db.prepare(`
      INSERT INTO fca_task_budget (task_id, scope_key, origin, capped_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET capped_at = COALESCE(capped_at, excluded.capped_at), updated_at = excluded.updated_at
    `).run(taskId, scopeKey, origin, at, at);
  }
}
