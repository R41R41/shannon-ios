import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskMessage, TaskRecord, TaskStep } from '../taskRuntimePorts.js';
import type { TaskSourceStore } from './taskSourceStore.js';

/**
 * Lost wakeups of a task's inbox (fix 2026-10-14). Production ab990c87: the internal root's step failed with a 400 and went
 * unknown; ten minutes later it was retired to waiting for its next message, while its inbox still held the result of a failed
 * child that had arrived just before the step. Only a new message woke a waiting task, so the root sat on it.
 *
 * The rule: a task that runs on its inbox never waits while a delivered message is pending. A message that a failed step saw
 * (never acknowledged: no committed step consumed it) is delivered once more, exactly once, and only when that step is known
 * not to have gone past its decision request; a message seen by a second failed step, or by a lost step that may have acted
 * on it, is consumed by that step and never run again (no replay, no spin on a message that keeps failing).
 */
export const INBOX_REDELIVERED = 'fca_inbox_redelivered';
export const INBOX_WOKEN = 'fca_inbox_woken';
/**
 * The sweep's candidates, run every tick inside the write lock: it starts from the scope's running tasks and asks the inbox index
 * (`fca_task_inbox`: target, consumed_by) whether one unconsumed message exists, so it never reads the message table itself,
 * which is never pruned (review of 6bb8d9ff: scanning it by scope took 528 ms a tick at 200k messages).
 */
export const WAITING_WITH_INBOX_SQL = `SELECT t.task_id AS id FROM agent_tasks t JOIN fca_task_checkpoints c ON c.task_id=t.task_id
  WHERE t.scope_key=? AND t.status='running' AND t.fca_kind NOT IN ('conversation','sleep') AND c.step_id IS NULL AND c.stop_requested=0
  AND EXISTS (SELECT 1 FROM fca_task_messages m WHERE m.target_task_id=c.task_id AND m.consumed_by IS NULL)`;
const terminal = (task: TaskRecord): boolean => ['completed', 'failed', 'cancelled'].includes(task.status);

/** The canonical store's own internals, handed over as functions; every call runs inside its authority transaction. */
export interface TaskInboxParts {
  authority: TaskAuthority; sources: TaskSourceStore; now(): string;
  /** Pending messages the task may see (visible, not reserved by a conversation delivery), oldest first. */
  messages(taskId: string): TaskMessage[];
  checkpoint(taskId: string): { step_id: string | null; stop_requested: number };
  required(scope: string, id: string): TaskRecord;
  /** The step still owns the task's checkpoint and its action lease is valid now. */
  stepValid(step: TaskStep): boolean;
}

export class TaskInbox {
  constructor(private readonly db: DatabaseSync, private readonly parts: TaskInboxParts) {}

  /**
   * A step of the internal root that the provider refused before anything ran (a deterministic 4xx, a history that cannot be
   * made to fit): a known failure of that step, not an unknown. Its segment is receipted as committed (the action closes as
   * after any commit), the root returns to its inbox at once, and the messages the step saw are delivered once more; a second
   * refusal consumes them.
   */
  closeRejected(step: TaskStep): boolean {
    const { authority, now } = this.parts;
    if (!this.parts.stepValid(step) || this.parts.checkpoint(step.taskId).stop_requested) return false;
    const task = this.parts.required(step.scopeKey, step.taskId);
    if (task.kind !== 'root' || task.status !== 'running') return false;
    this.db.prepare('INSERT INTO fca_task_segment_receipts(step_id,scope_key,task_id,lease_json,created_at) VALUES(?,?,?,?,?)')
      .run(step.id, step.scopeKey, step.taskId, JSON.stringify(step.lease), now());
    this.db.prepare("UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason='message' WHERE task_id=?").run(step.taskId);
    authority.event(step.scopeKey, step.taskId, 'fca_step_rejected', now(), { status: 'running', pauseReason: null },
      { stepId: step.id, actionId: step.lease.id, generation: step.lease.generation });
    this.settleFailed(this.parts.required(step.scopeKey, step.taskId), step.id, step.messageIds, false, 'step_rejected');
    return true;
  }

  /** After a lost (unknown) step of the root, at its exit: what it saw and whether it may have acted decide each message. */
  redeliverLost(task: TaskRecord, stepId: string, reason: string): void {
    const facts = lostStepFacts(this.db, task.id, stepId, this.parts.messages(task.id));
    this.settleFailed(task, stepId, facts.seen, facts.acted, reason);
  }

  /** The tick's sweep: the ids of tasks that waited for messages while a delivered one was pending, now ready. */
  wakePending(scope: string): string[] {
    const candidates = this.db.prepare(WAITING_WITH_INBOX_SQL).all(scope);
    return candidates.map(row => String(row.id)).filter(id => this.wake(scope, id, 'pending_on_wait'));
  }

  /**
   * A task waiting on messages (running, no step, no stop, no unbound origin) with a visible pending message becomes ready.
   * A nightly sleep's closed receipt never wakes a task by itself (`TaskMaintenanceStore.report`); it rides with the next run.
   */
  wake(scope: string, taskId: string, reason: string): boolean {
    const task = this.parts.authority.get(scope, taskId);
    if (!task || task.kind === 'conversation' || task.origin === 'maintenance' || task.status !== 'running' || task.pauseReason) return false;
    const row = this.parts.checkpoint(taskId);
    if (row.step_id || row.stop_requested || this.parts.sources.hasUnboundOrigin(taskId)) return false;
    const pending = this.parts.messages(taskId).filter(message => this.parts.authority.get(scope, message.sourceTaskId)?.origin !== 'maintenance')
      .map(message => message.id);
    if (!pending.length) return false;
    this.db.prepare('UPDATE fca_task_checkpoints SET wait_reason=NULL WHERE task_id=?').run(taskId);
    this.parts.authority.event(scope, taskId, INBOX_WOKEN, this.parts.now(), { status: 'queued' }, { reason, messageIds: pending });
    return true;
  }

