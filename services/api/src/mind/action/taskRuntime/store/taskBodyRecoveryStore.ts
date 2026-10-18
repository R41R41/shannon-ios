import type { DatabaseSync } from 'node:sqlite';

/** A task's checkpoint row as the Minecraft recovery reads it (`fcaBodyRecovery.ts`). */
export interface RecoveryCheckpoint { stepId: string | null; checkpointJson: string | null; stopRequested: boolean }

/**
 * The reads and the one write the Minecraft recovery makes on a task's checkpoint (Minebot parity audit C-21, 2026-10-19). Status
 * and events stay with the task authority; this only lets go of a lost step and keeps the task's own checkpoint (the count of its
 * recoveries among it). The caller holds the authority transaction and writes the event after it.
 */
export class TaskBodyRecoveryStore {
  constructor(private readonly db: DatabaseSync) {}

  checkpoint(taskId: string): RecoveryCheckpoint | undefined {
    const row = this.db.prepare('SELECT step_id,checkpoint_json,stop_requested FROM fca_task_checkpoints WHERE task_id=?').get(taskId);
    if (!row) return undefined;
    return { stepId: typeof row.step_id === 'string' ? row.step_id : null,
      checkpointJson: typeof row.checkpoint_json === 'string' ? row.checkpoint_json : null, stopRequested: Number(row.stop_requested) !== 0 };
  }

  /** The tasks of the scope that are unknown now (paused with `fca_unknown`), whatever made them so. */
  unknownTaskIds(scopeKey: string): string[] {
    return this.db.prepare("SELECT task_id FROM agent_tasks WHERE scope_key=? AND status='paused' AND pause_reason='fca_unknown'").all(scopeKey)
      .map(row => String(row.task_id));
  }

  /**
   * The task lets go of its lost step: no step, no lease, no wait. `checkpointJson` replaces the task's checkpoint when given; `clearStop`
   * ends a stop request that no step is left to acknowledge (a pause the owner may resume).
   */
  releaseStep(taskId: string, change: { checkpointJson?: string; clearStop?: boolean } = {}): void {
    const stop = change.clearStop ? ',stop_requested=0' : '';
    if (change.checkpointJson === undefined) {
      this.db.prepare(`UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason=NULL${stop} WHERE task_id=?`).run(taskId);
      return;
    }
    this.db.prepare(`UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason=NULL,checkpoint_json=?${stop} WHERE task_id=?`)
      .run(change.checkpointJson, taskId);
  }
}
