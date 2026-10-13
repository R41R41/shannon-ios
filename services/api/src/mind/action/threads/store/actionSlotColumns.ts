import type { DatabaseSync } from 'node:sqlite';
import {
  SLOT_CLASSES, SLOT_LIMITS_OWNER_2026_10_12, TASK_KINDS, deriveTaskKind, slotClassOf, slotLimitsOf, unknownDue, type SlotClass, type SlotLimits,
  type TaskKind,
} from '@shannon/mind';
import { tableColumns } from '../../../../infra/sqlite/sqliteOpen.js';
import { applySchemaSteps } from '../../../../infra/sqlite/migrations/schemaSteps.js';
import { ACTION_SLOTS_STEP, OWNER_SLOT_LIMITS_STEP } from '../../../../infra/sqlite/migrations/executionSteps.js';
import { fcaTaskIdOf } from './actionLeaseReader.js';

/**
 * The task link and slot class of an action (Syzygy ADR-0009 stage 1, S3, schema step 009), written at enqueue beside the old
 * columns, and `effect_sent` beside `sent` (it stays set through an unknown release). Since S6 the scheduler admits by the slot
 * class and the slot tables (step 011 writes the owner's limits). The backfill fills an older build's rows at each start.
 */
type Row = Record<string, unknown>;

/** `effect_sent` as `sent` and `state` say it (`effectSentOf`), in SQL. */
export const EFFECT_SENT_SQL = "CASE WHEN sent = 1 OR state = 'unknown' THEN 1 ELSE 0 END";

const ready = new WeakSet<DatabaseSync>();

/** Whether step 009 is applied on this file (remembered once it is). */
export function hasActionSlotColumns(db: DatabaseSync): boolean {
  if (ready.has(db)) return true;
  const columns = tableColumns(db, 'mind_actions');
  if (!['task_id', 'slot_class', 'effect_sent'].every(column => columns.has(column))) return false;
  ready.add(db);
  return true;
}

/** The action store's slot steps: the columns and tables (009), then the owner's limits as their data (011). */
export const ACTION_SLOT_STEPS = Object.freeze([ACTION_SLOTS_STEP, OWNER_SLOT_LIMITS_STEP]);

/** Applies steps 009 and 011 when the action table exists (outside a transaction; the ledger makes each once). */
export function applyActionSlotStep(db: DatabaseSync): void {
  if (tableColumns(db, 'mind_actions').size) applySchemaSteps(db, ACTION_SLOT_STEPS);
}

/**
 * The slot limits as the tables hold them; the owner's limits when the tables are missing or their rows are incomplete or wrong
 * (`slotLimitProblems`), so a damaged table never opens more slots than the owner allowed.
 */
export function readSlotLimits(db: DatabaseSync): SlotLimits {
  if (!tableColumns(db, 'mind_action_slot_pools').size || !tableColumns(db, 'mind_action_slot_classes').size) return SLOT_LIMITS_OWNER_2026_10_12;
  const pools = db.prepare('SELECT pool, max_live FROM mind_action_slot_pools').all() as Array<{ pool: unknown; max_live: unknown }>;
  const classes = db.prepare('SELECT slot_class, pool, max_live FROM mind_action_slot_classes').all() as
    Array<{ slot_class: unknown; pool: unknown; max_live: unknown }>;
  return slotLimitsOf(pools, classes) ?? SLOT_LIMITS_OWNER_2026_10_12;
}

/** An action row's slot class: the stored one, else (an older build's row) the one derived from its kind and task. */
export function slotClassOfRow(db: DatabaseSync, row: Row): SlotClass {
  const stored = row.slot_class as SlotClass | null | undefined;
  if (stored && SLOT_CLASSES.includes(stored)) return stored;
  return actionSlotColumns(db, { kind: String(row.kind), sourceId: String(row.source_id) }).slotClass;
}

/**
 * The slot classes of the scope's actions that hold a slot: live, or sent and still unknown (a respond's unknown holds none).
 * With `at`, a sent unknown whose exit is due holds none either, as the scheduler's next sweep will record (`unknownDue`).
 */
export function liveSlotClasses(db: DatabaseSync, scopeKey: string, at?: string): SlotClass[] {
  const columns = hasActionSlotColumns(db) ? 'slot_class, kind, source_id, state, updated_at' : 'NULL AS slot_class, kind, source_id, state, updated_at';
  return db.prepare(`SELECT ${columns} FROM mind_actions WHERE scope_key = ? AND (state IN ('running','waiting','stopping')
    OR (state = 'unknown' AND kind != 'respond' AND sent = 1))`).all(scopeKey)
    .filter(row => at === undefined || row.state !== 'unknown'
      || !unknownDue(String(row.updated_at), at, actionTaskLink(db, { kind: String(row.kind), sourceId: String(row.source_id) }).taskKind))
    .map(row => slotClassOfRow(db, row));
}

