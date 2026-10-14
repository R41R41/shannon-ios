import type { DatabaseSync } from 'node:sqlite';
import type { TaskSource } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { TaskExperienceRecord } from '../mind/memory/taskExperience.js';
import { fcaOutcomeEpisode } from '../mind/action/fca/fcaOutcomeEpisode.js';
import { CLOSED_WITHOUT_OUTCOME, deliveredEvidenceRows, durableOutcomeOf, isBodyAction } from '../mind/action/fca/store/fcaEvidenceSegments.js';
import type { FcaSegmentRow } from '../mind/action/fca/store/fcaEvidenceSegments.js';

/** The closing evidence row of a segment episode: its outcome id, or the segment's last action for a segment closed without one. */
export function segmentClosingId(record: TaskExperienceRecord): string {
  return record.segment && CLOSED_WITHOUT_OUTCOME.has(record.segment.closedBy) && record.outcomeId.endsWith(':segment')
    ? record.outcomeId.slice(0, -':segment'.length) : record.outcomeId;
}

/**
 * A segment episode of a Minecraft body (owner decision 2026-10-14, `fcaEvidenceSegments.ts`) as the nightly learning may use it:
 * its closing row and each of its actions' rows, named by id, are this task's delivered evidence in their order; the episode is
 * rebuilt from them exactly as the evidence store builds it (`durableOutcomeOf`, `fcaOutcomeEpisode`), its status the derived one,
 * and must be the stored record field for field (its source ids as a set). A forged or mismatched segment fails. Returns the
 * rows' sources (for the caller's read-receipt and lineage checks), or null.
 */
export function verifiedSegmentSources(db: DatabaseSync, scope: string, record: TaskExperienceRecord): TaskSource[] | null {
  const segment = record.segment;
  if (!segment || !distinctIds(segment.eventIds)) return null;
  const closingId = segmentClosingId(record), withoutOutcome = closingId !== record.outcomeId;
  const rows = deliveredEvidenceRows(db, scope, record.taskId, [...segment.eventIds, closingId]);
  const closing = rows.find(row => row.event_id === closingId);
  if (!closing || (!withoutOutcome && segment.closedBy !== closing.name)) return null;
  const members = rows.filter(row => segment.eventIds.includes(row.event_id));
  if (!membersInOrder(segment.eventIds, closing, members, withoutOutcome)) return null;
  const held = members.filter(row => row.event_id !== closingId);
  const outcome = durableOutcomeOf(db, closing, held, withoutOutcome ? { closedBy: segment.closedBy, outcomeId: record.outcomeId } : undefined);
  const expected = fcaOutcomeEpisode(outcome);
  return expected && sameRecord(expected, record) ? outcome.sources as TaskSource[] : null;
}

function distinctIds(ids: unknown): ids is readonly string[] {
  return Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length;
}
/** The rebuilt episode and the stored one: every field the same, the source ids as sets, the segment's actions in order. */
function sameRecord(expected: TaskExperienceRecord, record: TaskExperienceRecord): boolean {
  if (!sameIds(expected.sourceIds, record.sourceIds) || !sameIds(expected.readSourceIds ?? [], record.readSourceIds ?? [])) return false;
  if (!RECORD_FIELDS.every(key => expected[key] === record[key])) return false;
  return expected.segment?.closedBy === record.segment?.closedBy && sameOrder(expected.segment?.eventIds ?? [], record.segment?.eventIds ?? []);
}

/**
 * Every named action is a body action of this task, in its evidence order, none after the closing row; the closing row is the last
 * action exactly when it is a body action (always so for a segment closed without an outcome).
 */
function membersInOrder(eventIds: readonly string[], closing: FcaSegmentRow, members: readonly FcaSegmentRow[], withoutOutcome: boolean): boolean {
  if (members.length !== eventIds.length || members.some((row, index) => row.event_id !== eventIds[index] || !isBodyAction(row.name))) return false;
  if (members.some(row => row.seq > closing.seq)) return false;
  return isBodyAction(closing.name) === (eventIds.at(-1) === closing.event_id) && (!withoutOutcome || isBodyAction(closing.name));
}

const RECORD_FIELDS = ['scopeKey', 'taskId', 'outcomeId', 'observedAt', 'status', 'goal', 'context', 'action', 'prediction', 'observedResult',
  'interpretation'] as const;
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}
