import type { FcaDurableOutcome, FcaSegment } from './fcaEvidencePorts.js';
import type { TaskExperienceRecord } from '../../memory/taskMemoryPorts.js';

/** The fixed words of a completion that was not verified and went back to work: not achieved. */
export const UNVERIFIED_COMPLETION = '未達: 完了にしようとしたが、達成を新しい観測で確かめられず、続きに戻った。目的はまだ果たしていない。';
/** Turned back: the completion went back to work (queued), not a wait for children (unning/waiting) nor an end of the task. */
const unverifiedCompletion = (outcome: FcaDurableOutcome) => outcome.action.name === 'fca.complete' && outcome.actualTaskStatus === 'queued';
/** Pure lookup/open operations are working history, not another independent life episode. */
const LOOKUPS = ['tool.open', 'task.list', 'task.get', 'memory.search', 'memory.read'];

/**
 * The task episode an outcome is remembered as (`fcaSharedWiring.ts` proposes it to the memory outbox), or null. An outcome on its
 * own as before; an outcome that closes a segment of body actions (`fcaEvidenceSegments.ts`) is one episode of the whole segment,
 * whatever closed it (a wait, too): its action names each action as a closed name and count (`segmentLine`), its result is the
 * closing outcome's. Provenance: each source id once.
 */
export function fcaOutcomeEpisode(outcome: FcaDurableOutcome): TaskExperienceRecord | null {
  const segment = outcome.segment;
  if (!segment && LOOKUPS.includes(outcome.action.name)) return null;
  const actualStatus = outcome.actualTaskStatus;
  // A completion request with unfinished children is a wait, not an achieved goal.
  if (!segment && actualStatus && !['completed', 'failed', 'cancelled'].includes(actualStatus)) return null;
  const sourceIds = [...new Set(outcome.sources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]))];
  const readSourceIds = [...new Set(outcome.sources.flatMap(source => source.readSourceIds ?? []))];
  // A segment of one action (a notable action with nothing held before it) reads as that action, as before.
  const gathered = segment && (segment.actions.length > 1 || !segment.actions.some(action => action.name === outcome.action.name));
  return { scopeKey: outcome.scopeKey, taskId: outcome.taskId, outcomeId: outcome.outcomeId, observedAt: outcome.observedAt,
    status: segment ? segmentStatus(outcome, segment) : outcomeStatus(outcome), goal: outcome.goal.slice(0, 1000), context: `task:${outcome.taskId}`,
    action: (gathered ? JSON.stringify({ segment: segmentLine(segment), closedWith: outcome.action }) : JSON.stringify(outcome.action)).slice(0, 1000),
    prediction: outcome.expectation ? JSON.stringify(outcome.expectation).slice(0, 1000) : '',
    observedResult: outcome.result?.text.slice(0, 4000) ?? '',
    interpretation: unverifiedCompletion(outcome) ? UNVERIFIED_COMPLETION
      : outcome.comparison ? JSON.stringify(outcome.comparison).slice(0, 2000) : '結果はこの操作の観測であり、目的全体の達成や原因の証明ではない。',
    sourceIds, readSourceIds, ...(gathered ? { segment: { eventIds: segment.eventIds, closedBy: segment.closedBy } } : {}) };
}

function outcomeStatus(outcome: FcaDurableOutcome): TaskExperienceRecord['status'] {
  const actualStatus = outcome.actualTaskStatus;
  if (actualStatus === 'cancelled') return 'cancelled';
  if (actualStatus === 'failed') return 'failure';
  if (actualStatus === 'completed') return 'success';
  return outcome.result ? outcome.result.ok ? 'success' : 'failure' : 'unobserved';
}

/** A segment closed by the task's end takes its status; otherwise what closed it, a failed or unknown body action included. */
function segmentStatus(outcome: FcaDurableOutcome, segment: FcaSegment): TaskExperienceRecord['status'] {
  if (['completed', 'failed', 'cancelled'].includes(outcome.actualTaskStatus ?? '')) return outcomeStatus(outcome);
  // A completion the task did not take (not verified: it went back to work) is no success of the segment (Minecraft run 17: three
  // such were remembered as `[success] complete: …未達成です` and recalled as done later).
  if (unverifiedCompletion(outcome)) return 'failure';
  if (segment.actions.some(action => action.notable === 'failure')) return 'failure';
  if (segment.actions.some(action => action.notable === 'unknown')) return 'unobserved';
  return outcome.result && !outcome.result.ok ? 'failure' : 'success';
}

/** The segment's actions as names and counts in the order they first came, and what was notable: closed values only. */
export function segmentLine(segment: FcaSegment): string {
  const counts = new Map<string, number>(), notable = new Map<string, number>();
  for (const action of segment.actions) {
    counts.set(action.name, (counts.get(action.name) ?? 0) + 1);
    if (action.notable) notable.set(action.notable, (notable.get(action.notable) ?? 0) + 1);
  }
  const names = [...counts].slice(0, 16).map(([name, count]) => `${name}×${count}`).join(', ');
  const more = counts.size > 16 ? ` ほか${counts.size - 16}種` : '';
  const marks = [...notable].map(([kind, count]) => `${kind}×${count}`).join(', ');
  return `身体の行動${segment.actions.length}件（${names}${more}）${marks ? ` 注目: ${marks}` : ''} 区切り: ${segment.closedBy}`;
}
