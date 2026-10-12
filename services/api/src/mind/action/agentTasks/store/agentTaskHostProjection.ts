import { DatabaseSync } from 'node:sqlite';
import type { AgentPauseReason, AgentTaskStatus, HostAgentEvent } from '../agentTaskStore.js';
import { arrayValue, normalizeApproval, stringValue } from './agentTaskPersistenceSupport.js';
import { writeTaskState } from './taskStore.js';

/** A host pause that carries a next action is waiting for the owner; a bare pause is the owner's own. */
export function pauseReasonForHostEvent(payload: Record<string, unknown>): AgentPauseReason {
  if (payload.pauseReason === 'owner' || payload.pauseReason === 'needs_owner') return payload.pauseReason;
  return stringValue(payload.currentAction) ? 'needs_owner' : 'owner';
}

/** A task the unknown exit closed (ADR-0009 stage 1, S5): failed, with the time its outcome became unknown kept. */
export function closedWithUnknownOutcome(row: { status: string; unknown_since?: unknown }): boolean {
  return row.status === 'failed' && typeof row.unknown_since === 'string';
}

/** A finished task takes no Host event but a command receipt, unless the unknown exit closed it (a late report). */
export function hostEventIgnored(row: { status: string; unknown_since?: unknown }, event: HostAgentEvent): boolean {
  if (!['completed', 'failed', 'cancelled'].includes(row.status) || event.type === 'command_completed') return false;
  return !closedWithUnknownOutcome(row);
}

/**
 * Projects one event of a batch: a move the state machine refuses (`TASK_TRANSITION_REFUSED`, counted there) leaves that row's
 * state as it was, and the caller still records the event, so one row never rolls back the batch the Host would resend forever.
 */
export function projectHostEventInBatch(database: DatabaseSync, event: HostAgentEvent, now: string, lateReport: boolean): void {
  database.exec('SAVEPOINT shannon_host_event');
  try {
    projectHostEvent(database, event, now, lateReport);
    database.exec('RELEASE shannon_host_event');
  } catch (error) {
    database.exec('ROLLBACK TO shannon_host_event; RELEASE shannon_host_event');
    if (!(error instanceof Error) || error.message !== 'TASK_TRANSITION_REFUSED') throw error;
  }
}

/**
 * Projects one host event onto the durable task row. The caller appends the event itself afterwards. A late report to a task
 * closed with its outcome unknown (`lateReport`, coordinator decision of 2026-10-13) keeps its evidence, and the truth wins: a
 * completion completes the task, a pause pauses it again for the owner; any other report changes no state.
 */
export function projectHostEvent(database: DatabaseSync, event: HostAgentEvent, now: string, lateReport = false): void {
  const payload = event.payload ?? {};
  const clearPendingApproval = (): void => {
    database.prepare('UPDATE agent_tasks SET pending_approval_json = NULL WHERE task_id = ?').run(event.taskId);
  };
  const update = (status: AgentTaskStatus, summary: string, currentAction?: string): void => {
    const at = event.occurredAt || now;
    // The state machine writes the status with its pause reason (ADR-0009 stage 1, S4); the Host's words follow.
    const pauseReason = status === 'paused' ? pauseReasonForHostEvent(payload) : null;
    writeTaskState(database, event.taskId, { status, pauseReason, currentAction: currentAction ?? null, lateReport }, at);
    database.prepare(`
      UPDATE agent_tasks SET summary = ?, current_action = ?, pause_sequence = NULL, updated_at = ? WHERE task_id = ?
    `).run(summary, currentAction ?? null, at, event.taskId);
  };
  // Stopped and failed work keeps the evidence the owner needs most: what changed and which check failed.
  const keepEvidence = (): void => {
    if (Array.isArray(payload.changes)) {
      database.prepare('UPDATE agent_tasks SET changes_json = ? WHERE task_id = ?')
        .run(JSON.stringify(payload.changes), event.taskId);
    }
    if (Array.isArray(payload.tests)) {
      database.prepare('UPDATE agent_tasks SET tests_json = ? WHERE task_id = ?')
        .run(JSON.stringify(payload.tests), event.taskId);
    }
  };
  if (lateReport && event.type !== 'completed' && event.type !== 'paused') {
    keepEvidence();
    return;
  }
  switch (event.type) {
    case 'started':
      update('running', event.detail ?? '作業を始めた。', stringValue(payload.currentAction));
      clearPendingApproval();
      break;
    case 'progress':
      update('running', event.detail ?? event.title, stringValue(payload.currentAction));
      if (Array.isArray(payload.plan)) database.prepare('UPDATE agent_tasks SET plan_json = ? WHERE task_id = ?')
        .run(JSON.stringify(payload.plan), event.taskId);
      break;
    case 'output':
      break;
    case 'approval_requested': {
      const approval = normalizeApproval(payload.approval, event.occurredAt);
      update('waiting_approval', event.detail ?? '許可を待っています。', approval.title);
      database.prepare('UPDATE agent_tasks SET pending_approval_json = ? WHERE task_id = ?')
        .run(JSON.stringify(approval), event.taskId);
      break;
    }
    case 'paused': {
      update('paused', event.detail ?? '作業を一時停止した。', stringValue(payload.currentAction));
      // The sequence of this pause lets a client tell a new pause from one the owner already saw.
      database.prepare('UPDATE agent_tasks SET pause_sequence = latest_sequence + 1 WHERE task_id = ?').run(event.taskId);
      clearPendingApproval();
      keepEvidence();
      break;
    }
    case 'completed':
      update('completed', event.detail ?? '作業が完了した。');
      database.prepare(`
        UPDATE agent_tasks SET changes_json = ?, tests_json = ?, pending_approval_json = NULL WHERE task_id = ?
      `).run(JSON.stringify(arrayValue(payload.changes)), JSON.stringify(arrayValue(payload.tests)), event.taskId);
      break;
    case 'failed':
      update('failed', event.detail ?? '作業を完了できなかった。');
      clearPendingApproval();
      keepEvidence();
      break;
    case 'command_completed':
      break;
  }
}
