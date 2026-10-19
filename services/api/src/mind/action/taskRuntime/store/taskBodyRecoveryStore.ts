import type { DatabaseSync } from 'node:sqlite';

/** A task's checkpoint row as the Minecraft recovery reads it (`fcaBodyRecovery.ts`). */
export interface RecoveryCheckpoint { stepId: string | null; checkpointJson: string | null; stopRequested: boolean; leaseId: string | null }

/** What a lost step may have done to other tasks (`TaskBodyRecoveryStore.effectsSince`): facts for the model, never for a log. */
export interface LostStepEffects {
  children: Array<{ id: string; title: string; status: string }>;
  notes: Array<{ to: string; id: string; preview: string }>;
}

/**
 * The reads and the one write the Minecraft recovery makes on a task's checkpoint (Minebot parity audit C-21, 2026-10-19). Status
 * and events stay with the task authority; this only lets go of a lost step and keeps the task's own checkpoint (the count of its
 * recoveries among it). The caller holds the authority transaction and writes the event after it.
 */
export class TaskBodyRecoveryStore {
  constructor(private readonly db: DatabaseSync) {}

  checkpoint(taskId: string): RecoveryCheckpoint | undefined {
    const row = this.db.prepare('SELECT step_id,checkpoint_json,stop_requested,lease_json FROM fca_task_checkpoints WHERE task_id=?').get(taskId);
    if (!row) return undefined;
    return { stepId: typeof row.step_id === 'string' ? row.step_id : null,
      checkpointJson: typeof row.checkpoint_json === 'string' ? row.checkpoint_json : null, stopRequested: Number(row.stop_requested) !== 0,
      leaseId: leaseIdOf(row.lease_json) };
  }

  /** The tasks of the scope that are unknown now (paused with `fca_unknown`), whatever made them so. */
  unknownTaskIds(scopeKey: string): string[] {
    return this.db.prepare("SELECT task_id FROM agent_tasks WHERE scope_key=? AND status='paused' AND pause_reason='fca_unknown'").all(scopeKey)
      .map(row => String(row.task_id));
  }

  /** Whether the message is in the task's inbox, pending or already taken by a step: the only proof that a notice is stored. */
  messageStored(scopeKey: string, taskId: string, messageId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM fca_task_messages WHERE scope_key=? AND target_task_id=? AND message_id=?').get(scopeKey, taskId, messageId));
  }

  /**
   * The children the lost step may have made and the notes it may have sent (made or sent at or after `since`, the step's start): the
   * recovery names them so that the model does not make or send them twice. The newest eight of each; a note is cut to a preview.
   * Recovery's guarantees cover body operations only; these two are listed, not closed.
   */
  effectsSince(scopeKey: string, taskId: string, since: string | null): LostStepEffects {
    if (since === null) return { children: [], notes: [] };
    const children = this.db.prepare(`SELECT task_id,title,status FROM agent_tasks WHERE scope_key=? AND fca_parent_id=? AND created_at>=?
      ORDER BY created_at DESC,task_id DESC LIMIT 8`).all(scopeKey, taskId, since)
      .map(row => ({ id: String(row.task_id), title: String(row.title).slice(0, 60), status: String(row.status) })).reverse();
    const notes = this.db.prepare(`SELECT message_id,target_task_id,text FROM fca_task_messages WHERE scope_key=? AND source_task_id=?
      AND target_task_id<>? AND received_at>=? AND message_id NOT LIKE 'context:%' ORDER BY rowid DESC LIMIT 8`).all(scopeKey, taskId, taskId, since)
      .map(row => ({ to: String(row.target_task_id), id: String(row.message_id), preview: String(row.text).slice(0, 80) })).reverse();
    return { children, notes };
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

function leaseIdOf(json: unknown): string | null {
  if (typeof json !== 'string') return null;
  try {
    const lease = JSON.parse(json) as { id?: unknown };
    return typeof lease.id === 'string' ? lease.id : null;
  } catch {
    return null;
  }
}