  /** A conversation step's source was bound: the tasks that waited on it run again when they are queued or hold messages. */
  sourceBound(scope: string, stepId: string): void {
    const { sources } = this.parts;
    for (const id of sources.dependents(scope, stepId)) {
      const task = this.parts.required(scope, id), row = this.parts.checkpoint(id);
      const wake = task.kind !== 'conversation' && !terminal(task) && task.status !== 'paused' && !row.step_id && !row.stop_requested
        && !sources.hasUnboundOrigin(id) && (task.status === 'queued' || this.parts.messages(id).length > 0);
      if (wake) this.db.prepare('UPDATE fca_task_checkpoints SET wait_reason=NULL WHERE task_id=?').run(id);
      this.parts.authority.event(scope, id, 'fca_source_bound', this.parts.now(), wake ? { status: 'queued' } : {}, { sourceStepId: stepId });
    }
  }

  /**
   * After a failed step of a task that runs on its inbox: of the pending messages the step saw, one that was already delivered
   * once more, or that a lost step may have acted on, is consumed by that step (never run again); the others are delivered once
   * more. Then the task wakes if anything is pending.
   */
  private settleFailed(task: TaskRecord, stepId: string, seen: readonly string[], acted: boolean, reason: string): void {
    const touched = this.parts.messages(task.id).map(message => message.id).filter(id => seen.includes(id));
    const dropped = touched.filter(id => acted || redeliveredBefore(this.db, task.id, id));
    const consume = this.db.prepare(`UPDATE fca_task_messages SET consumed_by=?
      WHERE scope_key=? AND target_task_id=? AND message_id=? AND consumed_by IS NULL`);
    for (const id of dropped) consume.run(stepId, task.scopeKey, task.id, id);
    const redelivered = touched.filter(id => !dropped.includes(id));
    if (touched.length) this.parts.authority.event(task.scopeKey, task.id, INBOX_REDELIVERED, this.parts.now(), {},
      { stepId, reason, messageIds: redelivered, droppedMessageIds: dropped });
    this.wake(task.scopeKey, task.id, reason);
  }
}

/** The step's start: its event sequence, time and the messages its snapshot held (recorded since this fix). */
function stepStart(db: DatabaseSync, taskId: string, stepId: string): { sequence: number; at: string; messageIds: string[] | null } | null {
  const row = db.prepare(`SELECT sequence, occurred_at, payload_json FROM agent_task_events WHERE task_id=? AND event_type='fca_step_started'
    AND json_extract(payload_json,'$.stepId')=? ORDER BY sequence DESC LIMIT 1`).get(taskId, stepId);
  if (!row) return null;
  const ids = (JSON.parse(String(row.payload_json)) as { messageIds?: unknown }).messageIds;
  return { sequence: Number(row.sequence), at: String(row.occurred_at),
    messageIds: Array.isArray(ids) && ids.every(id => typeof id === 'string') ? ids as string[] : null };
}

/**
 * What a lost step of `taskId` saw of the pending messages (its recorded snapshot; before this fix, what was received by its
 * start), and whether it may have acted on them: its decision answered (`fca.decide` received), a tool or child started, or a
 * message sent from the task after it began. Without a record of its start, everything pending counts as seen and acted on.
 */
export function lostStepFacts(db: DatabaseSync, taskId: string, stepId: string, pending: ReadonlyArray<{ id: string; receivedAt: string }>):
  { seen: string[]; acted: boolean } {
  const start = stepStart(db, taskId, stepId);
  if (!start) return { seen: pending.map(message => message.id), acted: true };
  const seen = pending.filter(message => start.messageIds ? start.messageIds.includes(message.id) : message.receivedAt <= start.at).map(message => message.id);
  // `fca.decide` running, then unknown when the request threw (production: the 400): no decision came back, nothing ran.
  const progressed = db.prepare(`SELECT 1 FROM agent_task_events WHERE task_id=? AND event_type='fca_progress_observed'
    AND json_extract(payload_json,'$.stepId')=? AND (json_extract(payload_json,'$.tool')!='fca.decide'
    OR json_extract(payload_json,'$.status')='received') LIMIT 1`).get(taskId, stepId);
  const child = db.prepare(`SELECT 1 FROM agent_task_events WHERE task_id=? AND event_type='fca_child_created' AND sequence>? LIMIT 1`)
    .get(taskId, start.sequence);
  const sent = db.prepare('SELECT 1 FROM fca_task_messages WHERE source_task_id=? AND target_task_id!=? AND received_at>=? LIMIT 1')
    .get(taskId, taskId, start.at);
  return { seen, acted: Boolean(progressed || child || sent) };
}

/** Whether `messageId` was already delivered once more after a failed step of `taskId`. */
export function redeliveredBefore(db: DatabaseSync, taskId: string, messageId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM agent_task_events e, json_each(e.payload_json,'$.messageIds') j
    WHERE e.task_id=? AND e.event_type=? AND j.value=? LIMIT 1`).get(taskId, INBOX_REDELIVERED, messageId));
}
