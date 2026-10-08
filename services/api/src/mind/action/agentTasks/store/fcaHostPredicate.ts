import type { DatabaseSync } from 'node:sqlite';

/** OFF keeps the historical schema. Inspect at use time: FCA may be enabled after a Host store opened. */
export function fcaHostPredicate(db: DatabaseSync, alias?: 't' | 'active' | 'holder'): string {
  const columns = db.prepare("PRAGMA table_info('agent_tasks')").all();
  return columns.some(column => column.name === 'fca_kind') ? `${alias ? `${alias}.` : ''}fca_kind IS NULL` : '1=1';
}
