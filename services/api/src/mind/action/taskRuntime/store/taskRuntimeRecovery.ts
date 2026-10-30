import type { DatabaseSync } from 'node:sqlite';
import { deriveTaskKind, effectClassOf, unknownDue, unknownExit, type ActionLease } from '@shannon/mind';
import type { TaskAuthority, TaskRecord, TaskSegmentReceipt, TaskSnapshot, TaskStep, TaskView } from '../taskRuntimePorts.js';
import type { TaskMaintenanceStore } from './taskMaintenanceStore.js';

interface CheckpointRow { step_id: string | null; lease_json: string | null; stop_requested: number }
/** The canonical store's own internals, handed over as functions; every call runs inside its authority transaction. */
export interface TaskRecoveryParts {
  authority: TaskAuthority; maintenance: TaskMaintenanceStore; now(): string;
  checkpoint(id: string): CheckpointRow; required(scope: string, id: string): TaskRecord; all(scope: string): TaskRecord[];
  view(task: TaskRecord): TaskView; get(scope: string, id: string): TaskView | null; finishStops(task: TaskRecord): void;
  pendingReceipts(scope: string): TaskSegmentReceipt[]; activeSteps(scope: string): Array<{ taskId: string; lease: ActionLease }>;
  snapshot(scope: string, id: string): TaskSnapshot; failConversation(step: TaskStep): void;
  send(scope: string, source: string, target: string, text: string, id: string): unknown;
  /** Whether a child's end is sent to its parent (TaskRuntimeStoreOptions.reportsToParent); absent: always. */
  reportsToParent?(task: TaskRecord): boolean;
  /**
   * After a lost step of a task that runs on its inbox (the internal root): the messages it saw are delivered once more, or
   * consumed by it when it may have acted on them or they already were, and the task wakes if anything is pending
   * (`taskInboxRedelivery.ts`).
   */
  redeliver?(task: TaskRecord, stepId: string, reason: string): void;
  /** A task back to waiting on messages runs again when a delivered message is already pending. */
  wake?(task: TaskRecord, reason: string): void;
  /** The owner-visible report that a task could not finish (`TaskProgressStore.notice`). */
  notice?(scope: string, taskId: string, stepId: string | null, operationId: string, text: string): void;
  /** An unknown task that is not retired yet, though its exit has come (`TaskRuntimeOptions.holdUnknown`). */
  hold?(task: TaskRecord): boolean;
}
const terminal = (task: TaskRecord) => ['completed', 'failed', 'cancelled'].includes(task.status);

/**
 * Recovery of steps whose action outcome was lost. An unknown step is never replayed: at the one unknown exit (`unknownExit`,
 * ADR-0009 stage 1 S5: `UNKNOWN_EXIT_MS` after the task became unknown, as parsed instants) or, for the internal root and a
 * conversation, on the owner's next turn, only the task's own bookkeeping moves on.
 *
 * - root and conversation tasks are the suite's always-on inboxes: their unknown step is closed and they wait for their next
 *   message. The root never waits on a message already delivered (fix 2026-10-14, a lost wakeup): a message the lost step saw
 *   is delivered once more, exactly once, when that step never got past its decision request; a message the lost step may have
 *   acted on (its decision answered, a tool or child started, a message sent) is consumed by it and not run again, since that
 *   would replay it;
 * - every other task becomes `failed` (`unknown_retired`, its parent hears of it, as after a committed failure), so a parent's
 *   stop can finish and the active-task limit is not held forever. An FCA task only calls models (`effect_class` none); one
 *   that sent the Minecraft body a command may have acted outside and closes as `outcome_unknown_closed` (run 6, 2026-10-14).
 */
export class TaskRuntimeRecovery {
  constructor(private readonly db: DatabaseSync, private readonly parts: TaskRecoveryParts) {}

  recover(scopeKey: string, actionState: (lease: ActionLease) => 'live' | 'safe' | 'unknown'): TaskView[] {
    const parts = this.parts, authority = parts.authority;
    const changed: TaskView[] = [];
    const receipted = new Set(parts.pendingReceipts(scopeKey).map(receipt => receipt.taskId));
    for (const { taskId, lease } of parts.activeSteps(scopeKey)) {
      if (receipted.has(taskId)) continue; // The original durable receipt owns reconciliation, even during IPC failure.
      const outcome = actionState(lease);
        if (outcome === 'live') continue;
      const task = parts.required(scopeKey, taskId), row = parts.checkpoint(taskId);
      if (outcome === 'unknown') {
        if (task.pauseReason !== 'fca_unknown') authority.event(scopeKey, taskId, 'fca_recovery_unknown', parts.now(),
          { status: 'paused', pauseReason: 'fca_unknown' }, { actionId: lease.id, generation: lease.generation });
      } else if (task.kind === 'conversation') {
        const snapshot = parts.snapshot(scopeKey, taskId);
        parts.failConversation({ id: row.step_id!, scopeKey, taskId, lease, revision: snapshot.revision, messageIds: [], snapshot });
      } else {
        this.db.prepare('UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL WHERE task_id=?').run(taskId);
        // The lease says the lost attempt sent nothing: a proof, so a task already marked unknown may run again (S4).
        authority.event(scopeKey, taskId, 'fca_recovered_safe', parts.now(),
          { status: row.stop_requested ? 'paused' : 'queued', pauseReason: row.stop_requested ? 'fca_stopped' : null, proof: true }, { actionId: lease.id });
        if (row.stop_requested) parts.finishStops(parts.required(scopeKey, taskId));
      }
      changed.push(parts.get(scopeKey, taskId)!);
    }
    return changed;
  }

