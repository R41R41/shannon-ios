import type { MemoryOpHandler } from './memoryOps.js';
import { MemoryWithholding } from './memoryVisibility.js';
import { taskExperienceId, taskExperienceSummary, type TaskExperienceRecord } from './taskExperience.js';
const recordOf = (payload: Record<string, unknown>) => payload.record as unknown as TaskExperienceRecord;
export const taskExperienceHandler: MemoryOpHandler = {
  revision(targets, op) {
    const record = recordOf(op.payload), id = taskExperienceId(op.scopeKey, record.taskId, record.outcomeId);
    return targets.taskExperiences?.recorded(op.scopeKey, id) ? 'recorded' : 'absent';
  },
  blocked(targets, op, state) {
    const record = recordOf(op.payload);
    if (record.scopeKey !== op.scopeKey || !targets.taskExperiences) return 'task_experience_unavailable';
    if ((record.readSourceIds ?? []).some(id => !targets.taskSourceVisible?.(op.scopeKey, id, record.observedAt))) return 'source_withheld';
    const withholding = new MemoryWithholding(state, targets.conversations, op.scopeKey, undefined, targets.taskSourceVisible);
    const prior = targets.conversations.experiencesById?.(op.scopeKey, [taskExperienceId(op.scopeKey, record.taskId, record.outcomeId)])[0];
    if (prior && withholding.withholdsExperience(prior)) return 'forgotten';
    return withholding.withholdsReply({ text: taskExperienceSummary(record),
      observedAt: record.observedAt, recalledMemoryIds: record.sourceIds }) ? 'forgotten' : null;
  },
  apply(targets, op) {
    const record = recordOf(op.payload);
    targets.taskExperiences!.write(op.scopeKey, record);
    if (!targets.taskExperiences!.recorded(op.scopeKey, taskExperienceId(op.scopeKey, record.taskId, record.outcomeId))) throw new Error('TASK_EXPERIENCE_NOT_RECORDED');
    return 'task_experience_recorded';
  },
};
