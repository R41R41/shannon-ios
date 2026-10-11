import type { DatabaseSync } from 'node:sqlite';
import { tableColumns } from '../../../../infra/sqlite/sqliteOpen.js';

/** The connections that have seen the FCA columns: a column is never dropped, so once seen the answer is fixed. */
const withFcaColumns = new WeakSet<DatabaseSync>();

function hasFcaColumns(db: DatabaseSync): boolean {
  if (withFcaColumns.has(db)) return true;
  if (!tableColumns(db, 'agent_tasks').has('fca_kind')) return false;
  withFcaColumns.add(db);
  return true;
}

/**
 * OFF keeps the historical schema. FCA may be enabled after a Host store opened, so a connection that has not seen the column
 * looks again at its next use; once it has, the predicate is a constant for that connection.
 */
export function fcaHostPredicate(db: DatabaseSync, alias?: 't' | 'active' | 'holder'): string {
  return hasFcaColumns(db) ? `${alias ? `${alias}.` : ''}fca_kind IS NULL` : '1=1';
}
