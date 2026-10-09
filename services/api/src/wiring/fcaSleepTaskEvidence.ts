import type { DatabaseSync } from 'node:sqlite';
import type { TaskSource } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { taskExperienceId, taskExperienceSummary, type TaskExperienceRecord } from '../mind/memory/taskExperience.js';
import { createFcaSleepTaskLineage } from './fcaSleepTaskLineage.js';

/** A task outcome is an observation by Shannon, never a statement attributed to the owner. */
export function createFcaSleepTaskEvidence(db: DatabaseSync) {
  const transferable = createFcaSleepTaskLineage(db);
  return (scope: string, id: string): boolean => {
    if (!id.startsWith('task:')) return false;
    try {
      const row = db.prepare("SELECT payload_json,observed_at FROM experience_events WHERE scope_key=? AND event_id=? AND event_type='turn.completed'").get(scope, id);
      if (!row) return false;
      const payload = JSON.parse(String(row.payload_json)) as { source?: string; summary?: string; userMessage?: string; shannonReply?: string; task?: TaskExperienceRecord; recalledMemoryIds?: string[]; readSourceIds?: string[] };
      const record = payload.task;
      if (payload.source !== 'fca.task' || !record || record.scopeKey !== scope || !['success', 'failure'].includes(record.status)
        || record.readSourceIds?.length || id !== taskExperienceId(scope, record.taskId, record.outcomeId)
        || payload.summary !== taskExperienceSummary(record) || payload.userMessage !== `task-evidence-${id}`
        || payload.shannonReply !== '' || row.observed_at !== record.observedAt) return false;
      const proof = db.prepare(`SELECT e.result_json,e.name,e.goal,e.action_json,e.expectation_json,e.comparison_json,e.observed_at,e.sources_json,h.committed_status,h.sources_json AS history_sources FROM fca_action_evidence e
        JOIN fca_task_history h ON h.task_id=e.task_id AND h.step_id=e.step_id
        JOIN agent_tasks t ON t.task_id=e.task_id AND t.scope_key=e.scope_key
        WHERE e.scope_key=? AND e.event_id=? AND e.task_id=? AND e.observation='observed'
        AND t.fca_origin='owner_request' AND t.fca_kind IS NOT NULL AND t.fca_kind!='sleep'`).get(scope, record.outcomeId, record.taskId);
      if (!proof?.result_json) return false;
      const evidenceSources = JSON.parse(String(proof.sources_json)) as TaskSource[];
      const historySources = JSON.parse(String(proof.history_sources)) as TaskSource[];
      if ([...evidenceSources, ...historySources].some(source => source.readSourceIds?.length) || payload.readSourceIds?.length) return false;
      const ids = [...new Set(evidenceSources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]))];
      const equal = (a: readonly string[], b: readonly string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
      if (!Array.isArray(record.sourceIds) || ids.some(source => !record.sourceIds.includes(source)) || !equal(record.sourceIds, payload.recalledMemoryIds ?? [])
        || record.goal !== String(proof.goal).slice(0, 1000) || record.context !== `task:${record.taskId}`
        || record.action !== JSON.stringify(JSON.parse(String(proof.action_json))).slice(0, 1000)
        || record.prediction !== (proof.expectation_json ? JSON.stringify(JSON.parse(String(proof.expectation_json))).slice(0, 1000) : '')
        || record.interpretation !== (proof.comparison_json ? JSON.stringify(JSON.parse(String(proof.comparison_json))).slice(0, 2000) : '結果はこの操作の観測であり、目的全体の達成や原因の証明ではない。')
        || record.observedAt !== proof.observed_at) return false;
      const historyIds = historySources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]);
      if (!transferable(scope, [...record.sourceIds, ...ids, ...historyIds], record.observedAt)) return false;
      const result = JSON.parse(String(proof.result_json)) as { ok: boolean; text: string };
      const lifecycle = proof.name === 'fca.complete' || proof.name === 'fca.wait';
      if (lifecycle && !['completed', 'failed'].includes(String(proof.committed_status))) return false;
      const status = lifecycle ? proof.committed_status === 'completed' ? 'success' : 'failure' : result.ok ? 'success' : 'failure';
      return record.status === status && typeof result.text === 'string' && record.observedResult === result.text.slice(0, 4000);
    } catch { return false; }
  };
}
/** Store-shaped tests without a canonical FCA database remain on their historical evidence rules. */
export function fcaSleepTaskEvidenceFor(store: object): (scope: string, id: string) => boolean {
  const accessor = (store as { fcaDatabase?: () => DatabaseSync }).fcaDatabase;
  return typeof accessor === 'function' ? createFcaSleepTaskEvidence(accessor.call(store)) : () => false;
}
