import type { DatabaseSync } from 'node:sqlite';

/**
 * Whether an Agent Host task is settled, so that its Host lock may be released although its action stayed unknown
 * (Syzygy ADR-0009 §9): the task completed, failed or was cancelled, or the owner paused it; a failure the unknown exit closed
 * (S5, `outcome_unknown_closed`) is not a proof. Read-only.
 */
export function agentTaskSettled(db: DatabaseSync, taskId: string): boolean {
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'").get();
  if (!table) return false;
  const row = db.prepare('SELECT * FROM agent_tasks WHERE task_id = ?').get(taskId);
  if (!row) return false;
  // A task the unknown exit closed (failed, its unknown time kept) is not settled: only the Host's report or the owner proves it.
  if (row.status === 'failed' && typeof row.unknown_since === 'string') return false;
  if (['completed', 'failed', 'cancelled'].includes(String(row.status))) return true;
  return row.status === 'paused' && row.pause_reason === 'owner';
}
