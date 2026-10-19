import type { DatabaseSync } from 'node:sqlite';
import { ensureBodyRecoverySchema } from './taskBodyRecoveryMigration.js';

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
  /** False when the extra tables could not be made (a read-only database): the counts then live in memory only, as they did. */
  private tables = true;

  constructor(private readonly db: DatabaseSync) {
    try {
      ensureBodyRecoverySchema(db);
    } catch {
      this.tables = false;
    }
  }

  /** How often the body was asked to release this lost step while its task was active (`attempts`) and while it was paused (`held`). */
  releaseAttempts(actionId: string): { attempts: number; held: number } {
    if (!this.tables) return { attempts: 0, held: 0 };
    try {
      const row = this.db.prepare('SELECT attempts,held FROM fca_body_release_attempts WHERE action_id=?').get(actionId);
      return { attempts: Number(row?.attempts ?? 0), held: Number(row?.held ?? 0) };
    } catch {
      return { attempts: 0, held: 0 };
    }
  }

  setReleaseAttempts(actionId: string, taskId: string, counts: { attempts: number; held: number }, at: string): void {
    if (!this.tables) return;
    try {
      this.db.prepare(`INSERT INTO fca_body_release_attempts (action_id,task_id,attempts,held,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(action_id) DO UPDATE SET attempts=excluded.attempts,held=excluded.held,updated_at=excluded.updated_at`)
        .run(actionId, taskId, counts.attempts, counts.held, at);
    } catch { /* the counts of this process still hold */ }
  }

  clearReleaseAttempts(actionId: string): void {
    if (!this.tables) return;
    try { this.db.prepare('DELETE FROM fca_body_release_attempts WHERE action_id=?').run(actionId); } catch { /* the next pass tries again */ }
  }

  /** Lost steps whose counts are on record: those of steps no longer lost are dropped by the caller. */
  releaseAttemptActionIds(): string[] {
    if (!this.tables) return [];
    try { return this.db.prepare('SELECT action_id FROM fca_body_release_attempts').all().map(row => String(row.action_id)); } catch { return []; }
  }

  /** The recovery notices a paused task still owes its model (`OwedNotice`), as its checkpoint holds them. */
  owedNotices(taskId: string): OwedNotice[] {
    const row = this.checkpoint(taskId);
    return row ? owedOf(row.checkpointJson) : [];
  }

  /** The non-terminal tasks of the scope that owe a notice. */
  owingTaskIds(scopeKey: string): string[] {
    return this.db.prepare(`SELECT t.task_id FROM agent_tasks t JOIN fca_task_checkpoints c ON c.task_id=t.task_id
      WHERE t.scope_key=? AND t.status NOT IN ('completed','failed','cancelled')
      AND CASE WHEN json_valid(c.checkpoint_json) THEN json_array_length(c.checkpoint_json,'$.${OWED_KEY}') ELSE 0 END > 0`).all(scopeKey)
      .map(row => String(row.task_id));
  }

  /** Adds notices to what the task owes (one per action), or removes one by action id. The caller holds the authority transaction. */
  changeOwed(taskId: string, change: { add?: readonly OwedNotice[]; remove?: string }): void {
    const row = this.checkpoint(taskId);
    if (!row) return;
    const prior = row.checkpointJson ? JSON.parse(row.checkpointJson) as Record<string, unknown> : {};
    let owed = owedOf(row.checkpointJson);
    for (const notice of change.add ?? []) if (!owed.some(item => item.actionId === notice.actionId)) owed = [...owed, notice];
    if (change.remove !== undefined) owed = owed.filter(item => item.actionId !== change.remove);
    const { [OWED_KEY]: _old, ...rest } = prior;
    const next = owed.length ? { ...rest, [OWED_KEY]: owed.slice(-4) } : rest;
    this.db.prepare('UPDATE fca_task_checkpoints SET checkpoint_json=? WHERE task_id=?').run(JSON.stringify(next), taskId);
  }

  checkpoint(taskId: string): RecoveryCheckpoint | undefined {
    const row = this.db.prepare('SELECT step_id,checkpoint_json,stop_requested,lease_json FROM fca_task_checkpoints WHERE task_id=?').get(taskId);
    if (!row) return undefined;
    return { stepId: typeof row.step_id === 'string' ? row.step_id : null,
      checkpointJson: typeof row.checkpoint_json === 'string' ? row.checkpoint_json : null, stopRequested: Number(row.stop_requested) !== 0,
      leaseId: leaseIdOf(row.lease_json) };
  }

  /** When the task's newest event of this type happened, or null: the owner's resume (`fca_resumed`) starts the window of L-3. */
  lastEventAt(taskId: string, eventType: string): string | null {
    const row = this.db.prepare('SELECT MAX(occurred_at) AS at FROM agent_task_events WHERE task_id=? AND event_type=?').get(taskId, eventType);
    return typeof row?.at === 'string' ? row.at : null;
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

/**
 * A notice about a lost step that a paused task still owes its model: the step was let go of (its body released, its action closed, or it
 * was closed by someone else) while the task waited for the owner, so the notice is sent when the owner resumes it, with the gap as it is
 * then (L-5). `lease` is null when only the checkpoint still named the step.
 */
export interface OwedNotice {
  actionId: string; lease: { id: string; generation: number; holder: string } | null; startedAt: string | null; lostAt: string | null;
}
const OWED_KEY = 'fcaOwedNotices';

function owedOf(json: string | null): OwedNotice[] {
  if (!json) return [];
  try {
    const kept = (JSON.parse(json) as Record<string, unknown>)[OWED_KEY];
    const owed = (item: unknown): item is OwedNotice => !!item && typeof item === 'object' && typeof (item as OwedNotice).actionId === 'string';
    return Array.isArray(kept) ? kept.filter(owed) : [];
  } catch {
    return [];
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
