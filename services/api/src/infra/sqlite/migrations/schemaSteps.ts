import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { underWriteLock } from '../lockWaits.js';
import { SCHEMA_STEP_BUSY_TIMEOUT_MS, tableColumns, withBusyTimeout } from '../sqliteOpen.js';

/**
 * The ledger of schema steps (Syzygy ADR-0009 stage 1, S2). A step is a fixed list of operations, identified by its id and
 * the checksum of its operations. Whichever connection needs a step first applies it under `BEGIN IMMEDIATE` and records it in
 * `shannon_schema_steps`; every later connection finds the record and runs nothing. A recorded step whose operations changed
 * is a loud error (`SHANNON_SCHEMA_STEP_CHANGED:<id>`): a step is never edited and never run twice, a change is a new step.
 *
 * The ledger is beside the file's `user_version`, never instead of it: the version is not raised, so an older build still opens
 * the file and simply ignores this table.
 */
export type SchemaOperation =
  | { readonly sql: string }
  | { readonly addColumn: { readonly table: string; readonly column: string; readonly definition: string } }
  | { readonly requireTable: { readonly table: string; readonly error: string } };

export interface SchemaStep {
  readonly id: string;
  readonly operations: readonly SchemaOperation[];
}

export interface AppliedSchemaStep {
  id: string;
  checksum: string;
  appliedAt: string;
}

export const SCHEMA_STEP_TABLE = 'shannon_schema_steps';

const LEDGER = `CREATE TABLE IF NOT EXISTS shannon_schema_steps(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`;

const checksums = new WeakMap<SchemaStep, string>();
const known = new WeakMap<DatabaseSync, Set<string>>();

/** Whitespace never counts: a run of it is one space, and the ends are trimmed. */
function normalised(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function normalisedOperation(operation: SchemaOperation): SchemaOperation {
  if ('sql' in operation) return { sql: normalised(operation.sql) };
  if ('requireTable' in operation) {
    return { requireTable: { table: normalised(operation.requireTable.table), error: normalised(operation.requireTable.error) } };
  }
  const { table, column, definition } = operation.addColumn;
  return { addColumn: { table: normalised(table), column: normalised(column), definition: normalised(definition) } };
}

/**
 * The sha256 of a step's operations with their whitespace normalised: a change of words changes it, a change of indentation
 * or line breaks does not (`executionSchemaSteps.test.ts` pins each step's value).
 */
export function schemaStepChecksum(step: SchemaStep): string {
  const cached = checksums.get(step);
  if (cached) return cached;
  const text = JSON.stringify(step.operations.map(normalisedOperation));
  const checksum = createHash('sha256').update(text).digest('hex');
  checksums.set(step, checksum);
  return checksum;
}

/**
 * Applies the steps this connection has not seen yet, in order. A connection that finds every step recorded takes no write
 * lock; the check is made once per connection and step. A step still to apply is refused inside a transaction of the caller
 * (`SHANNON_SCHEMA_STEP_IN_TRANSACTION:<id>`): its rollback would undo the step after this connection noted it as done.
 */
export function applySchemaSteps(database: DatabaseSync, steps: readonly SchemaStep[], now = () => new Date().toISOString()): void {
  const seen = known.get(database) ?? new Set<string>();
  known.set(database, seen);
  const pending = steps.filter(step => !seen.has(step.id));
  if (!pending.length) return;
  const recorded = recordedChecksums(database);
  const missing = pending.filter(step => !alreadyApplied(step, recorded));
  if (missing.length && database.isTransaction) throw new Error(`SHANNON_SCHEMA_STEP_IN_TRANSACTION:${missing[0]!.id}`);
  if (missing.length) {
    withBusyTimeout(database, SCHEMA_STEP_BUSY_TIMEOUT_MS, () => {
      underWriteLock(database, null, '', () => applyMissing(database, missing, now()), 'shannon_schema_steps');
    });
  }
  for (const step of pending) seen.add(step.id);
}

/**
 * Applies the steps that are not recorded yet inside a write transaction the caller already holds (`BEGIN IMMEDIATE`) and
 * commits itself. Nothing is remembered for the connection: a rollback leaves the steps to be applied again.
 */
export function applySchemaStepsUnderLock(database: DatabaseSync, steps: readonly SchemaStep[], at: string): void {
  if (!database.isTransaction) throw new Error('SHANNON_SCHEMA_STEP_LOCK_REQUIRED');
  applyMissing(database, steps, at);
}

/** The ledger's rows, oldest first (empty before any step was applied). */
export function appliedSchemaSteps(database: DatabaseSync): AppliedSchemaStep[] {
  if (!ledgerExists(database)) return [];
  const rows = database.prepare(`SELECT id, checksum, applied_at FROM ${SCHEMA_STEP_TABLE} ORDER BY applied_at, rowid`).all();
  return rows.map(row => ({ id: String(row.id), checksum: String(row.checksum), appliedAt: String(row.applied_at) }));
}

function applyMissing(database: DatabaseSync, steps: readonly SchemaStep[], at: string): void {
  database.exec(LEDGER);
  // Read again under the lock: another process may have applied a step since the first look.
  const recorded = recordedChecksums(database);
  const insert = database.prepare(`INSERT INTO ${SCHEMA_STEP_TABLE}(id, checksum, applied_at) VALUES (?, ?, ?)`);
  for (const step of steps) {
    if (alreadyApplied(step, recorded)) continue;
    for (const operation of step.operations) applyOperation(database, operation);
    insert.run(step.id, schemaStepChecksum(step), at);
  }
}

function applyOperation(database: DatabaseSync, operation: SchemaOperation): void {
  if ('sql' in operation) {
    database.exec(operation.sql);
    return;
  }
  if ('requireTable' in operation) {
    if (!tableColumns(database, operation.requireTable.table).size) throw new Error(operation.requireTable.error);
    return;
  }
  const { table, column, definition } = operation.addColumn;
  if (!/^[a-z_]+$/u.test(column)) throw new Error('SCHEMA_COLUMN');
  if (tableColumns(database, table).has(column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function alreadyApplied(step: SchemaStep, recorded: ReadonlyMap<string, string>): boolean {
  const checksum = recorded.get(step.id);
  if (checksum === undefined) return false;
  if (checksum !== schemaStepChecksum(step)) throw new Error(`SHANNON_SCHEMA_STEP_CHANGED:${step.id}`);
  return true;
}

function recordedChecksums(database: DatabaseSync): Map<string, string> {
  if (!ledgerExists(database)) return new Map();
  const rows = database.prepare(`SELECT id, checksum FROM ${SCHEMA_STEP_TABLE}`).all();
  return new Map(rows.map(row => [String(row.id), String(row.checksum)]));
}

function ledgerExists(database: DatabaseSync): boolean {
  const row = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(SCHEMA_STEP_TABLE);
  return Boolean(row);
}
