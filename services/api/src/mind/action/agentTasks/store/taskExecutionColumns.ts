import type { DatabaseSync } from 'node:sqlite';
import { EXEC_STATES, TASK_KINDS, deriveTask, projectionMatches, type DerivedTask, type TaskFacts } from '@shannon/mind';
import { tableColumns } from '../../../../infra/sqlite/sqliteOpen.js';
import { applySchemaSteps } from '../../../../infra/sqlite/migrations/schemaSteps.js';
import { TASK_EXECUTION_COLUMNS_STEP } from '../../../../infra/sqlite/migrations/executionSteps.js';

/**
 * The task vocabulary's columns on `agent_tasks` (Syzygy ADR-0009 stage 1, S3, schema step 008), written beside `status` and
 * `pause_reason`, which stay the authority. Every write of a task's status ends here (`refreshTaskExecution`: the Agent Host
 * store's event append, the FCA authority's create and event), and the backfill re-derives every row at each start of the API
 * (rows written by an older build). A read takes a stored value, else the value derived from the old columns (`taskExecution`).
 */
type Row = Record<string, unknown>;

export interface TaskExecution extends DerivedTask {
  readonly unknownSince: string | null;
  readonly execStateAt: string | null;
}

const NEW_COLUMNS = ['task_kind', 'exec_state', 'wait_reason', 'unknown_since', 'effect_class', 'exec_state_at'] as const;
const ready = new WeakSet<DatabaseSync>();

/** Whether step 008 is applied on this file (remembered once it is). */
export function hasTaskExecutionColumns(db: DatabaseSync): boolean {
  if (ready.has(db)) return true;
  const columns = tableColumns(db, 'agent_tasks');
  if (!NEW_COLUMNS.every(column => columns.has(column))) return false;
  ready.add(db);
  return true;
}

