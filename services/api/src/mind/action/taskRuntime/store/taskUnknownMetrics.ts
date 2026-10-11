import type { DatabaseSync } from 'node:sqlite';

/**
 * FCA tasks paused as `fca_unknown` since the cutoff or earlier (Syzygy ADR-0009 stage 1, acceptance §4: should be 0). The
 * moment a task became unknown is its latest `fca_recovery_unknown` event, else its last update. Read-only.
 */
export function countTasksUnknownSince(db: DatabaseSync, cutoff: string): number {
  const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('agent_tasks', 'agent_task_events')").get();
  if (Number(tables?.count ?? 0) < 2) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM agent_tasks t
    WHERE t.status = 'paused' AND t.pause_reason = 'fca_unknown'
      AND COALESCE((SELECT MAX(e.occurred_at) FROM agent_task_events e
        WHERE e.task_id = t.task_id AND e.event_type = 'fca_recovery_unknown'), t.updated_at) <= ?`).get(cutoff);
  return Number(row?.count ?? 0);
}
