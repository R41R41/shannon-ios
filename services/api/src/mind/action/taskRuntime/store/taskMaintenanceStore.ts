import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskRecord, TaskSleepTicket, TaskView } from '../taskRuntimePorts.js';

const GOAL = '予定された睡眠整理を既存の予算と記憶書き込み経路で進める';
const CRITERIA = '予定の各段階が確定した結果で終了している';
const SUMMARY = '睡眠整理の状態を確認しました。';
interface Options {
  authority: TaskAuthority; now(): string;
  resolve?(scope: string, jobId: string): TaskSleepTicket | null;
  root(scope: string): TaskView; view(task: TaskRecord): TaskView;
}
/** This binding identifies a schedule, never a second task status, execution lease, or budget. */
export class TaskMaintenanceStore {
  constructor(private readonly db: DatabaseSync, private readonly options: Options) {
  }
  get(scope: string, taskId: string): TaskSleepTicket | null {
    const task = this.options.authority.get(scope, taskId);
    if (task?.kind !== 'sleep' || task.origin !== 'maintenance') return null;
    const row = this.db.prepare('SELECT * FROM fca_task_maintenance WHERE scope_key=? AND task_id=?').get(scope, taskId);
    return row ? { jobId: String(row.job_id), dayKey: String(row.day_key), startAt: String(row.start_at), endAt: String(row.end_at) } : null;
  }
  /** A stopped schedule cannot be revived after its canonical job closes or changes identity. */
  resumable(scope: string, taskId: string): boolean {
    const saved = this.get(scope, taskId), current = saved && this.options.resolve?.(scope, saved.jobId);
    return !!saved && !!current && saved.jobId === current.jobId && saved.dayKey === current.dayKey
      && saved.startAt === current.startAt && saved.endAt === current.endAt;
  }
  summary(task: TaskRecord): string {
    if (!this.get(task.scopeKey, task.id)) throw new Error('FCA_SLEEP_TICKET_MISSING');
    return SUMMARY;
  }
  /** Only this immutable closed projection can cross into an ordinary task without internal sleep lineage. */
  publicOnly(task: TaskRecord): boolean {
    const ticket = this.get(task.scopeKey, task.id);
    return !!ticket && task.title === `睡眠整理 ${ticket.dayKey}` && task.goal === GOAL
      && task.completionCriteria === CRITERIA && (task.summary === '' || task.summary === SUMMARY);
  }
  /** Closed schedule receipt only. It neither copies private source lineage nor wakes an owner-origin task. */
  report(task: TaskRecord, status: string, stepId: string): void {
    const parent = task.parentId && this.options.authority.get(task.scopeKey, task.parentId);
    const ticket = this.get(task.scopeKey, task.id);
    if (!parent || !ticket || ['completed', 'failed', 'cancelled'].includes(parent.status)) return;
    const id = `result:${stepId}`, text = JSON.stringify({ kind: 'sleep', jobId: ticket.jobId, dayKey: ticket.dayKey, status });
    this.db.prepare('INSERT INTO fca_task_messages(scope_key,message_id,source_task_id,target_task_id,text,received_at) VALUES(?,?,?,?,?,?)')
      .run(task.scopeKey, id, task.id, parent.id, text, this.options.now());
    this.options.authority.event(task.scopeKey, parent.id, 'fca_message_received', this.options.now(), {}, { messageId: id, sourceTaskId: task.id });
  }
  admit(scope: string, jobId: string): TaskView | null {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(jobId)) throw new Error('FCA_SLEEP_JOB');
    if (!this.options.resolve?.(scope, jobId)) return null;
    const root = this.options.root(scope);
    return this.options.authority.transaction(() => {
      const ticket = this.options.resolve?.(scope, jobId);
      if (!ticket) return null;
      if (ticket.jobId !== jobId || !/^\d{4}-\d{2}-\d{2}$/u.test(ticket.dayKey)
        || !Number.isFinite(Date.parse(ticket.startAt)) || !Number.isFinite(Date.parse(ticket.endAt))
        || Date.parse(ticket.startAt) >= Date.parse(ticket.endAt)) throw new Error('FCA_SLEEP_TICKET');
      const existing = this.db.prepare('SELECT task_id FROM fca_task_maintenance WHERE scope_key=? AND job_id=?').get(scope, jobId);
      if (existing) {
        const id = String(existing.task_id), saved = this.get(scope, id);
        if (!saved || saved.dayKey !== ticket.dayKey || saved.startAt !== ticket.startAt || saved.endAt !== ticket.endAt) throw new Error('FCA_SLEEP_TICKET_CONFLICT');
        return this.options.view(this.options.authority.get(scope, id)!);
      }
      const parent = this.options.authority.get(scope, root.id)!;
      if (this.options.view(parent).phase !== 'waiting' && this.options.view(parent).phase !== 'ready'
        && this.options.view(parent).phase !== 'executing') return null;
      const active = Number(this.db.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE scope_key=? AND task_kind<>'codex' AND status NOT IN ('completed','failed','cancelled')").get(scope)!.count);
      if (active >= 256) throw new Error('FCA_ACTIVE_TASK_LIMIT');
      const task = this.options.authority.create({ id: randomUUID(), scopeKey: scope, parentId: root.id,
        kind: 'sleep', origin: 'maintenance', title: `睡眠整理 ${ticket.dayKey}`,
        goal: GOAL, completionCriteria: CRITERIA,
        status: 'queued', pauseReason: null, summary: '', requestKey: `fca:sleep:${jobId}`, createdAt: this.options.now() });
      this.db.prepare('INSERT INTO fca_task_maintenance(task_id,scope_key,job_id,day_key,start_at,end_at) VALUES(?,?,?,?,?,?)')
        .run(task.id, scope, ticket.jobId, ticket.dayKey, ticket.startAt, ticket.endAt);
      this.db.prepare('INSERT INTO fca_task_checkpoints(task_id) VALUES(?)').run(task.id);
      this.options.authority.event(scope, root.id, 'fca_sleep_admitted', this.options.now(), {}, { childId: task.id, jobId });
      return this.options.view(task);
    });
  }
}
