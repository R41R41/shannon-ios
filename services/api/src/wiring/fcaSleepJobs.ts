import type { DatabaseSync } from 'node:sqlite';
import type { TaskRuntime, TaskSleepTicket, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { SleepFcaJob } from '../mind/sleep/sleepFcaPorts.js';
import { underWriteLock } from '../infra/sqlite/lockWaits.js';
import { parseBackgroundJobPayload } from '../infra/sqlite/sqliteStoreCodecs.js';

/** The old nightly schedule is the authority. The binding never grants owner task privileges. */
export function createFcaSleepJobs(db: DatabaseSync, ownerScope: string, now = () => new Date().toISOString()) {
  const owner = (taskId: string) => `fca-sleep:${taskId}`;
  function ticket(scope: string, jobId: string): TaskSleepTicket | null {
    if (scope !== ownerScope) return null;
    const row = db.prepare('SELECT * FROM background_jobs WHERE job_id=? AND scope_key=?').get(jobId, scope);
    if (!row || row.job_kind !== 'sleep-consolidation') return null;
    const binding = db.prepare('SELECT task_id FROM fca_task_maintenance WHERE scope_key=? AND job_id=?').get(scope, jobId);
    const fresh = row.status === 'pending' && row.attempts === 0 && String(row.available_at) <= now();
    const held = binding && row.status === 'leased' && row.lease_owner === owner(String(binding.task_id));
    if (!fresh && !held) return null;
    const payload = parseBackgroundJobPayload(String(row.payload_json));
    return payload.kind === 'sleep-consolidation' ? { jobId, dayKey: payload.dayKey, startAt: payload.startAt, endAt: payload.endAt } : null;
  }
  function job(runtime: TaskRuntime, task: TaskView): SleepFcaJob | null {
    const saved = runtime.sleepTicketForTask(task.scopeKey, task.id);
    const current = saved && ticket(task.scopeKey, saved.jobId);
    if (!saved || !current || JSON.stringify(saved) !== JSON.stringify(current)) return null;
    const row = db.prepare('SELECT lease_owner FROM background_jobs WHERE job_id=? AND scope_key=?').get(saved.jobId, task.scopeKey);
    return row?.lease_owner === owner(task.id) ? { id: saved.jobId, scopeKey: task.scopeKey, dayKey: saved.dayKey, startAt: saved.startAt, endAt: saved.endAt } : null;
  }
  function reconcile(runtime: TaskRuntime) {
    underWriteLock(db, null, '', () => {
      for (const row of db.prepare('SELECT * FROM fca_task_maintenance WHERE scope_key=?').all(ownerScope)) {
        const task = runtime.get(ownerScope, String(row.task_id));
        if (!task || !job(runtime, task)) continue;
        const at = now();
        const pending = runtime.pendingReceipts(ownerScope).some(receipt => receipt.taskId === task.id);
        if (['completed', 'failed', 'stopped'].includes(task.phase) && !pending) {
          const status = task.phase === 'completed' ? 'completed' : 'failed';
          db.prepare("UPDATE background_jobs SET status=?,completed_at=?,lease_owner=NULL,lease_until=NULL,last_error=? WHERE job_id=? AND scope_key=? AND status='leased' AND lease_owner=?")
            .run(status, at, status === 'completed' ? null : `fca_${task.phase}`, String(row.job_id), ownerScope, owner(task.id));
          const report = db.prepare('SELECT summary_json FROM sleep_runs WHERE sleep_run_id=? AND scope_key=?').get(String(row.job_id), ownerScope);
          db.prepare('UPDATE sleep_runs SET status=?,completed_at=? WHERE sleep_run_id=? AND scope_key=?').run(status, at, String(row.job_id), ownerScope);
          if (status === 'completed') {
            const metadata = report?.summary_json ? JSON.parse(String(report.summary_json)) : {};
            db.prepare('INSERT INTO experience_events(event_id,scope_key,event_type,observed_at,payload_json) VALUES(?,?,?,?,?)')
              .run(`fca-sleep-completed:${row.job_id}`, ownerScope, 'sleep.completed', at, JSON.stringify({ dayKey: row.day_key, ...metadata }));
            db.prepare('INSERT INTO activity_events(activity_id,scope_key,activity_type,title,detail,occurred_at,metadata_json) VALUES(?,?,?,?,?,?,?)')
              .run(`fca-sleep-activity:${row.job_id}`, ownerScope, 'sleep', '睡眠整理', String(row.day_key), at, JSON.stringify(metadata));
          }
        } else db.prepare("UPDATE background_jobs SET lease_until=?,last_error=? WHERE job_id=? AND status='leased' AND lease_owner=?")
          .run(new Date(Date.parse(at) + 120_000).toISOString(), task.phase === 'unknown' ? 'fca_result_unknown' : null, String(row.job_id), owner(task.id));
      }
    }, 'fca_sleep_reconcile');
  }
  function admit(runtime: TaskRuntime): TaskView | null {
    return underWriteLock(db, null, '', () => {
      // A previous night or an in-flight legacy batch keeps its scope-exclusive schedule claim.
      if (db.prepare("SELECT 1 FROM background_jobs WHERE scope_key=? AND status='leased' AND lease_until>? LIMIT 1").get(ownerScope, now())) return null;
      const row = db.prepare("SELECT job_id FROM background_jobs WHERE scope_key=? AND job_kind='sleep-consolidation' AND status='pending' AND attempts=0 AND available_at<=? ORDER BY sequence LIMIT 1").get(ownerScope, now());
      if (!row) return null;
      const task = runtime.admitSleep(ownerScope, String(row.job_id));
      if (!task) return null;
      const changed = db.prepare("UPDATE background_jobs SET status='leased',lease_owner=?,lease_until=?,attempts=1 WHERE job_id=? AND scope_key=? AND status='pending' AND attempts=0")
        .run(owner(task.id), new Date(Date.parse(now()) + 120_000).toISOString(), String(row.job_id), ownerScope);
      if (Number(changed.changes) !== 1) throw new Error('FCA_SLEEP_ADMISSION_LOST');
      return task;
    }, 'fca_sleep_admission');
  }
  return { ticket, job, allowed: (runtime: TaskRuntime, task: TaskView) => !!job(runtime, task), admit, reconcile,
    claimed: (item: SleepFcaJob) => ({ id: item.id, scopeKey: item.scopeKey,
      payload: { kind: 'sleep-consolidation' as const, dayKey: item.dayKey, startAt: item.startAt, endAt: item.endAt }, attempts: 1 }),
    workerId: (taskId: string) => owner(taskId) };
}
