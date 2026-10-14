import type { CompanionStateSnapshot } from '@shannon/cognition';
import type { MemoryOpHandler, MemoryTargets } from './memoryOps.js';
import type { MemoryOp } from './memoryOpCodec.js';
import { MemoryWithholding } from './memoryVisibility.js';
import { taskExperienceId, taskExperienceSummary, type TaskExperienceRecord } from './taskExperience.js';
const recordOf = (payload: Record<string, unknown>) => payload.record as unknown as TaskExperienceRecord;
/**
 * The writer asks `blocked` before its model step and again under the file's write lock. For a task experience that check walks
 * every source of the task (2026-10-13: ~60 sources and 16 read receipts, 1-3 s), and under `BEGIN IMMEDIATE` it held the lock
 * that long: the API's synchronous writes waited (event loop blocked 3.8 s) and a research step's permit was held. Under the
 * lock the walk is repeated only when the owner's state moved since the first check (every forget or correction is a new state
 * version and update time; the number of memory controls is a further guard), so his controls are still honoured atomically.
 */
const checked = new Map<number, { key: string; result: string | null }>();
const stateKey = (state: CompanionStateSnapshot) =>
  `${state.version}\u0000${state.updatedAt}\u0000${state.memoryControls.length}`;
export const taskExperienceHandler: MemoryOpHandler = {
  revision(targets, op) {
    const record = recordOf(op.payload), id = taskExperienceId(op.scopeKey, record.taskId, record.outcomeId);
    return targets.taskExperiences?.recorded(op.scopeKey, id) ? 'recorded' : 'absent';
  },
  blocked(targets, op, state) {
    const key = stateKey(state), prior = checked.get(op.seq);
    checked.delete(op.seq);
    if (prior && prior.key === key) return prior.result;
    const result = walkedBlock(targets, op, state);
    if (checked.size >= 256) checked.clear();
    checked.set(op.seq, { key, result });
    return result;
  },
  apply(targets, op) {
    const record = recordOf(op.payload);
    targets.taskExperiences!.write(op.scopeKey, record);
    if (!targets.taskExperiences!.recorded(op.scopeKey, taskExperienceId(op.scopeKey, record.taskId, record.outcomeId))) throw new Error('TASK_EXPERIENCE_NOT_RECORDED');
    return 'task_experience_recorded';
  },
};

/**
 * How long the verdict on a task experience's sources (its read receipts and its recalled ids) is reused by another op with the same
 * sources under the same owner state. Minecraft run 7 (2026-10-14): each `task.experience` walked the same provenance for 2.7–5.7 s
 * outside the lock, beside the API on two vCPUs; the outcomes of one step carry the same sources. As the per-op reuse above, a forget
 * or a correction is a new state key and is judged afresh; a source that went away is seen once the window ends, as in the FCA guard
 * (`FCA_SOURCE_VERDICT_MS`).
 */
export const TASK_EXPERIENCE_SOURCE_VERDICT_MS = 5_000;
/**
 * Only a clear verdict is kept, with the earliest time it was found clear at. Every time-dependent rule withholds an earlier
 * observation whenever it withholds a later one (`foldFcaProvenance`), so sources clear at t are clear at every later time, and an
 * op observed earlier than that is walked.
 */
const clearSources = new Map<string, { at: number; observedFrom: string }>();
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function walkedBlock(targets: MemoryTargets, op: MemoryOp, state: CompanionStateSnapshot, now = Date.now()): string | null {
  const record = recordOf(op.payload);
  if (record.scopeKey !== op.scopeKey || !targets.taskExperiences) return 'task_experience_unavailable';
  const withholding = new MemoryWithholding(state, targets.conversations, op.scopeKey, undefined, targets.taskSourceVisible);
  const sourcesBlock = clearSourcesKnown(op, record, state, now) ? null : walkedSources(targets, op, record, withholding);
  if (sourcesBlock) return sourcesBlock;
  rememberClear(op, record, state, now);
  const prior = targets.conversations.experiencesById?.(op.scopeKey, [taskExperienceId(op.scopeKey, record.taskId, record.outcomeId)])[0];
  if (prior && withholding.withholdsExperience(prior)) return 'forgotten';
  // The experience's own words at its time; its recalled ids were judged with its sources above.
  return withholding.withholdsReply({ text: taskExperienceSummary(record), observedAt: record.observedAt }) ? 'forgotten' : null;
}

/**
 * The part of the verdict that walks: read receipts first ('source_withheld', as before), then the recalled ids at the experience's
 * time ('forgotten'). Together with the words above this is the former single check: a reply is withheld by a rule on its words or
 * by a recalled id (`MemoryWithholding.withholdsReply`); here the ids are asked with an empty text, which a rule withholds only
 * where it withholds every text.
 */
function walkedSources(targets: MemoryTargets, op: MemoryOp, record: TaskExperienceRecord, withholding: MemoryWithholding): string | null {
  if ((record.readSourceIds ?? []).some(id => !targets.taskSourceVisible?.(op.scopeKey, id, record.observedAt))) return 'source_withheld';
  return withholding.withholdsReply({ text: '', observedAt: record.observedAt, recalledMemoryIds: record.sourceIds }) ? 'forgotten' : null;
}
function sourcesKey(op: MemoryOp, record: TaskExperienceRecord, state: CompanionStateSnapshot): string {
  const sorted = (ids: readonly string[] | undefined) => [...new Set(ids ?? [])].sort();
  return JSON.stringify([op.scopeKey, stateKey(state), sorted(record.sourceIds), sorted(record.readSourceIds)]);
}
function clearSourcesKnown(op: MemoryOp, record: TaskExperienceRecord, state: CompanionStateSnapshot, now: number): boolean {
  const known = clearSources.get(sourcesKey(op, record, state));
  return Boolean(known && now >= known.at && now - known.at < TASK_EXPERIENCE_SOURCE_VERDICT_MS
    && ISO_TIME.test(record.observedAt) && record.observedAt >= known.observedFrom);
}
function rememberClear(op: MemoryOp, record: TaskExperienceRecord, state: CompanionStateSnapshot, now: number): void {
  if (!ISO_TIME.test(record.observedAt)) return;
  for (const [key, entry] of clearSources) if (now - entry.at >= TASK_EXPERIENCE_SOURCE_VERDICT_MS || now < entry.at) clearSources.delete(key);
  if (clearSources.size >= 256) clearSources.delete(clearSources.keys().next().value!);
  const key = sourcesKey(op, record, state), known = clearSources.get(key);
  // A reuse keeps the window of the walk it rests on; only a walk opens a new one.
  if (known && now >= known.at && now - known.at < TASK_EXPERIENCE_SOURCE_VERDICT_MS) {
    if (record.observedAt < known.observedFrom) clearSources.set(key, { at: known.at, observedFrom: record.observedAt });
    return;
  }
  clearSources.set(key, { at: now, observedFrom: record.observedAt });
}
