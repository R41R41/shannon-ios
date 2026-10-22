import type { DatabaseSync } from 'node:sqlite';
import { dataVersion, prepared } from './sqliteOpen.js';
import { sourceRowsMark } from './provenanceMark.js';

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

/**
 * `load()` (the remembered turns) once per scope while they are unchanged; afterwards read afresh. They are source rows, so the source
 * rows' mark tells (`provenanceMark.ts`; the database's own where it cannot): production run 19, every lease renewal and step's progress
 * moved the whole database's mark, and the turns were read again each time. Null: not kept.
 */
export function readWhileUnchanged<T>(database: DatabaseSync, scopeKey: string, load: () => T): T {
  // Inside a transaction a read may see rows a rollback takes back: it is neither kept nor reused.
  if (database.isTransaction) return load();
  let byScope = reads.get(database);
  if (!byScope) reads.set(database, byScope = new Map());
  const markOf = sourceRowsMark, mark = markOf(database), known = byScope.get(scopeKey);
  if (mark !== null && known?.mark === mark) return known.value as T;
  const value = load();
  // Kept only under the mark read before the rows, and only if the rows did not change while they were read.
  if (mark !== null && markOf(database) === mark) byScope.set(scopeKey, { mark, value });
  return value;
}

/**
 * `readWhileUnchanged` in steps (`memorySteps.ts`): `load()` reads the rows a page at a time. What it read is kept and given only when no
 * source row changed while it read (its mark is the one before the first page), and so is what one read would give at the end; else, or
 * inside a transaction, `whole()` reads them at once as before.
 */
export function* readWhileUnchangedSteps<T>(database: DatabaseSync, scopeKey: string, load: () => Generator<void, T, undefined>,
  whole: () => T): Generator<void, T, undefined> {
  if (database.isTransaction) return whole();
  let byScope = reads.get(database);
  if (!byScope) reads.set(database, byScope = new Map());
  const mark = sourceRowsMark(database), known = byScope.get(scopeKey);
  if (mark !== null && known?.mark === mark) return known.value as T;
  if (mark === null) return whole();
  const value = yield* load();
  if (database.isTransaction || sourceRowsMark(database) !== mark) return whole();
  byScope.set(scopeKey, { mark, value });
  return value;
}

/** The rows of one step of `candidateSteps` (a body task's episode is about 12 KB of payload). */
const CANDIDATE_PAGE = 25;

/**
 * The conversation store's `experienceCandidates` a page at a time (`ConversationStore.experienceCandidateSteps`): the same rows (the newest
 * `maximumExperiences` by `sequence`), parsed by `parse` in the same order, given as `whole()` (that read at once) gives them when no source
 * row changed meanwhile (`readWhileUnchangedSteps`).
 */
export function candidateSteps<T>(context: { database: DatabaseSync; maximumExperiences: number }, scopeKey: string,
  parse: (row: ExperienceRow) => T[], whole: () => readonly T[]): Generator<void, readonly T[], undefined> {
  return readWhileUnchangedSteps(context.database, scopeKey, () => candidatePages(context.database, scopeKey, context.maximumExperiences, parse), whole);
}
function* candidatePages<T>(database: DatabaseSync, scopeKey: string, maximum: number, parse: (row: ExperienceRow) => T[]):
  Generator<void, readonly T[], undefined> {
  const rows: ExperienceRow[] = [], page = prepared(database, `
    SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
    FROM experience_events
    WHERE scope_key = ? AND event_type = 'turn.completed' AND sequence < ?
    ORDER BY sequence DESC
    LIMIT ?
  `);
  for (let before = Number.MAX_SAFE_INTEGER; rows.length < maximum;) {
    const wanted = Math.min(CANDIDATE_PAGE, maximum - rows.length);
    const found = page.all(scopeKey, before, wanted) as unknown as ExperienceRow[];
    rows.push(...found);
    if (found.length < wanted) break;
    before = found.at(-1)!.sequence;
    yield;
  }
  rows.reverse();
  const parsed: T[] = [];
  for (let start = 0; start < rows.length; start += CANDIDATE_PAGE) {
    for (const row of rows.slice(start, start + CANDIDATE_PAGE)) parsed.push(...parsedRow(database, scopeKey, row, maximum, parse));
    yield;
  }
  return Object.freeze(parsed);
}

const keptReads = new WeakMap<DatabaseSync, Map<string, { mark: string; value: unknown }>>();
const KEPT_READS = 64;

/**
 * `load()` once per key while this connection's database is unchanged: the same rule as `readWhileUnchanged` for reads that are many
 * (a thread's messages: one recall step asked for the same few threads 14 times, each read and parsed whole) and fixed by their key.
 * At most `KEPT_READS` keys are kept, the oldest dropped; a changed database is read again.
 */
export function readKeptWhileUnchanged<T>(database: DatabaseSync, key: string, load: () => T): T {
  if (database.isTransaction) return load();
  let kept = keptReads.get(database);
  if (!kept) keptReads.set(database, kept = new Map());
  const mark = changeMark(database), known = kept.get(key);
  if (known?.mark === mark) return known.value as T;
  const value = load();
  if (!known && kept.size >= KEPT_READS) kept.delete(kept.keys().next().value!);
  kept.set(key, { mark, value });
  return value;
}

/** The database's change mark (above): equal marks mean every row reads as it did (inside a transaction: none, `null`). */
export function databaseChangeMark(database: DatabaseSync): string | null { return database.isTransaction ? null : changeMark(database); }

/**
 * Row changes only: `total_changes()` counts the rows this connection changed, `data_version` the commits of every other connection.
 * A schema change made on this very connection (CREATE, ALTER, DROP, an index) changes no row and so does not move the mark, and a
 * checkpoint moves nothing either. That is as it must be for what is kept under the mark (rows read, and values derived from rows
 * alone): none of it depends on the schema, and a statement kept by `prepared` compiles itself again when the schema changes (SQLite).
 * A value kept under the mark that did depend on the schema would have to be keyed by it too. Both statements are prepared once.
 */
function changeMark(database: DatabaseSync): string {
  const changes = prepared(database, 'SELECT total_changes() AS changes').get() as { changes: number };
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
