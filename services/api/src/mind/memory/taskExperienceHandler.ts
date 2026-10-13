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

function walkedBlock(targets: MemoryTargets, op: MemoryOp, state: CompanionStateSnapshot): string | null {
  const record = recordOf(op.payload);
  if (record.scopeKey !== op.scopeKey || !targets.taskExperiences) return 'task_experience_unavailable';
  if ((record.readSourceIds ?? []).some(id => !targets.taskSourceVisible?.(op.scopeKey, id, record.observedAt))) return 'source_withheld';
  const withholding = new MemoryWithholding(state, targets.conversations, op.scopeKey, undefined, targets.taskSourceVisible);
  const prior = targets.conversations.experiencesById?.(op.scopeKey, [taskExperienceId(op.scopeKey, record.taskId, record.outcomeId)])[0];
  if (prior && withholding.withholdsExperience(prior)) return 'forgotten';
  return withholding.withholdsReply({ text: taskExperienceSummary(record),
    observedAt: record.observedAt, recalledMemoryIds: record.sourceIds }) ? 'forgotten' : null;
}
