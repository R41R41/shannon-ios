import type { DatabaseSync } from 'node:sqlite';
import {
  deriveTask, deriveTaskKind, legacyStateOf, taskTransition, transitionRefusalKey, type ExecState, type TaskFacts, type TaskKind,
} from '@shannon/mind';
import {
  currentExecState, factsSelect, hasTaskExecutionColumns, taskFactsOf, unknownSinceOf,
} from './taskExecutionColumns.js';

/**
 * The one writer of a task's state (Syzygy ADR-0009 stage 1, S4). The FCA authority's events and the Agent Host store's status
 * changes both end here: what the writer asks for, in the old columns' words (`status`, `pause_reason`) with the FCA checkpoint
 * as it is now, is turned into the state it means; the pure machine (`taskTransition`, `@shannon/mind`) allows or refuses the
 * move; and `exec_state` is written with its projection onto `status` and `pause_reason` in one UPDATE. A refused move writes
 * nothing, throws `TASK_TRANSITION_REFUSED` (the caller's transaction rolls back) and is counted for `GET /v1/ops`.
 */
type Row = Record<string, unknown>;

export interface TaskStateChange {
  readonly status: string;
  readonly pauseReason: string | null;
  /** `current_action` as it is after the write, when the writer changes it (an Agent Host pause without a reason reads it). */
  readonly currentAction?: string | null;
  /** When the outcome became unknown, for a task closed as failed with that outcome (`outcome_unknown_closed`). */
  readonly unknownSince?: string;
}

const refusals = new Map<string, number>();
let refusedSince: string | null = null;

/** Transitions refused since this process started, by `<reason>:<kind>:<from>><to>` (expected none). */
export function taskTransitionRefusals(): { since: string | null; byReason: Readonly<Record<string, number>> } {
  return { since: refusedSince, byReason: Object.freeze(Object.fromEntries(refusals)) };
}

/** Test support: forgets the counted refusals. */
export function resetTaskTransitionRefusals(): void {
  refusals.clear();
  refusedSince = null;
}

function refuse(key: string, at: string): never {
  refusals.set(key, (refusals.get(key) ?? 0) + 1);
  refusedSince ??= at;
  throw new Error('TASK_TRANSITION_REFUSED');
}

function requestedFacts(row: Row, change: TaskStateChange): TaskFacts {
  const current = taskFactsOf(row);
  const currentAction = change.currentAction === undefined ? current.currentAction : change.currentAction;
  return { ...current, status: change.status, pauseReason: change.pauseReason, currentAction };
}

function unknownSinceAfter(db: DatabaseSync, row: Row, from: ExecState | null, to: ExecState, change: TaskStateChange, at: string) {
  if (to === 'unknown') return from === 'unknown' ? unknownSinceOf(db, row) : at;
  if (to !== 'failed') return null;
  if (change.unknownSince) return change.unknownSince;
  return from === 'unknown' ? unknownSinceOf(db, row) : typeof row.unknown_since === 'string' ? row.unknown_since : null;
}

function kindOf(facts: TaskFacts): TaskKind | null {
  return deriveTaskKind(facts.fcaKind);
}

/**
 * Moves one task to the state `change` means, inside the caller's transaction, and returns that state. The old columns written
 * are the machine's projection, which equals what the writer asked for (a request without one is refused as `no_projection`).
 */
export function writeTaskState(db: DatabaseSync, taskId: string, change: TaskStateChange, at: string): ExecState {
  const row = db.prepare(`${factsSelect(db)} WHERE t.task_id = ?`).get(taskId);
  if (!row) throw new Error('TASK_NOT_FOUND');
  const facts = requestedFacts(row, change);
  const kind = kindOf(facts);
  const target = deriveTask(facts);
  if (!kind || !target) refuse(`no_state:${kind ?? 'none'}:${change.status}`, at);
  const from = currentExecState(row);
  const result = taskTransition(from, kind, { to: target.execState, waitReason: target.waitReason, starting: change.status === 'starting' });
  if (!result.ok) refuse(transitionRefusalKey(kind, result), at);
  const asked = legacyStateOf(facts);
  if (result.legacy.status !== asked.status || result.legacy.pauseReason !== asked.pauseReason) {
    refuse(`no_projection:${kind}:${from ?? 'none'}>${result.state}`, at);
  }
  if (!hasTaskExecutionColumns(db)) {
    db.prepare('UPDATE agent_tasks SET status = ?, pause_reason = ? WHERE task_id = ?').run(result.legacy.status, result.legacy.pauseReason, taskId);
    return result.state;
  }
  const unknownSince = unknownSinceAfter(db, row, from, result.state, change, at);
  const starting = kind === 'codex' ? Number(result.starting) : null;
  db.prepare(`UPDATE agent_tasks SET status = ?, pause_reason = ?, task_kind = ?, exec_state = ?, wait_reason = ?, effect_class = ?,
    unknown_since = ?, exec_starting = ?, exec_state_at = ? WHERE task_id = ?`).run(result.legacy.status, result.legacy.pauseReason, kind,
    result.state, result.waitReason, target.effectClass, unknownSince, starting, at, taskId);
  return result.state;
}

/**
 * Writes the state a task's old columns and checkpoint already say, after a checkpoint change that came without a status change
 * (an FCA task's inbox set up after its creation). Nothing happens to a task that does not exist.
 */
export function refreshTaskState(db: DatabaseSync, taskId: string, at: string): void {
  const row = db.prepare('SELECT status, pause_reason FROM agent_tasks WHERE task_id = ?').get(taskId);
  if (!row) return;
  writeTaskState(db, taskId, { status: String(row.status), pauseReason: typeof row.pause_reason === 'string' ? row.pause_reason : null }, at);
}
