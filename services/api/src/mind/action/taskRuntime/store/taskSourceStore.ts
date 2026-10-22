import type { DatabaseSync } from 'node:sqlite';
import { namedWork } from '../../../../infra/observer/eventLoopWatch.js';
import { cachedTaskSourceOfRow } from '../../../../infra/sqlite/fcaProvenanceSets.js';
import type { TaskConversationSource, TaskRecord, TaskSource, TaskSourceObservation, TaskStep } from '../taskRuntimePorts.js';

/** Conversation lineage only; canonical memory content is never copied here. */
export class TaskSourceStore {
  constructor(private readonly db: DatabaseSync) {
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
    const pendingRuns = rows.some(row => row.state === 'pending') && this.runsOnPendingOrigin(task.id);
    // r9: a memory row (never changed) is handed as the source it was last read as, while it reads the same (`cachedTaskSourceOfRow`).
    return namedWork('task_sources', () => rows.map(row => cachedTaskSourceOfRow(this.db, row, pendingRuns && row.state === 'pending')));
  }
  inherit(task: TaskRecord, activeStepId: string | null, targetId: string, messageId = '', messageIds?: readonly string[]): void {
    for (const source of this.refs(task, activeStepId, messageIds)) this.db.prepare(
      'INSERT OR IGNORE INTO fca_task_source_links(task_id,step_id,message_id) VALUES(?,?,?)').run(targetId, source.stepId, messageId);
  }
  /**
   * Conversation work (the owner's 「調べて」: a research task whose context is the turn's `[Conversation work]`) runs while the
   * turn it was made in is still in progress (owner decision 2026-10-13: it starts at once and its provenance binds afterwards;
   * before, it waited ~12 s for a voice turn to finish). A failed turn still holds it, and stops it (`failConversation`).
   */
  runsOnPendingOrigin(taskId: string): boolean {
    // `fca_kind` here is the common runtime's own subtype (research, not generic work), never a split between task models.
    const row = this.db.prepare(`SELECT m.text AS text FROM agent_tasks t JOIN fca_task_messages m
      ON m.target_task_id=t.task_id AND m.message_id='context:'||t.task_id WHERE t.task_id=? AND t.fca_kind='research'`).get(taskId);
    return typeof row?.text === 'string' && row.text.startsWith('[Conversation work]');
  }
  /** What a link's source must be for the task to use it: bound, or (conversation work) not failed. */
  private unusable(taskId: string): string {
    return this.runsOnPendingOrigin(taskId) ? "s.state='failed'" : "s.state!='bound'";
  }
  hasUnboundOrigin(taskId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM fca_task_source_links l JOIN fca_task_sources s ON s.step_id=l.step_id
      WHERE l.task_id=? AND l.message_id='' AND ${this.unusable(taskId)} LIMIT 1`).get(taskId));
  }
  /**
   * What a lost origin turn does to a dependent: an unknown stays unknown (S5); conversation work already running on the turn (it
   * no longer waits for the bind) is stopped through its step like any stop; anything else is paused as stopped.
   */
  failedOriginStop(task: TaskRecord): { status?: 'paused'; pauseReason?: string } {
    const running = this.db.prepare('SELECT step_id FROM fca_task_checkpoints WHERE task_id=?').get(task.id)?.step_id;
    return task.pauseReason === 'fca_unknown' || running ? {} : { status: 'paused', pauseReason: 'fca_stopped' };
  }
  messageVisible(taskId: string, messageId: string): boolean {
    return !this.db.prepare(`SELECT 1 FROM fca_task_source_links l JOIN fca_task_sources s ON s.step_id=l.step_id
      WHERE l.task_id=? AND l.message_id=? AND ${this.unusable(taskId)} LIMIT 1`).get(taskId, messageId);
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
