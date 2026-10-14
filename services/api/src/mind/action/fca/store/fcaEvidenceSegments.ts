import type { DatabaseSync } from 'node:sqlite';
import type { TaskSource } from '../../taskRuntime/taskRuntimePorts.js';
import type { FcaSegmentAction, FcaSegmentNotable } from '../fcaEvidencePorts.js';

/**
 * Minecraft body actions are remembered as one episode per segment, not one per action (owner decision 2026-10-14, form P2(b)):
 * 「木を切ってツルハシを作った」 rather than every `mc.move-to` and pickup. A body action (`mc.*`, `minecraft.*`) that is routine
 * is held (`outcome_delivered = 2`) for its segment; the segment closes, and one episode is proposed for it, when
 * - a subgoal is set or verified (`goal.set_conditions`, `goal.verify`), a replan happens (`task.replan`), the task waits or ends
 *   (`fca.wait`, `fca.complete`), each of these then carrying the segment in its own episode; or
 * - a body action is notable, which closes the segment with itself: a failure, an outcome unknown, a prediction that missed,
 *   danger (a reflex, or a result reporting danger) or the first success of that action in this scope; or
 * - the task is paused, stopped, failed or completed without such an outcome (`heldSegmentsOfEndedTasks`).
 * Other outcomes are remembered one by one as before. Nothing notable is held, so no safety-relevant outcome waits for a close.
 * The column keeps its meaning for every other row (0 undelivered, 1 delivered); no schema changes.
 */
export const HELD_FOR_SEGMENT = 2;
export const isBodyAction = (name: string) => name.startsWith('mc.') || name.startsWith('minecraft.');
const SEGMENT_CLOSERS = new Set(['goal.set_conditions', 'goal.verify', 'task.replan', 'fca.wait', 'fca.complete']);
const ENDED_STATUSES = ['paused', 'completed', 'failed', 'cancelled'];

/** The columns the segment rules read; `seq` is the row's rowid. */
export interface FcaSegmentRow {
  seq: number; scope_key: string; event_id: string; task_id: string; name: string; observation: string;
  result_json: string | null; comparison_json: string | null; sources_json: string;
}

/** 'hold' a routine body action, 'close' a segment with this outcome, or remember it on its own ('single') as before. */
export function segmentDisposition(db: DatabaseSync, row: FcaSegmentRow): 'hold' | 'close' | 'single' {
  if (isBodyAction(row.name)) return notableAction(db, row) ? 'close' : 'hold';
  return SEGMENT_CLOSERS.has(row.name) ? 'close' : 'single';
}

/** Why a body action is notable, or null for a routine one. */
export function notableAction(db: DatabaseSync, row: FcaSegmentRow): FcaSegmentNotable | null {
  const result = parsed<{ ok?: unknown; text?: unknown }>(row.result_json);
  if (row.observation !== 'observed' || !result) return 'unknown';
  if (result.ok !== true) return 'failure';
  if (parsed<{ mismatch?: unknown }>(row.comparison_json)?.mismatch === true) return 'mismatch';
  if (row.name.startsWith('minecraft.reflex') || reportsDanger(result.text)) return 'danger';
  const earlier = db.prepare(`SELECT 1 FROM fca_action_evidence WHERE scope_key=? AND name=? AND rowid<? AND observation='observed'
    AND json_extract(result_json,'$.ok')=1 LIMIT 1`).get(row.scope_key, row.name, row.seq);
  return earlier ? null : 'first_time';
}

/** The body actions held for this task's open segment, before `before` (a rowid), oldest first. */
export function heldRows<R extends FcaSegmentRow>(db: DatabaseSync, scopeKey: string, taskId: string, before = Number.MAX_SAFE_INTEGER): R[] {
  return db.prepare(`SELECT rowid AS seq,* FROM fca_action_evidence WHERE scope_key=? AND task_id=? AND outcome_delivered=${HELD_FOR_SEGMENT}
    AND rowid<? ORDER BY rowid`).all(scopeKey, taskId, before) as unknown as R[];
}

/** Tasks paused, stopped, failed or completed with body actions still held: each such segment closes with the task's status. */
export function heldSegmentsOfEndedTasks(db: DatabaseSync): Array<{ scopeKey: string; taskId: string; status: string }> {
  const rows = db.prepare(`SELECT DISTINCT e.scope_key,e.task_id,t.status FROM fca_action_evidence e JOIN agent_tasks t ON t.task_id=e.task_id
    AND t.scope_key=e.scope_key WHERE e.outcome_delivered=${HELD_FOR_SEGMENT} AND t.status IN (${ENDED_STATUSES.map(() => '?').join(',')})`)
    .all(...ENDED_STATUSES) as Array<{ scope_key: string; task_id: string; status: string }>;
  return rows.map(row => ({ scopeKey: row.scope_key, taskId: row.task_id, status: row.status }));
}

/** A segment's actions, closed values only. */
export function segmentActions(db: DatabaseSync, rows: readonly FcaSegmentRow[]): FcaSegmentAction[] {
  return rows.map(row => {
    const ok = parsed<{ ok?: unknown }>(row.result_json)?.ok;
    const notable = isBodyAction(row.name) ? notableAction(db, row) : null;
    return { name: row.name, ok: typeof ok === 'boolean' ? ok : null, ...(notable ? { notable } : {}) };
  });
}

/** The sources of every row of a segment, each source once (the episode's provenance: unique ids follow from them). */
export function segmentSources(rows: ReadonlyArray<{ sources_json: string }>): TaskSource[] {
  const unique = new Map<string, TaskSource>();
  for (const json of new Set(rows.map(row => row.sources_json))) {
    for (const source of JSON.parse(json) as TaskSource[]) unique.set(JSON.stringify(source, Object.keys(source).sort()), source);
  }
  return [...unique.values()];
}

/** A body's report of danger in a result: `danger: true` at its top or in its `facts` (Minebot's observation). */
function reportsDanger(text: unknown): boolean {
  if (typeof text !== 'string' || !text.includes('danger')) return false;
  const value = parsed<{ danger?: unknown; facts?: { danger?: unknown } }>(text);
  return value?.danger === true || value?.facts?.danger === true;
}
function parsed<T>(json: string | null): T | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' ? value as T : null;
  } catch { return null; }
}
