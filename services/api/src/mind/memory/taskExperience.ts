import { createHash } from 'node:crypto';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import type { MemoryOpDraft } from './memoryOpCodec.js';
export type TaskExperienceOutcome = 'success' | 'failure' | 'cancelled' | 'unobserved';
export interface TaskExperienceRecord {
  scopeKey: string; taskId: string; outcomeId: string; observedAt: string; status: TaskExperienceOutcome;
  goal: string; context: string; action: string; prediction: string; observedResult: string; interpretation: string;
  sourceIds: readonly string[]; readSourceIds?: readonly string[];
  /**
   * A Minecraft body's segment (owner decision 2026-10-14): the evidence rows of its actions and what closed it, so that the nightly
   * learning can match the episode to them (`fcaSleepSegmentEvidence.ts`). Absent on an episode of one outcome.
   */
  segment?: { eventIds: readonly string[]; closedBy: string };
}
export interface TaskExperienceWriter {
  write(scopeKey: string, record: TaskExperienceRecord): boolean;
  recorded(scopeKey: string, id: string): boolean;
}
export function taskExperienceId(scope: string, taskId: string, outcomeId: string): string {
  const hex = createHash('sha256').update(JSON.stringify([scope, taskId, outcomeId])).digest('hex');
  return `task:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function taskExperienceDraft(record: TaskExperienceRecord): MemoryOpDraft {
  const id = taskExperienceId(record.scopeKey, record.taskId, record.outcomeId);
  return { opId: `${id}:${record.status}`, scopeKey: record.scopeKey, kind: 'task.experience', origin: 'task', subjectKey: `experience:${id}`,
    payload: { record }, episodeIds: record.sourceIds, disclosure: TASK_EXPERIENCE_DISCLOSURE };
}
export const TASK_EXPERIENCE_DISCLOSURE = Object.freeze({ audience: OWNER_AUDIENCE, sensitivity: 'sensitive' as const,
  reason: '所有者の依頼で行ったタスクの経験', decidedBy: 'rule' as const, speaker: 'unknown' as const });
export function taskExperienceSummary(record: TaskExperienceRecord): string {
  return `タスク経験 [${record.status}] 目的: ${record.goal}\n行動: ${record.action}\n観測結果: ${record.observedResult || '未観測'}\n解釈: ${record.interpretation}`;
}
