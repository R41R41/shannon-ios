import type { DatabaseSync } from 'node:sqlite';
import { FCA_TASK_KINDS } from '@shannon/mind';
import { tableColumns } from '../../../../infra/sqlite/sqliteOpen.js';

/**
 * One task model (Syzygy ADR-0009 stage 1, S8). `agent_tasks` holds every task, and which kind a row is (an Agent Host Codex task
 * or a common one: root, conversation, work, sleep) is read from its `task_kind` alone, the one vocabulary of the state machine,
 * written in the row's INSERT. `fca_kind` stays as the common runtime's own data (research or generic, the root's unique index),
 * never a split between two models. A row an older build wrote without `task_kind` gets it once, from the same derivation the
 * machine uses (`deriveTaskKind`), when a store opens the table (`ensureTaskKinds`).
 */

/** The connections that have seen the `task_kind` column: a column is never dropped, so once seen the answer is fixed. */
const kinded = new WeakSet<DatabaseSync>();

function hasTaskKind(db: DatabaseSync): boolean {
  if (kinded.has(db)) return true;
  if (!tableColumns(db, 'agent_tasks').has('task_kind')) return false;
  kinded.add(db);
  return true;
}

/** Gives every row without `task_kind` the kind its old columns say (an unknown common kind keeps none and is never chosen). */
export function ensureTaskKinds(db: DatabaseSync): void {
  const columns = tableColumns(db, 'agent_tasks');
  if (!columns.has('task_kind')) return;
  if (!columns.has('fca_kind')) db.prepare("UPDATE agent_tasks SET task_kind='codex' WHERE task_kind IS NULL").run();
  else {
    const cases = Object.entries(FCA_TASK_KINDS).map(([fca, kind]) => `WHEN '${fca}' THEN '${kind}'`).join(' ');
    db.prepare(`UPDATE agent_tasks SET task_kind = CASE WHEN fca_kind IS NULL THEN 'codex' ELSE (CASE fca_kind ${cases} END) END
      WHERE task_kind IS NULL`).run();
  }
}

/**
 * The rows of the Agent Host (Codex tasks): `task_kind='codex'`. Before the task tables have the column (a switched-off part
 * whose historical schema stays as it was) every row is one, as before the common runtime.
 */
export function hostTaskPredicate(db: DatabaseSync, alias?: 't' | 'active' | 'holder'): string {
  return hasTaskKind(db) ? `${alias ? `${alias}.` : ''}task_kind = 'codex'` : '1=1';
}

/** The rows of the common runtime: every kind but Codex. */
export const COMMON_TASK = "task_kind <> 'codex'";

/** Whether a row read with `SELECT *` is an Agent Host (Codex) task. */
export function isHostTaskRow(row: { task_kind?: unknown }): boolean {
  return row.task_kind === 'codex';
}