  /**
   * Whether the task sent the Minecraft body a command: it may have acted outside, whatever its kind, and closes as such
   * (Minecraft run 6, 2026-10-14: a body-moving task was retired as a model-only one, `unknown_retired`).
   */
  private actedOnBody(taskId: string): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_body_operations'").get()) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM fca_body_operations WHERE task_id=? LIMIT 1').get(taskId));
  }

  /** When the task entered `fca_unknown` (its latest recovery event), or null when it is not unknown. */
  unknownSince(scopeKey: string, taskId: string): string | null {
    const task = this.parts.authority.get(scopeKey, taskId);
    if (!task || task.pauseReason !== 'fca_unknown') return null;
    const row = this.db.prepare("SELECT MAX(occurred_at) AS at FROM agent_task_events WHERE task_id=? AND event_type='fca_recovery_unknown'").get(taskId);
    return typeof row?.at === 'string' ? row.at : task.updatedAt;
  }

  /** Every task (without a pending receipt) whose unknown reached its exit at `at` leaves `fca_unknown`. */
  retireUnknown(scopeKey: string, at: string): TaskView[] {
    const receipted = new Set(this.parts.pendingReceipts(scopeKey).map(receipt => receipt.taskId));
    const retired: TaskView[] = [];
    for (const task of this.parts.all(scopeKey)) {
      if (task.pauseReason !== 'fca_unknown' || terminal(task) || receipted.has(task.id)) continue;
      const kind = deriveTaskKind(task.kind);
      if (!unknownDue(this.unknownSince(scopeKey, task.id), at, kind) || this.parts.hold?.(task)) continue;
      this.retire(task, unknownExit(this.actedOnBody(task.id) ? 'external' : kind ? effectClassOf(kind) : 'none', kind).code);
      retired.push(this.parts.get(scopeKey, task.id)!);
    }
    return retired;
  }

  /**
   * The owner's new turn (or a due nightly sleep for the root) is the explicit signal that her internal inboxes run again:
   * a stopped root or conversation resumes, and an unknown step of either is closed without being replayed.
   */
  revive(task: TaskRecord, reason: 'owner_turn' | 'sleep_admission'): void {
    if (task.kind !== 'root' && task.kind !== 'conversation') return;
    const phase = this.parts.view(task).phase;
    if (phase === 'unknown') { this.retire(task, `fca_unknown_${reason}`);
      return; }
    if (phase !== 'stopped' && !(phase === 'stopping' && task.kind === 'root')) return;
    // A stopping root only waits for its children; they keep their own stop requests.
    this.db.prepare(("UPDATE fca_task_checkpoints SET stop_requested=0,wait_reason=CASE WHEN step_id IS NULL THEN 'message' " +
"ELSE wait_reason END WHERE task_id=?")).run(task.id);
    this.parts.authority.event(task.scopeKey, task.id, 'fca_resumed', this.parts.now(), { status: 'running', pauseReason: null }, { reason });
    // Messages that arrived while it was stopped did not wake it: they do now.
    this.parts.wake?.(this.parts.required(task.scopeKey, task.id), reason);
  }

  /**
   * A-17 (run 46: a request held by the operator was failed by the unknown exit 3 minutes after its hold, with the
 * world still frozen): a task the exit failed
   * (its last two status events are `fca_unknown_retired` and `fca_recovered_unknown`, the failed state still
 * carrying its unknown time) goes back to stopped, resumable,
   * by the state machine's own late-report exit. Its checkpoint was cleared by the retirement (no step, no stop
 * request), so nothing is left open. Any other failed task: null.
   */
  reopenRetired(scopeKey: string, taskId: string, summary: string): TaskView | null {
    const task = this.parts.authority.get(scopeKey, taskId);
    if (!task || task.status !== 'failed') return null;
    const last = this.db.prepare(("SELECT event_type FROM agent_task_events WHERE task_id=? AND event_type IN " +
"('fca_unknown_retired','fca_recovered_unknown','fca_retire_reopened') ORDER BY sequence DESC LIMIT 2")).all(taskId)
      .map(row => String(row.event_type));
    if (last[0] !== 'fca_recovered_unknown' || last[1] !== 'fca_unknown_retired') return null;
    this.parts.authority.event(scopeKey, taskId, 'fca_retire_reopened', this.parts.now(), { status: 'paused', pauseReason: 'fca_stopped',
       proof: true, lateReport: true, summary }, { reason: 'held' });
    return this.parts.get(scopeKey, taskId);
  }

  /**
   * A-20 (run 47: the credit ran out and a running request was failed with the world running): a task the step's
 * own `fail` commit closed, with the summary such a failure writes
   * (`failedSummary`), goes back to stopped, resumable, by the state machine's `reopen`. Its checkpoint was
 * cleared by the commit (no step, no stop request). The failure's code is
   * not kept; the operator, who names the task, knows why it failed. Any other failed task (a retirement, a cap, a
 * completion): null.
   */
  reopenRejected(scopeKey: string, taskId: string, summary: string, failedSummary: string): TaskView | null {
    const task = this.parts.authority.get(scopeKey, taskId);
    if (!task || task.status !== 'failed' || task.summary !== failedSummary) return null;
    const row = this.db.prepare(
      ("SELECT payload_json FROM agent_task_events WHERE task_id=? AND event_type='fca_step_committed' ORDER BY " +
"sequence DESC LIMIT 1")).get(taskId);
    let disposition: unknown;
    try { disposition = JSON.parse(String(row?.payload_json ?? '{}')).disposition; } catch { disposition = undefined; }
    if (disposition !== 'fail') return null;
    this.parts.authority.event(scopeKey, taskId, 'fca_rejected_reopened', this.parts.now(), { status: 'paused', pauseReason: 'fca_stopped',
       proof: true, reopen: true, summary }, { reason: 'billing' });
    return this.parts.get(scopeKey, taskId);
  }

  /** A retired task's parent hears of it, as after a committed failure, and so does the owner's activity (its report). */
  private tellRetired(task: TaskRecord, stepId: string | null, parent: TaskRecord | null): void {
    if (task.origin === 'maintenance') {
      this.parts.maintenance.report(task, 'failed', stepId ?? `retired-${task.id}`);
      return;
    }
    if (parent && !terminal(parent) && this.parts.reportsToParent?.(task) !== false) {
      this.parts.send(task.scopeKey, task.id, parent.id, `${task.title}: failed (result unknown)`, `result:retired:${task.id}`);
    }
    if (task.origin === 'owner_request') this.parts.notice?.(task.scopeKey, task.id, stepId, `retired:${task.id}`, retiredTaskReport(task.title));
  }

  private retire(task: TaskRecord, reason: string): void {
    const { authority, now } = this.parts;
    const row = this.parts.checkpoint(task.id);
    const lease = row.lease_json ? JSON.parse(row.lease_json) as ActionLease : null;
    authority.event(task.scopeKey, task.id, 'fca_unknown_retired', now(), {}, { reason, stepId: row.step_id, actionId: lease?.id ?? null });
    if (task.kind === 'conversation' && row.step_id && lease) {
      // Its sources fail closed: tasks that waited on this unconfirmed turn stop rather than run on it.
      const snapshot = this.parts.snapshot(task.scopeKey, task.id);
      this.parts.failConversation({ id: row.step_id, scopeKey: task.scopeKey, taskId: task.id, lease, revision: snapshot.revision, messageIds: [], snapshot });
      return;
    }
    if (task.kind === 'root' || task.kind === 'conversation') {
      this.db.prepare("UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason='message' WHERE task_id=?").run(task.id);
      authority.event(task.scopeKey, task.id, 'fca_recovered_unknown', now(), { status: 'running', pauseReason: null }, { reason });
      if (row.stop_requested) this.parts.finishStops(this.parts.required(task.scopeKey, task.id));
      else if (task.kind === 'root' && row.step_id) this.parts.redeliver?.(this.parts.required(task.scopeKey, task.id), row.step_id, reason);
      else if (task.kind === 'root') this.parts.wake?.(this.parts.required(task.scopeKey, task.id), reason);
      return;
    }
    this.db.prepare(("UPDATE fca_task_checkpoints SET step_id=NULL,lease_json=NULL,wait_reason=NULL,stop_requested=0 WHERE " +
"task_id=?")).run(task.id);
    authority.event(task.scopeKey, task.id, 'fca_recovered_unknown', now(), { status: 'failed', pauseReason: null }, { reason });
    const parent = task.parentId ? this.parts.required(task.scopeKey, task.parentId) : null;
    this.tellRetired(task, row.step_id, parent);
    if (parent) this.parts.finishStops(this.parts.required(task.scopeKey, parent.id));
  }
}

/** Owner 2026-10-19 (item 10): a failure says why, and what comes next. */
export function retiredTaskReport(title: string): string {
  return `「${title.slice(0, 80)}」は途中で止まって結果を確かめられず、最後まで進められませんでした。もう一度頼んでもらえたら、最初からやり直します。`;
}
