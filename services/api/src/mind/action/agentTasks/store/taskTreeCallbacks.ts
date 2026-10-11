import type { DatabaseSync } from 'node:sqlite';
import type { TaskResultProof, TaskTreeLearningCallbacks, TaskDispatchExpectation } from '../taskTreePorts.js';
export interface TaskTreeLearningEvent {
  id: string; kind: 'dispatched' | 'verified' | 'unusable'; scopeKey: string;
  taskId: string; attemptId: string; at: string; proof?: TaskResultProof;
  actionId?: string;
  reason?: 'failed' | 'cancelled' | 'unknown';
  expectation?: TaskDispatchExpectation;
}
export function queueTaskTreeLearning(database: DatabaseSync, event: TaskTreeLearningEvent): void {
  database.prepare('INSERT OR IGNORE INTO agent_task_tree_learning(id,event_json) VALUES(?,?)').run(event.id, JSON.stringify(event));
}
/** Never call another connection's writer while holding the task store transaction. All destinations deduplicate original IDs. */
export function flushTaskTreeLearning(database: DatabaseSync, callbacks?: TaskTreeLearningCallbacks): void {
  if (!callbacks || database.isTransaction) return;
  const rows = database.prepare('SELECT id,event_json FROM agent_task_tree_learning WHERE delivered=0 ORDER BY rowid LIMIT 128').all() as { id: string; event_json: string }[];
  for (const row of rows) {
    const event = JSON.parse(row.event_json) as TaskTreeLearningEvent;
    try {
      let result: void | boolean;
      if (event.kind === 'verified' && event.proof) result = callbacks.taskVerified(event.scopeKey, event.proof, event.at);
      else if (event.kind === 'dispatched') result = callbacks.taskDispatched(event.scopeKey, event);
      else result = callbacks.taskUnusable(event.scopeKey, { ...event, reason: event.reason ?? 'unknown' });
      if (result === false) break;
      database.prepare('UPDATE agent_task_tree_learning SET delivered=1 WHERE id=?').run(row.id);
    } catch { break; }
  }
}
