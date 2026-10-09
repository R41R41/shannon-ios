import type { DatabaseSync } from 'node:sqlite';
import type { TaskConversationSource, TaskRecord, TaskSource, TaskSourceObservation, TaskStep } from '../taskRuntimePorts.js';

/** Conversation lineage only; canonical memory content is never copied here. */
export class TaskSourceStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS fca_task_sources (
      step_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, experience_id TEXT,
      observed_at TEXT NOT NULL, recalled_ids_json TEXT NOT NULL DEFAULT '[]', read_ids_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS fca_task_source_links (
      task_id TEXT NOT NULL REFERENCES agent_tasks(task_id), step_id TEXT NOT NULL REFERENCES fca_task_sources(step_id),
      message_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(task_id,step_id,message_id));`);
    if (!db.prepare('PRAGMA table_info(fca_task_sources)').all().some(row => row.name === 'read_ids_json')) {
      db.exec("ALTER TABLE fca_task_sources ADD COLUMN read_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!db.prepare('PRAGMA table_info(fca_task_sources)').all().some(row => row.name === 'source_kind')) {
      db.exec("ALTER TABLE fca_task_sources ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'conversation'");
    }
  }
  observe(step: TaskStep, observation: TaskSourceObservation, at: string): boolean {
    const validIds = (ids: readonly string[]) => Array.isArray(ids) && ids.length <= 5000 && ids.every(id => typeof id === 'string' && /^[^\s\p{Cc}]{1,240}$/u.test(id));
    if (!/^[^\s\p{Cc}]{1,160}$/u.test(observation.observationId) || !validIds(observation.recalledMemoryIds)
      || !validIds(observation.readSourceIds ?? [])) throw new Error('FCA_SOURCE');
    const id = `memory:${step.id}:${observation.observationId}`;
    const recalled = JSON.stringify([...new Set(observation.recalledMemoryIds)].sort()), reads = JSON.stringify([...new Set(observation.readSourceIds ?? [])].sort());
    const prior = this.db.prepare('SELECT * FROM fca_task_sources WHERE step_id=?').get(id);
    if (prior) return prior.scope_key === step.scopeKey && prior.recalled_ids_json === recalled && prior.read_ids_json === reads;
    this.db.prepare("INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at,recalled_ids_json,read_ids_json,state,source_kind) VALUES(?,?,'',?,?,?,'bound','memory')")
      .run(id, step.scopeKey, at, recalled, reads);
    this.db.prepare('INSERT INTO fca_task_source_links(task_id,step_id) VALUES(?,?)').run(step.taskId, id);
    return true;
  }
  begin(task: TaskRecord, stepId: string, threadId: string, at: string): void {
    this.db.prepare('INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at) VALUES(?,?,?,?)')
      .run(stepId, task.scopeKey, threadId, at);
    this.db.prepare('INSERT INTO fca_task_source_links(task_id,step_id) VALUES(?,?)').run(task.id, stepId);
  }
  refs(task: TaskRecord, activeStepId: string | null, messageIds?: readonly string[]): TaskSource[] {
    const rows = this.db.prepare(`SELECT DISTINCT s.* FROM fca_task_sources s JOIN fca_task_source_links l ON l.step_id=s.step_id
      WHERE s.scope_key=? AND l.task_id=? AND (
        (l.message_id='' AND (?!='conversation' OR s.step_id=?)) OR
        (l.message_id!='' AND s.state='bound' AND (?!='conversation' OR EXISTS (
          SELECT 1 FROM fca_task_messages m WHERE m.scope_key=s.scope_key AND m.target_task_id=l.task_id
          AND m.message_id=l.message_id AND m.consumed_by IS NULL)) AND (?=0 OR EXISTS (
          SELECT 1 FROM fca_task_messages m WHERE m.scope_key=s.scope_key AND m.target_task_id=l.task_id
          AND m.message_id=l.message_id AND ((?!='conversation' AND m.consumed_by IS NOT NULL)
          OR m.message_id IN (SELECT value FROM json_each(?))))))) ORDER BY s.observed_at,s.step_id`)
      .all(task.scopeKey, task.id, task.kind, activeStepId, task.kind, messageIds === undefined ? 0 : 1, task.kind, JSON.stringify(messageIds ?? []));
    return rows.map(row => ({ ...(row.source_kind === 'memory' ? { kind: 'memory' as const, threadId: null, experienceId: null }
      : { threadId: String(row.thread_id), experienceId: row.experience_id as string | null }), stepId: String(row.step_id),
      observedAt: String(row.observed_at), recalledMemoryIds: JSON.parse(String(row.recalled_ids_json)) as string[],
      ...(row.read_ids_json !== '[]' ? { readSourceIds: JSON.parse(String(row.read_ids_json)) as string[] } : {}) }));
  }
  inherit(task: TaskRecord, activeStepId: string | null, targetId: string, messageId = '', messageIds?: readonly string[]): void {
    for (const source of this.refs(task, activeStepId, messageIds)) this.db.prepare(
      'INSERT OR IGNORE INTO fca_task_source_links(task_id,step_id,message_id) VALUES(?,?,?)').run(targetId, source.stepId, messageId);
  }
  hasUnboundOrigin(taskId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM fca_task_source_links l JOIN fca_task_sources s ON s.step_id=l.step_id
      WHERE l.task_id=? AND l.message_id='' AND s.state!='bound' LIMIT 1`).get(taskId));
  }
  messageVisible(taskId: string, messageId: string): boolean {
    return !this.db.prepare(`SELECT 1 FROM fca_task_source_links l JOIN fca_task_sources s ON s.step_id=l.step_id
      WHERE l.task_id=? AND l.message_id=? AND s.state!='bound' LIMIT 1`).get(taskId, messageId);
  }
  hasPendingMessage(taskId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM fca_task_messages m JOIN fca_task_source_links l
      ON l.task_id=m.target_task_id AND l.message_id=m.message_id JOIN fca_task_sources s ON s.step_id=l.step_id
      WHERE m.target_task_id=? AND m.consumed_by IS NULL AND s.state='pending' LIMIT 1`).get(taskId));
  }
  bind(scope: string, stepId: string, source: TaskConversationSource): boolean {
    return this.db.prepare(`UPDATE fca_task_sources SET experience_id=?,observed_at=?,recalled_ids_json=?,read_ids_json=?,state='bound'
      WHERE scope_key=? AND step_id=? AND thread_id=? AND state='pending'`).run(source.experienceId, source.observedAt,
        JSON.stringify(source.recalledMemoryIds), JSON.stringify(source.readSourceIds ?? []), scope, stepId, source.threadId).changes > 0;
  }
  fail(scope: string, stepId: string): void {
    this.db.prepare("UPDATE fca_task_sources SET state='failed' WHERE scope_key=? AND step_id=? AND state='pending'").run(scope, stepId);
  }
  dependents(scope: string, stepId: string, originsOnly = false): string[] {
    return this.db.prepare(`SELECT DISTINCT l.task_id FROM fca_task_source_links l JOIN fca_task_sources s ON s.step_id=l.step_id
      WHERE s.scope_key=? AND s.step_id=?${originsOnly ? " AND l.message_id=''" : ''}`).all(scope, stepId).map(row => String(row.task_id));
  }
}