/** Applies step 008 when `agent_tasks` exists (outside a transaction; the ledger makes it once). */
export function applyTaskExecutionStep(db: DatabaseSync): void {
  if (tableColumns(db, 'agent_tasks').size) applySchemaSteps(db, [TASK_EXECUTION_COLUMNS_STEP]);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** The task rows with their FCA checkpoint (when the runtime ever ran), one select for the backfill, the refresh and the count. */
function factsSelect(db: DatabaseSync): string {
  if (!hasTable(db, 'fca_task_checkpoints')) {
    return 'SELECT t.rowid AS row_id, t.*, NULL AS c_step_id, 0 AS c_stop_requested, NULL AS c_wait_reason FROM agent_tasks t';
  }
  return `SELECT t.rowid AS row_id, t.*, c.step_id AS c_step_id, c.stop_requested AS c_stop_requested, c.wait_reason AS c_wait_reason
    FROM agent_tasks t LEFT JOIN fca_task_checkpoints c ON c.task_id = t.task_id`;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What the old columns of a row say. */
export function taskFactsOf(row: Row): TaskFacts {
  return {
    fcaKind: text(row.fca_kind), status: String(row.status), pauseReason: text(row.pause_reason), currentAction: text(row.current_action),
    stepId: text(row.c_step_id), stopRequested: Number(row.c_stop_requested ?? 0) === 1, checkpointWaitReason: text(row.c_wait_reason),
  };
}

function storedExecution(row: Row): DerivedTask | null {
  const taskKind = text(row.task_kind) as DerivedTask['taskKind'] | null;
  const execState = text(row.exec_state) as DerivedTask['execState'] | null;
  if (!taskKind || !execState || !TASK_KINDS.includes(taskKind) || !EXEC_STATES.includes(execState)) return null;
  const effectClass = row.effect_class === 'external' ? 'external' : 'none';
  return { taskKind, execState, waitReason: text(row.wait_reason), effectClass };
}

/** A task's execution columns: the stored values, else (an older build's row, before the backfill) those derived. */
export function taskExecution(row: Row): TaskExecution | null {
  const stored = storedExecution(row);
  const value = stored ?? deriveTask(taskFactsOf(row));
  if (!value) return null;
  return { ...value, unknownSince: text(row.unknown_since), execStateAt: text(row.exec_state_at) };
}

/** When an FCA task became unknown: its latest `fca_recovery_unknown` event, else its last update (`taskUnknownMetrics.ts`). */
function unknownSince(db: DatabaseSync, row: Row): string | null {
  const stored = text(row.unknown_since);
  if (stored && row.exec_state === 'unknown') return stored;
  const event = db.prepare(`SELECT MAX(occurred_at) AS at FROM agent_task_events WHERE task_id = ? AND event_type = 'fca_recovery_unknown'`)
    .get(String(row.task_id));
  return text(event?.at) ?? text(row.updated_at);
}

type Values = Readonly<Record<typeof NEW_COLUMNS[number], string | null>>;

function derivedValues(db: DatabaseSync, row: Row, at: string | null): Values | null {
  const derived = deriveTask(taskFactsOf(row));
  if (!derived) return null;
  const same = row.exec_state === derived.execState && typeof row.exec_state_at === 'string';
  return {
    task_kind: derived.taskKind, exec_state: derived.execState, wait_reason: derived.waitReason, effect_class: derived.effectClass,
    unknown_since: derived.execState === 'unknown' ? unknownSince(db, row) : null,
    exec_state_at: same ? text(row.exec_state_at) : at ?? text(row.updated_at),
  };
}

function writeValues(db: DatabaseSync, row: Row, values: Values): boolean {
  if (NEW_COLUMNS.every(column => row[column] === values[column])) return false;
  db.prepare(`UPDATE agent_tasks SET task_kind = ?, exec_state = ?, wait_reason = ?, unknown_since = ?, effect_class = ?, exec_state_at = ?
    WHERE task_id = ?`).run(values.task_kind, values.exec_state, values.wait_reason, values.unknown_since, values.effect_class,
    values.exec_state_at, String(row.task_id));
  return true;
}

/**
 * The dual write: re-derives one task's columns from its row and checkpoint as they are now, inside the caller's transaction,
 * and writes them when they changed (`at` becomes `exec_state_at` when the state changed). Nothing happens before step 008.
 */
export function refreshTaskExecution(db: DatabaseSync, taskId: string, at: string): void {
  if (!hasTaskExecutionColumns(db)) return;
  const row = db.prepare(`${factsSelect(db)} WHERE t.task_id = ?`).get(taskId);
  if (!row) return;
  const values = derivedValues(db, row, at);
  if (values) writeValues(db, row, values);
}

export interface BackfillBatch {
  /** The rowid to continue after, or null when the table is done. */
  readonly next: number | null;
  readonly changed: number;
}

/**
 * One batch of the backfill, under the caller's write lock: the rows after `after` in rowid order, re-derived from the old
 * columns. A row already right is not written, so a second run changes nothing. `exec_state_at` of a row filled here is its
 * `updated_at`.
 */
export function backfillTaskExecutionBatch(db: DatabaseSync, after: number, limit: number): BackfillBatch {
  if (!hasTaskExecutionColumns(db)) return { next: null, changed: 0 };
  const rows = db.prepare(`${factsSelect(db)} WHERE t.rowid > ? ORDER BY t.rowid LIMIT ?`).all(after, limit);
  let changed = 0;
  for (const row of rows) {
    const values = derivedValues(db, row, null);
    if (values && writeValues(db, row, values)) changed += 1;
  }
  return { next: rows.length < limit ? null : Number(rows.at(-1)!.row_id), changed };
}

export interface TaskProjectionCounts {
  /** Rows whose stored state does not project back onto their `status` and `pause_reason` (expected 0). */
  readonly mismatches: number;
  /** Rows still missing a derived column (expected 0 after the backfill and with the dual write). */
  readonly nulls: number;
}

function rowCount(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM agent_tasks').get()?.count ?? 0);
}

/** The S3 check of `agent_tasks`, read-only. Before step 008 every row counts as missing its columns. */
export function countTaskProjection(db: DatabaseSync): TaskProjectionCounts {
  if (!hasTable(db, 'agent_tasks')) return { mismatches: 0, nulls: 0 };
  if (!hasTaskExecutionColumns(db)) return { mismatches: 0, nulls: rowCount(db) };
  let mismatches = 0;
  let nulls = 0;
  for (const row of db.prepare(factsSelect(db)).all()) {
    const stored = storedExecution(row);
    if (!stored || !row.effect_class || !row.exec_state_at) nulls += 1;
    else if (!projectionMatches(stored, taskFactsOf(row))) mismatches += 1;
  }
  return { mismatches, nulls };
}
