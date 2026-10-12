import type { DatabaseSync } from 'node:sqlite';
import {
  EXEC_STATES, TASK_KINDS, deriveTask, legacyProjection, legacyStateOf, type DerivedTask, type ExecState, type TaskFacts,
} from '@shannon/mind';
import { tableColumns } from '../../../../infra/sqlite/sqliteOpen.js';
import { applySchemaSteps } from '../../../../infra/sqlite/migrations/schemaSteps.js';
import { TASK_EXECUTION_COLUMNS_STEP, TASK_HOST_STARTING_STEP } from '../../../../infra/sqlite/migrations/executionSteps.js';

/**
 * The task vocabulary's columns on `agent_tasks` (Syzygy ADR-0009 stage 1, S3 step 008 and S4 step 010). Since S4 the state
 * machine is their writer (`taskStore.ts`), with `status` and `pause_reason` as its projection in the same UPDATE. This module
 * reads them, re-derives at each start of the API the rows another writer touched after the machine (`updated_at` later than
 * `exec_state_at`: a row an older build wrote during a rollback window), and counts what does not agree for `GET /v1/ops`.
 */
type Row = Record<string, unknown>;

export interface TaskExecution extends DerivedTask {
  readonly unknownSince: string | null;
  readonly execStateAt: string | null;
}

const NEW_COLUMNS = ['task_kind', 'exec_state', 'wait_reason', 'unknown_since', 'effect_class', 'exec_state_at', 'exec_starting'] as const;
const ready = new WeakSet<DatabaseSync>();

/** Whether steps 008 and 010 are applied on this file (remembered once they are). */
export function hasTaskExecutionColumns(db: DatabaseSync): boolean {
  if (ready.has(db)) return true;
  const columns = tableColumns(db, 'agent_tasks');
  if (!NEW_COLUMNS.every(column => columns.has(column))) return false;
  ready.add(db);
  return true;
}

/** The task store's steps, applied in this order by whoever opens `agent_tasks` first. */
export const TASK_STORE_STEPS = Object.freeze([TASK_EXECUTION_COLUMNS_STEP, TASK_HOST_STARTING_STEP]);

