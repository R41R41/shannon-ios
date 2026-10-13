import type { DatabaseSync } from 'node:sqlite';
import type { AgentCommandType, AgentEventTone, AgentTask, ClaimedAgentCommand } from '../agentTaskStore.js';
import { isTrue, projectedStatusForCommand } from './agentTaskPersistenceSupport.js';
import { hostTaskPredicate } from './taskKinds.js';
import { writeTaskState } from './taskStore.js';

/**
 * One task at a time on a host.
 *
 * A host runs every task in the same project checkout, so a second task that began while another was
 * working would edit the same files. A task holds its host while it is `starting`, `running`, or
 * `waiting_approval`. A `paused` task does not: it may wait for the owner for days, and the line behind
 * it must keep moving. Waking a paused task (resume, or an instruction sent to it) therefore takes its
 * turn like a new task. Tasks wait as `queued` and begin in the order their command was accepted.
 */

/** A task that holds its host. */
const WORKING = `('starting','running','waiting_approval')`;
/** A task that is working or in line before a newly accepted command. */
const AHEAD = `('queued','starting','running','waiting_approval')`;
/** The host has been silent this long before a waiting task says so. */
const OFFLINE_NOTICE_MS = 5 * 60_000;
const WAITING_ACTION = '順番待ち';
const OFFLINE_ACTION = 'オフライン待ち';

type Projection = ReturnType<typeof projectedStatusForCommand>;
type AppendEvent = (
  taskId: string, type: string, title: string, detail: string | undefined,
  tone: AgentEventTone, occurredAt: string, payload: Record<string, unknown>,
) => void;

export interface QueueAdmission {
  projection: Projection;
  /** The host has nothing to do for this command: the task never reached it. */
  settledByStore: boolean;
}

export class AgentTaskQueue {
  constructor(private readonly database: DatabaseSync, private readonly appendEvent: AppendEvent) {}

  /** Says so on a new task that has to wait behind another task of its host. */
  markWaiting(taskId: string, hostId: string | undefined, now: string): void {
    if (!hostId || !this.someoneAhead(hostId, taskId)) return;
    this.database.prepare(`
      UPDATE agent_tasks SET summary = ?, current_action = ?, updated_at = ? WHERE task_id = ?
    `).run(waitingSummary(this.place(hostId)), WAITING_ACTION, now, taskId);
  }

  /** Decides what a command does to a task, given the line on its host. */
  admit(task: AgentTask, type: AgentCommandType, payload: Record<string, unknown>): QueueAdmission {
    const unstarted = this.unstarted(task.id);
    // An instruction has no session to go to before the host began the task.
    if (unstarted && type === 'steer') throw new Error('AGENT_COMMAND_INVALID_STATE');
    const projection = projectedStatusForCommand(task.status, type, payload, task.pendingApproval);
    const beginsTurn = type === 'resume' || (type === 'steer' && task.status === 'paused');
    if (!beginsTurn) return { projection, settledByStore: unstarted && type === 'interrupt' };
    const waiting = task.assignedHostID ? this.someoneAhead(task.assignedHostID, task.id) : false;
    const inLine: Projection = {
      status: 'queued',
      summary: waiting ? waitingSummary(this.place(task.assignedHostID)) : '開始を待っています。',
      currentAction: waiting ? WAITING_ACTION : '',
    };
    // Resuming a task the host never began puts its `start` back in line.
    if (unstarted) return { projection: inLine, settledByStore: true };
    return { projection: waiting ? inLine : projection, settledByStore: false };
  }

  /** After an interrupt, nothing that would begin a turn may still reach the host. */
  withdrawTurns(taskId: string, payload: Record<string, unknown>, now: string): void {
    // A pause keeps the undelivered `start`, so a later resume can put the task back in line.
    const types = isTrue(payload.cancel) ? `('start','resume','steer')` : `('resume','steer')`;
    this.database.prepare(`
      UPDATE agent_task_commands SET status = 'completed', completed_at = ?, last_error = 'WITHDRAWN'
      WHERE task_id = ? AND status = 'pending' AND attempts = 0 AND command_type IN ${types}
    `).run(now, taskId);
  }

  settle(commandId: string, now: string): void {
    this.database.prepare(`
      UPDATE agent_task_commands SET status = 'completed', completed_at = ? WHERE command_id = ?
    `).run(now, commandId);
  }

  /** The next command this host may take, oldest first. */
  nextCommand(hostId: string, now: string): string | null {
    this.noteHostsOffline(now);
    this.noteHostBack(hostId, now);
    const row = this.database.prepare(`
      SELECT c.command_id
      FROM agent_task_commands c
      JOIN agent_tasks t ON t.task_id = c.task_id
      WHERE c.status = 'pending' AND c.available_at <= ? AND ${hostTaskPredicate(this.database, 't')}
        AND (
          t.assigned_host_id = ?
          OR (
            c.command_type = 'start' AND t.assigned_host_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM agent_tasks active
              WHERE active.assigned_host_id = ? AND ${hostTaskPredicate(this.database, 'active')}
                AND active.status IN ('queued','starting','running','waiting_approval','paused')
            )
          )
        )
        AND (
          -- A command the host already took once is delivered again after its lease ran out.
          c.attempts > 0
          -- Anything for a task that is past the line goes straight through. An undelivered start
          -- of a task that is no longer queued (paused or stopped before it began) stays back.
          OR (t.status != 'queued' AND c.command_type != 'start')
          -- A queued task begins only when no other task holds the host.
          OR (t.status = 'queued' AND NOT EXISTS (
            SELECT 1 FROM agent_tasks holder
            WHERE holder.assigned_host_id = ? AND holder.task_id != t.task_id AND ${hostTaskPredicate(this.database, 'holder')} AND (
              holder.status IN ${WORKING}
              -- A task the owner just stopped is still running on the host until that command is applied.
              OR EXISTS (
                SELECT 1 FROM agent_task_commands stop
                WHERE stop.task_id = holder.task_id AND stop.command_type IN ('interrupt','resolve_approval')
                  AND stop.status IN ('pending','leased')
              )
            )
          ))
        )
      ORDER BY c.sequence ASC LIMIT 1
    `).get(now, hostId, hostId, hostId) as unknown as { command_id: string } | undefined;
    return row?.command_id ?? null;
  }

