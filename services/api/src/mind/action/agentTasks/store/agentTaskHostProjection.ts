import { DatabaseSync } from 'node:sqlite';
import type { AgentPauseReason, AgentTaskStatus, HostAgentEvent } from '../agentTaskStore.js';
import { arrayValue, normalizeApproval, stringValue } from './agentTaskPersistenceSupport.js';

/** A host pause that carries a next action is waiting for the owner; a bare pause is the owner's own. */
export function pauseReasonForHostEvent(payload: Record<string, unknown>): AgentPauseReason {
  if (payload.pauseReason === 'owner' || payload.pauseReason === 'needs_owner') return payload.pauseReason;
  return stringValue(payload.currentAction) ? 'needs_owner' : 'owner';
}

/** Projects one host event onto the durable task row. The caller appends the event itself afterwards. */
export function projectHostEvent(database: DatabaseSync, event: HostAgentEvent, now: string): void {
  const payload = event.payload ?? {};
  const clearPendingApproval = (): void => {
    database.prepare('UPDATE agent_tasks SET pending_approval_json = NULL WHERE task_id = ?').run(event.taskId);
  };
  const update = (status: AgentTaskStatus, summary: string, currentAction?: string): void => {
    database.prepare(`
      UPDATE agent_tasks
      SET status = ?, summary = ?, current_action = ?, pause_reason = NULL, pause_sequence = NULL, updated_at = ?
      WHERE task_id = ?
    `).run(status, summary, currentAction ?? null, event.occurredAt || now, event.taskId);
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
      database.prepare(`
        UPDATE agent_tasks SET pause_reason = ?, pause_sequence = latest_sequence + 1 WHERE task_id = ?
      `).run(pauseReasonForHostEvent(payload), event.taskId);
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
