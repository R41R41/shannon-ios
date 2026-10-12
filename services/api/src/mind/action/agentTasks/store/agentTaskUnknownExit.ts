import type { DatabaseSync } from 'node:sqlite';
import type { AgentEventTone } from '../agentTaskStore.js';
import { writeTaskState } from './taskStore.js';

/** The summary of an Agent Host task closed with its outcome unknown: the app shows it as failed with this note. */
export const UNKNOWN_CLOSED_SUMMARY = '作業の結果を確かめられないまま閉じた。';

/** The Agent Host tasks whose action closed with an unknown outcome, with the time it closed (read by the action threads). */
export type ClosedUnknownHostTasks = (db: DatabaseSync) => ReadonlyArray<{ readonly taskId: string; readonly closedAt: string }>;

type AppendEvent = (taskId: string, type: string, title: string, detail: string | undefined, tone: AgentEventTone, at: string,
  payload: Record<string, unknown>) => void;

/**
 * The one unknown exit of an Agent Host task (Syzygy ADR-0009 stage 1, S5), inside the store's transaction: when its action
 * closed as `outcome_unknown_closed`, the task fails with that outcome (the time its action closed kept as `unknown_since`, the
 * mark of a result never confirmed), what would begin another turn is withdrawn (a stop still reaches the Host), and nothing is
 * sent again. Its Host lock stays retained by the action until the Host's own report or the owner's release (`agentTaskSettled`
 * does not count this failure as settled). Returns how many tasks closed.
 */
export function closeUnknownHostTasks(db: DatabaseSync, now: string, closedUnknown: ClosedUnknownHostTasks, appendEvent: AppendEvent): number {
  let closed = 0;
  for (const { taskId, closedAt } of closedUnknown(db)) {
    const row = db.prepare('SELECT fca_kind FROM agent_tasks WHERE task_id = ?').get(taskId) as { fca_kind?: string | null } | undefined;
    if (!row || row.fca_kind != null) continue;
    writeTaskState(db, taskId, { status: 'failed', pauseReason: null, currentAction: null, unknownSince: closedAt }, now);
    db.prepare('UPDATE agent_tasks SET summary = ?, current_action = NULL, pending_approval_json = NULL, updated_at = ? WHERE task_id = ?')
      .run(UNKNOWN_CLOSED_SUMMARY, now, taskId);
    db.prepare(`UPDATE agent_task_commands SET status = 'completed', completed_at = ?, last_error = 'WITHDRAWN'
      WHERE task_id = ? AND status = 'pending' AND command_type != 'interrupt'`).run(now, taskId);
    appendEvent(taskId, 'execution.outcome_unknown_closed', '結果を確かめられないまま閉じた', UNKNOWN_CLOSED_SUMMARY, 'warning', now, {});
    closed += 1;
  }
  return closed;
}
