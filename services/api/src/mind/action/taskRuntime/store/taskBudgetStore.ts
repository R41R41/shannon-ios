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
    // A settled estimate stays on record (with its actual) but is no longer an estimate: only the unsettled ones count here.
    const estimates = this.db.prepare(`SELECT COALESCE(SUM(yen),0) AS total, COALESCE(SUM(CASE WHEN acknowledged_at IS NULL THEN yen END),0) AS open
      FROM fca_task_budget_estimates WHERE task_id = ? AND settled_at IS NULL`).get(taskId);
    const estimated = { estimatedYen: Number(estimates?.total ?? 0), openEstimatedYen: Number(estimates?.open ?? 0) };
    if (!row) return { steps: 0, yen: 0, cappedAt: null, ...estimated };
    return { steps: Number(row.steps), yen: Number(row.yen), cappedAt: row.capped_at ? String(row.capped_at) : null, ...estimated };
  }

  /** What the task has used in yen, confirmed and estimated together (an operator's cap change never goes below it). */
  usedYen(taskId: string): number {
    const spent = this.spent(taskId);
    return spent.yen + spent.estimatedYen;
  }

  /** One paid step of the task, and its confirmed yen (0 for a step whose only charge is an unconfirmed one). */
  add(taskId: string, scopeKey: string, origin: string, yen: number, at: string): TaskSpent {
    this.db.prepare(`
      INSERT INTO fca_task_budget (task_id, scope_key, origin, steps, yen, updated_at) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET steps = steps + 1, yen = yen + excluded.yen, updated_at = excluded.updated_at
    `).run(taskId, scopeKey, origin, Math.max(0, yen), at);
    return this.spent(taskId);
  }

  /**
   * The upper bound of a charge nobody confirmed, under a key of its own (one step's, `<action>:<generation>`). A repeat of a key whose
   * estimate is still open is added to it; one that is already acknowledged (the owner was asked about it) or settled is never added
   * onto: the new charge is a row of its own (`<key>+<n>`), open, so that it neither hides in a reviewed estimate nor changes a settled
   * one (L-6).
   */
  addEstimate(taskId: string, scopeKey: string, origin: string, requestKey: string, yen: number, at: string): void {
    const amount = Math.max(0, yen);
    // The rows of this key's family: the key itself and its later parts (`<key>+<n>`), oldest first.
    const family = this.db.prepare(`SELECT request_key, acknowledged_at, settled_at FROM fca_task_budget_estimates
      WHERE task_id = ? AND (request_key = ? OR request_key LIKE ? ESCAPE '\\') ORDER BY rowid`)
      .all(taskId, requestKey, `${requestKey.replace(/[\\%_]/gu, '\\$&')}+%`);
    const open = family.find(row => row.acknowledged_at === null && row.settled_at === null);
    if (open) {
      this.db.prepare('UPDATE fca_task_budget_estimates SET yen = yen + ? WHERE task_id = ? AND request_key = ?').run(amount, taskId, String(open.request_key));
      return;
    }
    const key = family.length ? `${requestKey}+${family.length}` : requestKey;
    this.db.prepare(`INSERT INTO fca_task_budget_estimates (task_id, request_key, scope_key, origin, yen, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, request_key) DO UPDATE SET yen = yen + excluded.yen`).run(taskId, key, scopeKey, origin, amount, at);
  }

  /**
   * The actual charge of an estimated one has become known: the estimate is marked settled with that actual (the row stays on record; it
   * no longer counts as an estimate), the actual is added to the confirmed spend, and no step is counted again. False: no such open
   * estimate. Nothing calls this yet; the provider's answers to a lost request are not read back, so this is the single place where a
   * later reconciliation of the bill would land.
   */
  settleEstimate(taskId: string, requestKey: string, actualYen: number, at: string): boolean {
    const actual = Math.max(0, actualYen);
    const settled = this.db.prepare(`UPDATE fca_task_budget_estimates SET settled_at = ?, actual_yen = ?
      WHERE task_id = ? AND request_key = ? AND settled_at IS NULL`).run(at, actual, taskId, requestKey);
    if (Number(settled.changes) === 0) return false;
    const own = this.db.prepare('SELECT scope_key, origin FROM fca_task_budget_estimates WHERE task_id = ? AND request_key = ?').get(taskId, requestKey)!;
    // A task that has no confirmed row yet gets one (without a step: the estimate's step was counted when it was booked).
    this.db.prepare(`INSERT INTO fca_task_budget (task_id, scope_key, origin, steps, yen, updated_at) VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET yen = yen + excluded.yen, updated_at = excluded.updated_at`)
      .run(taskId, String(own.scope_key), String(own.origin), actual, at);
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
