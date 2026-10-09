import type { DatabaseSync } from 'node:sqlite';
import { TASK_EXPERIENCE_DISCLOSURE, taskExperienceId, taskExperienceSummary, type TaskExperienceRecord, type TaskExperienceWriter } from '../taskExperience.js';
/** Owned by the existing memory writer and its transaction. Search indexing is the existing experience trigger. */
export class SQLiteTaskExperiences implements TaskExperienceWriter {
  constructor(private readonly db: DatabaseSync) {}
  write(scope: string, record: TaskExperienceRecord): boolean {
    if (scope !== record.scopeKey) throw new Error('TASK_EXPERIENCE_SCOPE');
    const id = taskExperienceId(scope, record.taskId, record.outcomeId);
    const prior = this.db.prepare("SELECT payload_json FROM experience_events WHERE event_id=? AND scope_key=? AND event_type='turn.completed'").get(id, scope);
    let sources = record.sourceIds, reads = record.readSourceIds ?? [];
    if (prior) {
      const payload = JSON.parse(String(prior.payload_json)) as { task?: TaskExperienceRecord };
      if (!payload.task || payload.task.status !== 'unobserved' || record.status === 'unobserved') return false;
      const original = payload.task;
      if (['goal', 'context', 'action', 'prediction'].some(key => original[key as keyof TaskExperienceRecord] !== record[key as keyof TaskExperienceRecord])) throw new Error('TASK_EXPERIENCE_CONFLICT');
      sources = [...new Set([...original.sourceIds, ...sources])]; reads = [...new Set([...(original.readSourceIds ?? []), ...reads])];
      // Keep the original observation as an audit event, not another searchable episode.
      this.db.prepare("INSERT OR IGNORE INTO experience_events(event_id,scope_key,event_type,observed_at,payload_json) VALUES(?,?,'task.outcome.prior',?,?)")
        .run(`${id}:prior`, scope, original.observedAt, String(prior.payload_json));
    }
    const payload = JSON.stringify({ source: 'fca.task', userMessage: `task-evidence-${id}`, shannonReply: '', summary: taskExperienceSummary(record),
      recalledMemoryIds: sources, readSourceIds: reads, disclosure: TASK_EXPERIENCE_DISCLOSURE, task: { ...record, sourceIds: sources, readSourceIds: reads } });
    return prior ? this.db.prepare('UPDATE experience_events SET payload_json=?,observed_at=? WHERE event_id=? AND scope_key=?').run(payload, record.observedAt, id, scope).changes > 0
      : this.db.prepare("INSERT INTO experience_events(event_id,scope_key,event_type,observed_at,payload_json) VALUES(?,?,'turn.completed',?,?)")
        .run(id, scope, record.observedAt, payload).changes > 0;

  }
  recorded(scope: string, id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM experience_events WHERE event_id=? AND scope_key=?
      AND event_type='turn.completed' AND json_extract(payload_json,'$.source')='fca.task'`).get(id, scope));
  }
}
