import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskQuery, TaskRecord, TaskStatus } from '../../taskRuntime/taskRuntimePorts.js';
import { underWriteLock } from '../../../../infra/sqlite/lockWaits.js';

/** Additive FCA projection on the existing task authority. Creates no Agent Host commands. */
export class SQLiteFcaTaskAuthority implements TaskAuthority {
  constructor(private readonly db: DatabaseSync) {
    const additions = [
      ['fca_kind', 'TEXT'], ['fca_parent_id', 'TEXT REFERENCES agent_tasks(task_id)'],
      ['fca_origin', 'TEXT'], ['fca_completion_criteria', "TEXT NOT NULL DEFAULT ''"],
    ];
    this.transaction(() => {
      const columns = db.prepare("PRAGMA table_info('agent_tasks')").all() as Array<{ name: string }>;
      if (!columns.length) throw new Error('FCA_AGENT_TASKS_MIGRATION_REQUIRED');
      for (const [name, definition] of additions) if (!columns.some(column => column.name === name)) {
        db.exec(`ALTER TABLE agent_tasks ADD COLUMN ${name} ${definition}`);
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_fca_root ON agent_tasks(scope_key) WHERE fca_kind='root';
        CREATE INDEX IF NOT EXISTS agent_tasks_fca_parent ON agent_tasks(scope_key,fca_parent_id);`);
    });
  }
  transaction<T>(work: () => T): T {
    return underWriteLock(this.db, null, '', work, 'fca_task_authority');
  }
  get(scopeKey: string, id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_tasks WHERE scope_key=? AND task_id=? AND fca_kind IS NOT NULL').get(scopeKey, id);
    return row ? record(row) : null;
  }
  root(scopeKey: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM agent_tasks WHERE scope_key=? AND fca_kind='root'").get(scopeKey);
    return row ? record(row) : null;
  }
  byRequest(scopeKey: string, requestKey: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_tasks WHERE scope_key=? AND start_idempotency_key=? AND fca_kind IS NOT NULL').get(scopeKey, requestKey);
    return row ? record(row) : null;
  }
  list(scopeKey: string, query: TaskQuery = {}): TaskRecord[] {
    const parentClause = query.parentId === undefined ? '' : ' AND fca_parent_id IS ?';
    const args = query.parentId === undefined ? [scopeKey] : [scopeKey, query.parentId];
    return this.db.prepare(`SELECT * FROM agent_tasks WHERE scope_key=? AND fca_kind IS NOT NULL${parentClause}
      ORDER BY ${query.order === 'recent' ? 'updated_at DESC' : 'created_at'},task_id LIMIT ? OFFSET ?`).all(...args, query.limit ?? 100, query.offset ?? 0).map(record);
  }
  create(input: Omit<TaskRecord, 'revision' | 'updatedAt'> & { requestKey: string }): TaskRecord {
    this.db.prepare(`INSERT INTO agent_tasks(task_id,scope_key,conversation_thread_id,start_idempotency_key,title,goal,status,summary,
      created_at,updated_at,pause_reason,fca_kind,fca_parent_id,fca_origin,fca_completion_criteria)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.scopeKey, `fca:${input.id}`, input.requestKey,
        input.title, input.goal, input.status, input.summary, input.createdAt, input.createdAt, input.pauseReason,
        input.kind, input.parentId, input.origin, input.completionCriteria);
    return this.event(input.scopeKey, input.id, 'fca_created', input.createdAt, {}, { parentId: input.parentId, origin: input.origin });
  }
  event(scopeKey: string, id: string, type: string, at: string,
    change: { status?: TaskStatus; pauseReason?: string | null; summary?: string } = {}, payload: Record<string, unknown> = {}): TaskRecord {
    const current = this.get(scopeKey, id);
    if (!current) throw new Error('FCA_TASK_NOT_FOUND');
    const revision = current.revision + 1;
    this.db.prepare(`UPDATE agent_tasks SET status=?,pause_reason=?,summary=?,latest_sequence=?,updated_at=? WHERE scope_key=? AND task_id=?`)
      .run(change.status ?? current.status, change.pauseReason === undefined ? current.pauseReason : change.pauseReason,
        change.summary ?? current.summary, revision, at, scopeKey, id);
    this.db.prepare(`INSERT INTO agent_task_events(event_id,task_id,sequence,event_type,title,tone,occurred_at,payload_json)
      VALUES(?,?,?,?,?,'neutral',?,?)`).run(randomUUID(), id, revision, type, type, at,
        JSON.stringify({ ...payload, taskId: id, parentId: current.parentId, revision }));
    return this.get(scopeKey, id)!;
  }
}
function record(row: Record<string, unknown>): TaskRecord {
  return { id: String(row.task_id), scopeKey: String(row.scope_key), parentId: row.fca_parent_id as string | null,
    kind: row.fca_kind as TaskRecord['kind'], origin: row.fca_origin as TaskRecord['origin'],
    title: String(row.title), goal: String(row.goal), completionCriteria: String(row.fca_completion_criteria),
    status: row.status as TaskStatus, pauseReason: row.pause_reason as string | null, summary: String(row.summary),
    revision: Number(row.latest_sequence), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
