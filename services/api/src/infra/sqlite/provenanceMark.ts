import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { dataVersion, prepared, schemaVersion, tableColumns } from './sqliteOpen.js';

/**
 * A change mark of the rows a remembered source's visibility is read from, and of no others. Production run 19 (2026-10-20,
 * Minecraft): the FCA source guard kept a read receipt's answer while the database's change mark held (`databaseChangeMark`), and the
 * mark moved with every write of any table (a lease renewed, a step's progress, a body operation, the evidence): the answers were
 * given again almost never (receipt re-asks 46 s of 79 s of checks).
 *
 * The tables are those the SQLite authorizer saw read while a receipt was answered and a moment was taken (state, remembered turns,
 * knowledge, her skills) on a copy of run 19's database, and the one read only for a correction's evidence (`knowledge_evidence`,
 * `hydrateMemoryBoundaries`); `provenanceMark.test.ts` holds the list to what the readers read. A trigger on each, in the database
 * itself (`provenanceMarkMigration.ts`), counts every row inserted, updated or deleted by any connection of any process. A skill's use
 * counts (`uses_json`, `successes`, written at each use) are not counted: nothing a source's visibility is read from is in them.
 *
 * The mark is the count with the schema's version. A schema change (a table made again drops its triggers) moves it, and the triggers
 * are then looked for again: while one is missing there is no mark (null), and the caller falls back to the database's own.
 */
export const PROVENANCE_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  companion_states: [], experience_events: [], knowledge_evidence: [], shannon_knowledge_documents: [],
  shannon_skills: ['uses_json', 'successes'], shannon_skill_revisions: [], shannon_skill_imports: [], shannon_skill_patterns: [],
});
export const PROVENANCE_COUNTER = 'shannon_provenance_counter';

/** The triggers a table needs as its columns are now: insert, delete, and update of the counted columns (named by their list). */
export function provenanceTriggers(database: DatabaseSync, table: string): Array<{ name: string; sql: string }> {
  const columns = [...tableColumns(database, table)].filter(name => !PROVENANCE_TABLES[table]!.includes(name));
  if (!columns.length) return [];
  const bump = `BEGIN UPDATE ${PROVENANCE_COUNTER} SET n = n + 1 WHERE id = 1; END`;
  const hash = createHash('sha256').update(columns.join(',')).digest('hex').slice(0, 10);
  return [
    { name: `${PROVENANCE_COUNTER}_${table}_insert`, sql: `AFTER INSERT ON ${table} ${bump}` },
    { name: `${PROVENANCE_COUNTER}_${table}_delete`, sql: `AFTER DELETE ON ${table} ${bump}` },
    { name: `${PROVENANCE_COUNTER}_${table}_update_${hash}`, sql: `AFTER UPDATE OF ${columns.map(column => `"${column}"`).join(', ')} ON ${table} ${bump}` },
  ];
}

/** The names of the tables or the triggers there are now. */
export const existingNames = (database: DatabaseSync, type: 'table' | 'trigger') => new Set((database.prepare(
  'SELECT name FROM sqlite_master WHERE type = ?').all(type) as Array<{ name: string }>).map(row => row.name));

/** Whether, at this schema version, the counter and every trigger of every watched table that exists are there (asked once a version). */
const verified = new WeakMap<DatabaseSync, { schema: number; complete: boolean }>();
function complete(database: DatabaseSync, schema: number): boolean {
  const known = verified.get(database);
  if (known?.schema === schema) return known.complete;
  const tables = existingNames(database, 'table'), triggers = existingNames(database, 'trigger');
  const result = tables.has(PROVENANCE_COUNTER) && Object.keys(PROVENANCE_TABLES).filter(name => tables.has(name))
    .every(table => provenanceTriggers(database, table).every(trigger => triggers.has(trigger.name)));
  verified.set(database, { schema, complete: result });
  return result;
}

/**
 * The mark of the rows a source's visibility is read from: this mark (`p…`) where the triggers are all there, else the database's own
 * change mark (`d…`, every write moves it); null inside a transaction. Two marks are equal only when no such row can have changed.
 */
export function sourceRowsMark(database: DatabaseSync): string | null {
  const narrow = provenanceMark(database);
  if (narrow !== null || database.isTransaction) return narrow;
  // The database's own change mark (`experienceCandidateReads.ts`): this connection's row changes and every other connection's commits.
  const changes = prepared(database, 'SELECT total_changes() AS changes').get() as { changes: number };
  return `d${changes.changes}:${dataVersion(database)}`;
}

/** The mark (above), or null: inside a transaction (a read may be taken back), or while the counter or a trigger is missing. */
export function provenanceMark(database: DatabaseSync): string | null {
  if (database.isTransaction || !database.isOpen) return null;
  try {
    const schema = schemaVersion(database);
    if (!complete(database, schema)) return null;
    const row = prepared(database, `SELECT n FROM ${PROVENANCE_COUNTER} WHERE id = 1`).get() as { n: number } | undefined;
    return row ? `p${row.n}:${schema}` : null;
  } catch { return null; }
}
