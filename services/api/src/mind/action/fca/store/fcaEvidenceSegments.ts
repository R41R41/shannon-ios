import type { DatabaseSync } from 'node:sqlite';
import type { TaskSource } from '../../taskRuntime/taskRuntimePorts.js';
import type { FcaDurableOutcome, FcaSegmentAction, FcaSegmentNotable } from '../fcaEvidencePorts.js';
import type { FcaToolCall } from '../fcaPorts.js';
import type { FcaActionExpectation, FcaExpectationComparison } from '../../../prediction/predictionPorts.js';

/**
 * Minecraft body actions are remembered as one episode per segment, not one per action (owner decision 2026-10-14, form P2(b)):
 * 「木を切ってツルハシを作った」 rather than every `mc.move-to` and pickup. A body action (`mc.*`, `minecraft.*`) that is routine
 * is held (`outcome_delivered = 2`) for its segment; the segment closes, and one episode is proposed for it, when
 * - a subgoal is set or verified (`goal.set_conditions`, `goal.verify`), a replan happens (`task.replan`), the task waits or ends
 *   (`fca.wait`, `fca.complete`), each of these then carrying the segment in its own episode; or
 * - a body action is notable, which closes the segment with itself: a failure, an outcome unknown, a prediction that missed,
 *   danger (a reflex, or a result reporting danger) or the first success of that action in this scope; or
 * - the task is paused, stopped, failed or completed without such an outcome, or its newest held action is older than
 *   `SHANNON_FCA_SEGMENT_STALE_MINUTES` (30 by default: a task left running or queued) (`heldSegmentsToClose`).
 * A held action that cannot be shown now (the owner not alone, a source withheld) keeps the segment open and is asked again at the
 * next flush, as an undelivered outcome is; it is never marked remembered unseen.
 * Other outcomes are remembered one by one as before. Nothing notable is held, so no safety-relevant outcome waits for a close.
 * The column keeps its meaning for every other row (0 undelivered, 1 delivered); no schema changes.
 */
export const HELD_FOR_SEGMENT = 2;
export const isBodyAction = (name: string) => name.startsWith('mc.') || name.startsWith('minecraft.');
const SEGMENT_CLOSERS = new Set(['goal.set_conditions', 'goal.verify', 'task.replan', 'fca.wait', 'fca.complete']);
const ENDED_STATUSES = ['paused', 'completed', 'failed', 'cancelled'];
/** How long a segment may stay open after its newest held action, in minutes, unless the environment says otherwise. */
export const FCA_SEGMENT_STALE_MINUTES = 30;
/** `SHANNON_FCA_SEGMENT_STALE_MINUTES`: a positive whole number of minutes, else the default. */
export function fcaSegmentStaleMinutes(value: string | undefined): number {
  const parsed = Number(value?.trim());
  return value?.trim() && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : FCA_SEGMENT_STALE_MINUTES;
}

/** The columns the segment rules read; `seq` is the row's rowid. */
export interface FcaSegmentRow {
  seq: number; scope_key: string; event_id: string; task_id: string; step_id: string; name: string; observation: string;
  result_json: string | null; comparison_json: string | null; expectation_json: string | null; sources_json: string;
  observed_at: string | null; goal: string; action_json: string;
}

/**
 * The durable outcome of an evidence row, and, when it closes a segment (`held` before it, or itself a body action, or `closure`
 * for a segment closed by the task's state or by time), the segment it carries. The memory episode (`fcaOutcomeEpisode.ts`) and
 * the nightly learning's check of it (`fcaSleepSegmentEvidence.ts`) both start from here.
 */
