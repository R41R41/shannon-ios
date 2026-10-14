import type { DatabaseSync } from 'node:sqlite';
import { dataVersion } from './sqliteOpen.js';

/**
 * The remembered turns as last read, per scope, kept with the database's change mark at that read. 2026-10-13: one text turn read
 * and parsed every remembered turn about ten times before its model call (each withholding check, the secrets, the provenance),
 * and the FCA report scan again every few seconds: 0.5-2 s of the API's one thread per turn on the VM.
 *
 * The mark changes nothing and reads no rows: every row this connection changed (`total_changes()`, triggers and rolled-back work
 * included) and every commit by any other connection (`dataVersion`) moves it, so a read kept under the same mark is the
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

/** The database's change mark (above): equal marks mean every row reads as it did (inside a transaction: none, `null`). */
export function databaseChangeMark(database: DatabaseSync): string | null { return database.isTransaction ? null : changeMark(database); }

function changeMark(database: DatabaseSync): string {
  const changes = database.prepare('SELECT total_changes() AS changes').get() as { changes: number };
  return `${changes.changes}:${dataVersion(database)}`;
}

/** A row of `experience_events` as the remembered turns are read. */
interface ExperienceRow { sequence: number; event_id: string; observed_at: string; payload_json: string }

/**
 * The parsed turn of a row, kept while its id, time and payload text are the ones parsed (a payload may be rewritten, e.g. a touch
 * or a task's experience). 2026-10-13: every turn changes the database, so every text turn parsed all remembered turns again.
 */
const PARSED = new WeakMap<object, Map<string, Map<number, { row: ExperienceRow; value: unknown }>>>();
export function parsedRow<R extends ExperienceRow, T>(database: object, scopeKey: string, row: R, window: number, parse: (row: R) => T): T {
  let byScope = PARSED.get(database);
  if (!byScope) PARSED.set(database, byScope = new Map());
  let rows = byScope.get(scopeKey);
  if (!rows) byScope.set(scopeKey, rows = new Map());
  const known = rows.get(row.sequence);
  const same = known && known.row.event_id === row.event_id && known.row.observed_at === row.observed_at;
  if (same && known.row.payload_json === row.payload_json) return known.value as T;
  const value = parse(row);
  // Rows that fell out of the window are dropped once the map holds more than twice the window.
  if (rows.size > 2 * window) rows.clear();
  rows.set(row.sequence, { row, value });
  return value;
}
