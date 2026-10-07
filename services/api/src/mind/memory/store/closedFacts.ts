import type { DatabaseSync } from 'node:sqlite';

/**
 * The person memory items recall leaves out at `at` (Syzygy ADR-0008 stage 3, F6): expired by then, not yet valid, or no longer
 * valid. Its own module with no import, so a process that only reads people memory (the activity loop's owner context, the sleep
 * worker's platform people) reads it without loading people facts (stage 3 review M4). Empty while the columns do not exist.
 */
export function closedPersonItemIds(database: DatabaseSync, scopeKey: string, at: string): ReadonlySet<string> {
  const columns = (database.prepare(`PRAGMA table_info(person_memory_items)`).all() as Array<{ name: string }>).map(column => column.name);
  if (!columns.includes('expired_at') || !columns.includes('invalid_at') || !columns.includes('valid_at')) return new Set();
  const rows = database.prepare(`SELECT item_id FROM person_memory_items WHERE scope_key = ?
    AND ((expired_at IS NOT NULL AND expired_at <= ?) OR (invalid_at IS NOT NULL AND invalid_at <= ?) OR (valid_at IS NOT NULL AND valid_at > ?))`)
    .all(scopeKey, at, at, at) as Array<{ item_id: string }>;
  return new Set(rows.map(row => row.item_id));
}