/** Applies steps 008 and 010 when `agent_tasks` exists (outside a transaction; the ledger makes each once). */
export function applyTaskExecutionStep(db: DatabaseSync): void {
  if (tableColumns(db, 'agent_tasks').size) applySchemaSteps(db, TASK_STORE_STEPS);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** The task rows with their FCA checkpoint (when the runtime ever ran), one select for the writer, the backfill and the count. */
export function factsSelect(db: DatabaseSync): string {
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

/** The stored state of a row, or null when a column is missing or not of the vocabulary. */
export function storedExecution(row: Row): DerivedTask | null {
  const taskKind = text(row.task_kind) as DerivedTask['taskKind'] | null;
  const execState = text(row.exec_state) as DerivedTask['execState'] | null;
  if (!taskKind || !execState || !TASK_KINDS.includes(taskKind) || !EXEC_STATES.includes(execState)) return null;
  const effectClass = row.effect_class === 'external' ? 'external' : 'none';
  return { taskKind, execState, waitReason: text(row.wait_reason), effectClass };
}

/** Whether the machine was the last to write the row: no other writer changed it after `exec_state_at`. */
export function writtenByMachine(row: Row): boolean {
  const at = text(row.exec_state_at);
  const updated = text(row.updated_at);
  return at !== null && (updated === null || updated <= at);
}

/** The state a row is in: the stored one when the machine wrote it last, else the one its old columns say. */
export function currentExecState(row: Row): ExecState | null {
  const stored = storedExecution(row);
  if (stored && writtenByMachine(row)) return stored.execState;
  return deriveTask(taskFactsOf(row))?.execState ?? null;
}

/** A task's execution columns: the stored values, else (an older build's row, before the backfill) those derived. */
export function taskExecution(row: Row): TaskExecution | null {
  const stored = storedExecution(row);
  const value = stored ?? deriveTask(taskFactsOf(row));
  if (!value) return null;
  return { ...value, unknownSince: text(row.unknown_since), execStateAt: text(row.exec_state_at) };
}

/** When an FCA task became unknown: its latest `fca_recovery_unknown` event, else its last update (`taskUnknownMetrics.ts`). */
export function unknownSinceOf(db: DatabaseSync, row: Row): string | null {
  const stored = text(row.unknown_since);
  if (stored && row.exec_state === 'unknown') return stored;
  const event = db.prepare(`SELECT MAX(occurred_at) AS at FROM agent_task_events WHERE task_id = ? AND event_type = 'fca_recovery_unknown'`)
    .get(String(row.task_id));
  return text(event?.at) ?? text(row.updated_at);
}

/**
 * The `unknown_since` a row keeps in a state: set while unknown; kept when an unknown outcome closed as failed (the mark of a
 * result never confirmed, `unknown_retired` or `outcome_unknown_closed`); empty otherwise.
 */
function keptUnknownSince(db: DatabaseSync, row: Row, state: ExecState): string | null {
  if (state === 'unknown') return unknownSinceOf(db, row);
  return state === 'failed' ? text(row.unknown_since) : null;
}

type Values = Readonly<Record<typeof NEW_COLUMNS[number], string | number | null>>;

/** The Host's starting flag of a row as its old columns say it: only an active Codex task can be starting. */
function startingOf(derived: DerivedTask, row: Row): number | null {
  if (derived.taskKind !== 'codex') return null;
  return derived.execState === 'active' && row.status === 'starting' ? 1 : 0;
}

function derivedValues(db: DatabaseSync, row: Row): Values | null {
  const derived = deriveTask(taskFactsOf(row));
  if (!derived) return null;
  return {
    task_kind: derived.taskKind, exec_state: derived.execState, wait_reason: derived.waitReason, effect_class: derived.effectClass,
    unknown_since: keptUnknownSince(db, row, derived.execState), exec_starting: startingOf(derived, row),
    exec_state_at: text(row.updated_at) ?? text(row.exec_state_at),
  };
}

function writeValues(db: DatabaseSync, row: Row, values: Values): boolean {
  if (NEW_COLUMNS.every(column => row[column] === values[column])) return false;
  db.prepare(`UPDATE agent_tasks SET task_kind = ?, exec_state = ?, wait_reason = ?, unknown_since = ?, effect_class = ?, exec_state_at = ?,
    exec_starting = ? WHERE task_id = ?`).run(values.task_kind, values.exec_state, values.wait_reason, values.unknown_since,
    values.effect_class, values.exec_state_at, values.exec_starting, String(row.task_id));
  return true;
}

export interface BackfillBatch {
  /** The rowid to continue after, or null when the table is done. */
  readonly next: number | null;
  readonly changed: number;
}

/** Whether another writer touched the row after the machine, or the machine never wrote it (or its Host flag) at all. */
function stale(row: Row): boolean {
  if (row.exec_state === null || row.exec_state === undefined || typeof row.exec_state_at !== 'string') return true;
  if ((row.exec_starting === null || row.exec_starting === undefined) && typeof row.fca_kind !== 'string') return true;
  return typeof row.updated_at === 'string' && row.updated_at > row.exec_state_at;
}

/**
 * One batch of the start's re-derivation, under the caller's write lock: after `after` in rowid order, the rows the machine did
 * not write last (`updated_at` later than `exec_state_at`, a column missing) or whose stored state no longer projects onto their
 * old columns (another writer's clock behind the machine's), derived again from the old columns, with `exec_state_at` brought
 * to their `updated_at`. A re-derived row is right afterwards, so a second run changes nothing.
 */
export function backfillTaskExecutionBatch(db: DatabaseSync, after: number, limit: number): BackfillBatch {
  if (!hasTaskExecutionColumns(db)) return { next: null, changed: 0 };
  const rows = db.prepare(`${factsSelect(db)} WHERE t.rowid > ? ORDER BY t.rowid LIMIT ?`).all(after, limit);
  let changed = 0;
  for (const row of rows) {
    const stored = storedExecution(row);
    if (!stale(row) && stored && projects(stored, row, taskFactsOf(row))) continue;
    const values = derivedValues(db, row);
    if (values && writeValues(db, row, values)) changed += 1;
  }
  return { next: rows.length < limit ? null : Number(rows.at(-1)!.row_id), changed };
}

export interface TaskProjectionCounts {
  /** Rows whose stored state does not project back onto their `status` and `pause_reason` (expected 0). */
  readonly mismatches: number;
  /** Rows still missing a derived column (expected 0 after the backfill and with the machine writing). */
  readonly nulls: number;
  /** Rows whose stored state or wait reason is not what their old columns and checkpoint say (S3 review L2; expected 0). */
  readonly stateMismatches: number;
}

function rowCount(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM agent_tasks').get()?.count ?? 0);
}

/** Whether the stored state projects back onto the row's old columns, with the Host's starting flag as stored (L3). */
export function projects(stored: DerivedTask, row: Row, facts: TaskFacts): boolean {
  const starting = row.exec_starting === null || row.exec_starting === undefined ? row.status === 'starting' : Number(row.exec_starting) === 1;
  const projected = legacyProjection(stored.execState, stored.taskKind, { starting, waitReason: stored.waitReason });
  const current = legacyStateOf(facts);
  return projected !== null && projected.status === current.status && projected.pauseReason === current.pauseReason;
}

function agrees(stored: DerivedTask, facts: TaskFacts): boolean {
  const derived = deriveTask(facts);
  return derived !== null && derived.taskKind === stored.taskKind && derived.execState === stored.execState
    && derived.waitReason === stored.waitReason;
}

/** The check of `agent_tasks`, read-only. Before step 008 every row counts as missing its columns. */
export function countTaskProjection(db: DatabaseSync): TaskProjectionCounts {
  if (!hasTable(db, 'agent_tasks')) return { mismatches: 0, nulls: 0, stateMismatches: 0 };
  if (!hasTaskExecutionColumns(db)) return { mismatches: 0, nulls: rowCount(db), stateMismatches: 0 };
  let mismatches = 0;
  let nulls = 0;
  let stateMismatches = 0;
  for (const row of db.prepare(factsSelect(db)).all()) {
    const stored = storedExecution(row);
    const facts = taskFactsOf(row);
    if (!stored || !row.effect_class || !row.exec_state_at) nulls += 1;
    else if (!projects(stored, row, facts)) mismatches += 1;
    else if (!agrees(stored, facts)) stateMismatches += 1;
  }
  return { mismatches, nulls, stateMismatches };
}

/** Whether a task failed because its unknown outcome reached the exit: it keeps when it became unknown (S5). Read-only. */
export function failedWithUnknownOutcome(db: DatabaseSync, taskId: string): boolean {
  if (!tableColumns(db, 'agent_tasks').has('unknown_since')) return false;
  return Boolean(db.prepare("SELECT 1 AS found FROM agent_tasks WHERE task_id = ? AND status = 'failed' AND unknown_since IS NOT NULL").get(taskId));
}