export function durableOutcomeOf(db: DatabaseSync, row: FcaSegmentRow, held: readonly FcaSegmentRow[],
  closure?: { closedBy: string; outcomeId: string }): FcaDurableOutcome {
  const result = parsed<{ ok: boolean; text: string }>(row.result_json);
  const lifecycle = row.name === 'fca.complete' || row.name === 'fca.wait';
  const actualTaskStatus = lifecycle && result ? String((JSON.parse(result.text) as { actualStatus: string }).actualStatus) : undefined;
  const members = [...held, ...isBodyAction(row.name) ? [row] : []];
  const segment = held.length || isBodyAction(row.name) || closure
    ? { actions: segmentActions(db, members), eventIds: members.map(member => member.event_id), closedBy: closure?.closedBy ?? row.name } : null;
  return { scopeKey: row.scope_key, taskId: row.task_id, stepId: row.step_id, outcomeId: closure?.outcomeId ?? row.event_id, goal: row.goal,
    action: JSON.parse(row.action_json) as FcaToolCall, expectation: parsed<FcaActionExpectation>(row.expectation_json),
    comparison: parsed<FcaExpectationComparison>(row.comparison_json), observation: row.observation as 'observed' | 'unknown',
    result, observedAt: row.observed_at!, sources: segment ? segmentSources([...held, row]) : JSON.parse(row.sources_json) as TaskSource[],
    ...(actualTaskStatus ? { actualTaskStatus } : {}), ...(segment ? { segment } : {}) };
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

/**
 * Held segments to close without a closing outcome: of a task paused, stopped, failed or completed (`task_<status>`), and of a
 * task whose newest held action was observed at or before `staleBefore` (`segment_stale`).
 */
export function heldSegmentsToClose(db: DatabaseSync, staleBefore: string): Array<{ scopeKey: string; taskId: string; closedBy: string }> {
  const rows = db.prepare(`SELECT e.scope_key,e.task_id,t.status,MAX(e.observed_at) AS newest FROM fca_action_evidence e JOIN agent_tasks t
    ON t.task_id=e.task_id AND t.scope_key=e.scope_key WHERE e.outcome_delivered=${HELD_FOR_SEGMENT} GROUP BY e.scope_key,e.task_id,t.status`)
    .all() as Array<{ scope_key: string; task_id: string; status: string; newest: string | null }>;
  return rows.flatMap(row => {
    const closedBy = ENDED_STATUSES.includes(row.status) ? `task_${row.status}` : row.newest !== null && row.newest <= staleBefore ? 'segment_stale' : null;
    return closedBy ? [{ scopeKey: row.scope_key, taskId: row.task_id, closedBy }] : [];
  });
}
/** What may close a segment without a closing outcome (`heldSegmentsToClose`). */
export const CLOSED_WITHOUT_OUTCOME = new Set([...ENDED_STATUSES.map(status => `task_${status}`), 'segment_stale']);

/** The delivered, observed evidence rows of a task named by `eventIds`, in their order (the nightly learning's segment check). */
export function deliveredEvidenceRows(db: DatabaseSync, scopeKey: string, taskId: string, eventIds: readonly string[]): FcaSegmentRow[] {
  return db.prepare(`SELECT rowid AS seq,* FROM fca_action_evidence WHERE scope_key=? AND task_id=? AND outcome_delivered=1
    AND observation='observed' AND event_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`)
    .all(scopeKey, taskId, JSON.stringify(eventIds)) as unknown as FcaSegmentRow[];
}

/**
 * The committed history's sources of an observed evidence row of an owner-requested task that is neither Codex nor sleep (the
 * nightly learning's proof of an episode's closing row), or null.
 */
export function committedEvidenceHistorySources(db: DatabaseSync, scopeKey: string, eventId: string, taskId: string): TaskSource[] | null {
  const proof = db.prepare(`SELECT h.sources_json AS history_sources FROM fca_action_evidence e
    JOIN fca_task_history h ON h.task_id=e.task_id AND h.step_id=e.step_id
    JOIN agent_tasks t ON t.task_id=e.task_id AND t.scope_key=e.scope_key
    WHERE e.scope_key=? AND e.event_id=? AND e.task_id=? AND e.observation='observed'
    AND t.fca_origin='owner_request' AND t.task_kind NOT IN ('codex','sleep')`).get(scopeKey, eventId, taskId);
  return proof ? JSON.parse(String(proof.history_sources)) as TaskSource[] : null;
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
