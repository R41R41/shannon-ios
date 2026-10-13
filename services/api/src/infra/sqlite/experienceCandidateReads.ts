import type { DatabaseSync } from 'node:sqlite';

/**
 * The remembered turns as last read, per scope, kept with the database's change mark at that read. 2026-10-13: one text turn read
 * and parsed every remembered turn about ten times before its model call (each withholding check, the secrets, the provenance),
 * and the FCA report scan again every few seconds: 0.5-2 s of the API's one thread per turn on the VM.
 *
 * The mark changes nothing and reads no rows: every row this connection changed (`total_changes()`, triggers and rolled-back work
 * included) and every commit by any other connection (`PRAGMA data_version`) moves it, so a read kept under the same mark is the
 * read the database would give now.
 */
const reads = new WeakMap<DatabaseSync, Map<string, { mark: string; value: unknown }>>();

/** `load()` once per scope while this connection's database is unchanged; afterwards read afresh. */
export function readWhileUnchanged<T>(database: DatabaseSync, scopeKey: string, load: () => T): T {
  // Inside a transaction a read may see rows a rollback takes back: it is neither kept nor reused.
  if (database.isTransaction) return load();
  let byScope = reads.get(database);
  if (!byScope) reads.set(database, byScope = new Map());
  const mark = changeMark(database), known = byScope.get(scopeKey);
  if (known?.mark === mark) return known.value as T;
  const value = load();
  byScope.set(scopeKey, { mark, value });
  return value;
}

function changeMark(database: DatabaseSync): string {
  const changes = database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
  const version = database.prepare('PRAGMA data_version').get() as { data_version: number };
  return `${changes.changes}:${version.data_version}`;
}