  /** The host took a command: a queued task leaves the line. */
  begin(command: ClaimedAgentCommand, hostId: string, now: string): void {
    const text = command.type === 'start'
      ? { summary: '作業を始める準備中。', currentAction: '作業環境へ接続中' }
      : projectedStatusForCommand('queued', command.type, command.payload);
    const queued = this.database.prepare("SELECT 1 AS found FROM agent_tasks WHERE task_id = ? AND status = 'queued'").get(command.taskId);
    if (queued) {
      // The state machine writes the status (ADR-0009 stage 1, S4); the Host's words and binding follow.
      writeTaskState(this.database, command.taskId, { status: 'starting', pauseReason: null, currentAction: text.currentAction ?? null }, now);
      this.database.prepare(`
        UPDATE agent_tasks SET summary = ?, current_action = ?, assigned_host_id = ?, updated_at = ? WHERE task_id = ?
      `).run(text.summary ?? '', text.currentAction ?? null, hostId, now, command.taskId);
    }
    if (command.type === 'start' || queued) {
      this.appendEvent(command.taskId, 'starting', '作業環境が依頼を受け取った', undefined, 'progress', now, { hostId });
    }
  }

  private unstarted(taskId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM agent_task_commands
      WHERE task_id = ? AND command_type = 'start' AND status = 'pending' AND attempts = 0
    `).get(taskId));
  }

  private someoneAhead(hostId: string, taskId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM agent_tasks
      WHERE assigned_host_id = ? AND task_id != ? AND ${hostTaskPredicate(this.database)} AND status IN ${AHEAD} LIMIT 1
    `).get(hostId, taskId));
  }

  private place(hostId: string | undefined): string {
    const row = hostId ? this.database.prepare('SELECT host_kind FROM agent_hosts WHERE host_id = ?')
      .get(hostId) as unknown as { host_kind: string } | undefined : undefined;
    return placeName(row?.host_kind);
  }

  /** A queued task is never moved to another host; it says that its host is away instead. */
  private noteHostsOffline(now: string): void {
    const nowMillis = Date.parse(now);
    if (!Number.isFinite(nowMillis)) return;
    const rows = this.database.prepare(`
      SELECT t.task_id, t.summary, h.host_kind FROM agent_tasks t
      JOIN agent_hosts h ON h.host_id = t.assigned_host_id
      WHERE t.status = 'queued' AND ${hostTaskPredicate(this.database, 't')} AND h.last_seen_at <= ?
    `).all(new Date(nowMillis - OFFLINE_NOTICE_MS).toISOString()) as unknown as QueuedRow[];
    for (const row of rows) {
      const place = placeName(row.host_kind);
      if (row.summary === offlineSummary(place)) continue;
      this.say(row.task_id, offlineSummary(place), OFFLINE_ACTION, now);
      this.appendEvent(row.task_id, 'queue.host_offline', `${place}がオフライン`, offlineSummary(place), 'warning', now, {});
    }
  }

  private noteHostBack(hostId: string, now: string): void {
    const rows = this.database.prepare(`
      SELECT t.task_id, t.summary, h.host_kind FROM agent_tasks t
      JOIN agent_hosts h ON h.host_id = t.assigned_host_id
      WHERE t.status = 'queued' AND ${hostTaskPredicate(this.database, 't')} AND t.assigned_host_id = ? AND t.current_action = ?
    `).all(hostId, OFFLINE_ACTION) as unknown as QueuedRow[];
    for (const row of rows) {
      const place = placeName(row.host_kind);
      if (row.summary !== offlineSummary(place)) continue;
      this.say(row.task_id, waitingSummary(place), WAITING_ACTION, now);
      this.appendEvent(row.task_id, 'queue.host_online', `${place}がオンラインに戻った`, undefined, 'neutral', now, {});
    }
  }

  private say(taskId: string, summary: string, currentAction: string, now: string): void {
    this.database.prepare(`
      UPDATE agent_tasks SET summary = ?, current_action = ?, updated_at = ? WHERE task_id = ?
    `).run(summary, currentAction, now, taskId);
  }
}

interface QueuedRow { task_id: string; summary: string; host_kind: string; }

function placeName(kind: string | undefined): string {
  return kind === 'local' ? 'Mac' : kind === 'cloud' ? 'クラウド' : '作業環境';
}

export function waitingSummary(place = 'Mac'): string {
  return `${place}で前の作業が終わるのを待っています。`;
}

export function offlineSummary(place = 'Mac'): string {
  return `${place}がオフラインのため、戻るのを待っています。`;
}