function taskRow(db: DatabaseSync, taskId: string): Row | undefined {
  if (!tableColumns(db, 'agent_tasks').size) return undefined;
  return db.prepare('SELECT * FROM agent_tasks WHERE task_id = ?').get(taskId);
}

function kindOfRow(row: Row): TaskKind | null {
  const stored = row.task_kind as TaskKind | undefined;
  if (stored && TASK_KINDS.includes(stored)) return stored;
  return deriveTaskKind(typeof row.fca_kind === 'string' ? row.fca_kind : null);
}

export interface ActionTaskLink {
  readonly taskId: string | null;
  readonly taskKind: TaskKind | null;
}

const NO_TASK: ActionTaskLink = Object.freeze({ taskId: null, taskKind: null });

/**
 * The task an Agent Task action runs for: an FCA step's task by the scheduler's exact source (`fca:<task>:<n>`), or the Agent
 * Host task whose id is the source (a Codex row). Any other action has none.
 */
export function actionTaskLink(db: DatabaseSync, action: { readonly kind: string; readonly sourceId: string }): ActionTaskLink {
  if (action.kind !== 'agentTask') return NO_TASK;
  const fcaTask = fcaTaskIdOf(action.sourceId);
  if (fcaTask) {
    const row = taskRow(db, fcaTask);
    const kind = row ? kindOfRow(row) : null;
    return { taskId: fcaTask, taskKind: kind !== 'codex' ? kind : null };
  }
  const row = taskRow(db, action.sourceId);
  if (!row || kindOfRow(row) !== 'codex') return NO_TASK;
  return { taskId: action.sourceId, taskKind: kindOfRow(row) };
}

/** The new columns an action is inserted with. */
export function actionSlotColumns(db: DatabaseSync, action: { readonly kind: string; readonly sourceId: string }) {
  const link = actionTaskLink(db, action);
  const slotClass: SlotClass = slotClassOf(action, link.taskKind);
  return { taskId: link.taskId, slotClass };
}

export interface ActionBackfillBatch {
  readonly next: number | null;
  readonly changed: number;
}

/**
 * One batch of the backfill, under the caller's write lock: after `after` in rowid order, the rows that miss a slot class or
 * whose `effect_sent` is not what `sent` and `state` say. A filled row is not selected again, so a second run changes nothing.
 */
export function backfillActionSlotBatch(db: DatabaseSync, after: number, limit: number): ActionBackfillBatch {
  if (!hasActionSlotColumns(db)) return { next: null, changed: 0 };
  const rows = db.prepare(`SELECT rowid AS row_id, id, kind, source_id, slot_class, ${EFFECT_SENT_SQL} AS derived_sent FROM mind_actions
    WHERE rowid > ? AND (slot_class IS NULL OR effect_sent IS NULL OR effect_sent IS NOT ${EFFECT_SENT_SQL}) ORDER BY rowid LIMIT ?`).all(after, limit);
  const update = db.prepare('UPDATE mind_actions SET task_id = ?, slot_class = ?, effect_sent = ? WHERE id = ?');
  const keep = db.prepare('UPDATE mind_actions SET effect_sent = ? WHERE id = ?');
  for (const row of rows) {
    if (row.slot_class !== null) keep.run(Number(row.derived_sent), String(row.id));
    else fill(db, update, row);
  }
  return { next: rows.length < limit ? null : Number(rows.at(-1)!.row_id), changed: rows.length };
}

function fill(db: DatabaseSync, update: ReturnType<DatabaseSync['prepare']>, row: Row): void {
  const columns = actionSlotColumns(db, { kind: String(row.kind), sourceId: String(row.source_id) });
  update.run(columns.taskId, columns.slotClass, Number(row.derived_sent), String(row.id));
}

export interface ActionProjectionCounts {
  /** Actions whose `effect_sent` is not what `sent` and `state` say (expected 0). */
  readonly mismatches: number;
  /** Actions still without a slot class or `effect_sent` (expected 0 after the backfill and with the dual write). */
  readonly nulls: number;
}

/** The S3 check of `mind_actions`, read-only. Before step 009 every row counts as missing its columns. */
export function countActionProjection(db: DatabaseSync): ActionProjectionCounts {
  if (!tableColumns(db, 'mind_actions').size) return { mismatches: 0, nulls: 0 };
  if (!hasActionSlotColumns(db)) {
    return { mismatches: 0, nulls: Number(db.prepare('SELECT COUNT(*) AS count FROM mind_actions').get()?.count ?? 0) };
  }
  const row = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN slot_class IS NULL OR effect_sent IS NULL THEN 1 ELSE 0 END), 0) AS nulls,
    COALESCE(SUM(CASE WHEN effect_sent IS NOT NULL AND effect_sent IS NOT ${EFFECT_SENT_SQL} THEN 1 ELSE 0 END), 0) AS mismatches
    FROM mind_actions`).get();
  return { mismatches: Number(row?.mismatches ?? 0), nulls: Number(row?.nulls ?? 0) };
}
