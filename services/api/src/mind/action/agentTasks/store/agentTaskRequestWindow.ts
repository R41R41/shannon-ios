import type { DatabaseSync } from 'node:sqlite';

/** Synchronous owner HTTP operations only; internal task/Host/proof lookup stays binary and original. */
export function withAgentTaskRequest<T>(database: DatabaseSync, scopeKey: string, requestTaskId: string, operation: (storedTaskId: string) => T): T {
  const ownsTransaction = !database.isTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    // An exact spelling cannot disambiguate UUID aliases in the owner's scope.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestTaskId);
    const rows = database.prepare(uuid
      ? 'SELECT task_id FROM agent_tasks WHERE scope_key=? AND lower(task_id)=? LIMIT 2'
      : 'SELECT task_id FROM agent_tasks WHERE scope_key=? AND task_id=? LIMIT 2')
      .all(scopeKey, uuid ? requestTaskId.toLowerCase() : requestTaskId) as { task_id: string }[];
    if (rows.length !== 1) throw new Error('AGENT_TASK_NOT_FOUND');
    const result = operation(rows[0]!.task_id);
    if (ownsTransaction) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
