import { normalizedPlaceContext, validatedPlaces, type PlaceSearchContext } from '../../../../integrations/places/placeDiscovery.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskCommit, TaskRecord, TaskStep } from '../taskRuntimePorts.js';
import { isPauseNotice, PAUSE_NOTICE_PREFIX, type TaskProgress, type TaskProgressEvent } from '../taskProgressPorts.js';

export { PAUSE_NOTICE_PREFIX };

type Report = NonNullable<TaskProgress['report']>;

/**
 * What a pause notice stands in for (M-2): the progress it replaced, with its report as it was (unread, spoken, heard). It is kept in
 * the stored row beside the notice and put back when the owner resumes the task; it never leaves the store (`read` drops it).
 */
interface Stashed { currentStep: string; status: Exclude<TaskProgress['status'], 'paused'>; updatedAt: string; report?: Report }
type Stored = TaskProgress & { resume?: Stashed };

/** Subordinate to the same task, step and action lease. No scheduler or alternate status authority. */
export class TaskProgressStore {
  constructor(private readonly db: DatabaseSync, private readonly authority: TaskAuthority, private readonly now: () => string) {
  }
  /**
   * The plan tree changed in a step (`TaskCommit.plan`, design mb-llm-centric 2.7): its flat copy for the app's task list
   * (`agent_tasks.plan_json`, at most 64 items) and the event `fca_plan_updated`, inside the step's commit transaction.
   */
  plan(step: TaskStep, plan: NonNullable<TaskCommit['plan']>): void {
    const items = plan.slice(0, 64).map(item => ({ id: String(item.id).slice(0, 40), title: String(item.title).slice(0, 80),
      status: ['pending', 'running', 'completed'].includes(item.status) ? item.status : 'pending' }));
    this.db.prepare('UPDATE agent_tasks SET plan_json=? WHERE task_id=?').run(JSON.stringify(items), step.taskId);
    const current = items.find(item => item.status === 'running')?.id ?? null;
    this.authority.event(step.scopeKey, step.taskId, 'fca_plan_updated', this.now(), {},
      { stepId: step.id, nodes: items.length, done: items.filter(item => item.status === 'completed').length, current });
  }
  admitPlaces(taskId: string, context: PlaceSearchContext, valid: () => boolean): boolean {
    return this.authority.transaction(() => {
      if (!valid()) return false;
      const closed = normalizedPlaceContext(context);
      this.db.prepare('INSERT OR IGNORE INTO fca_task_place_context VALUES(?,?)').run(taskId, JSON.stringify(closed)); return true;
    });
  }
  places(taskId: string): PlaceSearchContext | undefined {
    const row = this.db.prepare('SELECT context_json FROM fca_task_place_context WHERE task_id=?').get(taskId);
    return row ? JSON.parse(String(row.context_json)) as PlaceSearchContext : undefined;
  }
  read(taskId: string): TaskProgress | null {
    const stored = this.stored(taskId);
    if (!stored) return null;
    const { resume: _kept, ...visible } = stored;
    return visible;
  }
  private stored(taskId: string): Stored | null {
    const row = this.db.prepare('SELECT payload_json FROM fca_task_progress WHERE task_id=?').get(taskId);
    return row ? JSON.parse(String(row.payload_json)) as Stored : null;
  }
  /**
   * The runtime's own notice that a task could not finish when no step can record it (an unknown step retired after its
   * deadline): the status becomes failed and the notice becomes the report, so the owner's activity and call hear of it.
   */
  notice(scopeKey: string, taskId: string, stepId: string | null, operationId: string, text: string): void {
    this.put(scopeKey, taskId, stepId, operationId, text, 'failed');
  }
  /**
   * The report that the runtime paused a task by itself (resumable, not failed, status `paused`): the owner's activity and call hear of
   * it as they hear of a failure. Written once per key (a report with the same id is left as it is). `spoken`, when given, is the fixed
   * sentence a call says (no model rewords a pause). The report it replaces is kept and comes back when the pause is cleared. The caller
   * may hold a transaction.
   */
  pauseNotice(scopeKey: string, taskId: string, key: string, text: string, spoken?: string): boolean {
    const operationId = `${PAUSE_NOTICE_PREFIX}${key}`;
    return this.authority.transaction(() => {
      if (!this.authority.get(scopeKey, taskId) || this.read(taskId)?.report?.id === operationId) return false;
      this.put(scopeKey, taskId, null, operationId, text, 'paused', spoken);
      return true;
    });
  }
  private put(scopeKey: string, taskId: string, stepId: string | null, operationId: string, text: string, status: 'failed' | 'paused', spoken?: string): void {
    this.authority.transaction(() => {
      const at = this.now(), prior = this.stored(taskId);
      const report: Report = { id: operationId, text: text.slice(0, 2000), updatedAt: at, ...(spoken?.trim() ? { spoken: spoken.slice(0, 400) } : {}) };
      // A pause over a pause keeps what the first one stood in for; over anything else it stands in for that (a failure replaces it for good).
      const resume: Stashed | undefined = status !== 'paused' || !prior ? undefined
        : isPauseNotice(prior.report) ? prior.resume
          : { currentStep: prior.currentStep, status: prior.status as Stashed['status'], updatedAt: prior.updatedAt,
            ...(prior.report ? { report: prior.report } : {}) };
      const value: Stored = { currentStep: 'fca.result', status, startedAt: prior?.startedAt ?? at, updatedAt: at,
        findings: prior?.findings ?? [], ...(prior?.places ? { places: prior.places } : {}), report, ...(resume ? { resume } : {}) };
      this.write(taskId, stepId ?? operationId, operationId, value);
      this.authority.event(scopeKey, taskId, 'fca_progress_observed', at, {}, { stepId, operationId, tool: 'fca.result', status });
    });
  }
  /**
   * What a task's progress is once its pause notice is gone: the progress the notice replaced, with its report as it was; for a row
   * written before the notice kept it, what the task observed (findings, places) with no report; null when there is nothing left.
   */
  private unpaused(prior: Stored): Stored | null {
    const { report: _notice, resume, ...rest } = prior;
    if (resume) {
      const { currentStep, status, updatedAt, report } = resume;
      return { ...rest, currentStep, status, updatedAt, ...(report ? { report } : {}) };
    }
    if (!rest.findings.length && !rest.places?.length) return null;
    return { ...rest, status: 'running' };
  }
  /** The owner resumed the task: a pause report no longer describes it (and must not stand in for the result it will report). */
  clearPauseNotice(taskId: string): void {
    const prior = this.stored(taskId);
    if (!prior || !isPauseNotice(prior.report)) return;
    const restored = this.unpaused(prior);
    if (!restored) {
      this.db.prepare('DELETE FROM fca_task_progress WHERE task_id=?').run(taskId);
      return;
    }
    const row = this.db.prepare('SELECT step_id,operation_id FROM fca_task_progress WHERE task_id=?').get(taskId)!;
    this.write(taskId, String(row.step_id), String(row.operation_id), restored);
  }
  /**
   * A piece of work that finished without telling its parent anything (`fca_complete` with no `task.send`): its completion
   * summary becomes the report, so the owner's activity shows it and a call says it (2026-10-13: a finished weather search was
   * not said until he asked). A report already sent stays the report. The caller holds the committing transaction.
   */
  completion(scopeKey: string, task: Pick<TaskRecord, 'id' | 'kind' | 'origin'>, stepId: string, text: string): void {
    // Work the owner asked for only: not the root, a conversation or a nightly sleep.
    if (task.origin !== 'owner_request' || !['research', 'generic'].includes(task.kind) || !text.trim()) return;
    const taskId = task.id, stored = this.stored(taskId);
    // A pause report never stands in for the result, nor takes the place of a report that was there before it: that one stays.
    const prior = stored && isPauseNotice(stored.report) ? this.unpaused(stored) : stored;
    if (prior?.report) {
      if (stored !== prior) this.write(taskId, stepId, `result:${stepId}`, prior);
      return;
    }
    const at = this.now(), operationId = `result:${stepId}`;
    const report = { id: operationId, text: text.slice(0, 2000), updatedAt: at };
    const value: TaskProgress = { currentStep: 'fca.result', status: 'received', startedAt: prior?.startedAt ?? at, updatedAt: at,
      findings: prior?.findings ?? [], ...(prior?.places ? { places: prior.places } : {}), report };
    this.write(taskId, stepId, operationId, value);
    this.authority.event(scopeKey, taskId, 'fca_progress_observed', at, {}, { stepId, operationId, tool: 'fca.result', status: 'received' });
  }
  /** The short spoken form of the current report, written once; a newer report (another id) is never given an older one's. */
  speak(scopeKey: string, taskId: string, reportId: string, spoken: string): boolean {
    return this.authority.transaction(() => {
      if (!this.authority.get(scopeKey, taskId)) return false;
      const prior = this.stored(taskId);
      if (!prior?.report || prior.report.id !== reportId || prior.report.spoken || !spoken.trim()) return false;
      const row = this.db.prepare('SELECT step_id,operation_id FROM fca_task_progress WHERE task_id=?').get(taskId)!;
      this.write(taskId, String(row.step_id), String(row.operation_id), { ...prior, report: { ...prior.report, spoken: spoken.slice(0, 400) } });
      return true;
    });
  }
  /** The current report was said in the turn that asked for it: its spoken form (kept if already written) and the mark. */
  hear(scopeKey: string, taskId: string, reportId: string, spoken: string): boolean {
    return this.authority.transaction(() => {
      if (!this.authority.get(scopeKey, taskId)) return false;
      const prior = this.stored(taskId);
      if (!prior?.report || prior.report.id !== reportId || !spoken.trim()) return false;
      const row = this.db.prepare('SELECT step_id,operation_id FROM fca_task_progress WHERE task_id=?').get(taskId)!;
      const report = { ...prior.report, spoken: prior.report.spoken ?? spoken.slice(0, 400), heard: true as const };
      this.write(taskId, String(row.step_id), String(row.operation_id), { ...prior, report });
      return true;
    });
  }
  record(step: TaskStep, event: TaskProgressEvent, valid: () => boolean): boolean {
    return this.authority.transaction(() => {
      if (!valid()) return false;
      if (!/^[a-zA-Z0-9_.:-]{1,320}$/.test(event.operationId) || !/^[a-z][a-zA-Z0-9_.-]{0,199}$/.test(event.tool)
        || !['running', 'received', 'failed', 'unknown'].includes(event.status)) throw new Error('FCA_PROGRESS');
      const at = this.now(), stored = this.stored(step.taskId);
      // A step that records is a task that runs: a pause notice it finds is gone, and what it stood in for is what it builds on.
      const prior = stored && isPauseNotice(stored.report) ? this.unpaused(stored) : stored;
      // A parent-bound report is a received `task.send`; a failed one is the runtime's own notice.
      const reported = event.status === 'received' || event.status === 'failed' ? event.report : undefined;
      const sources = (event.read?.sources ?? []).filter(source => {
        try { const url = new URL(source.url); return source.url.length <= 2048 && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
      }).slice(0, 8).map(source => ({ title: source.title.slice(0, 200), url: source.url.slice(0, 2048) }));
      const findings = [...prior?.findings ?? []];
      if (event.status === 'received' && event.read?.text && sources.length) findings.push({ id: event.operationId,
        text: event.read.text.slice(0, 2000), status: 'unconfirmed', sources, updatedAt: at });
      const value: TaskProgress = { currentStep: event.tool, status: event.status,
        startedAt: event.status === 'running' ? at : prior?.startedAt ?? at, updatedAt: at,
        findings: findings.slice(-8), ...(event.read?.places ? { places: validatedPlaces(event.read.places) } : prior?.places ? { places: prior.places } : {}),
        ...(reported ? { report: { id: event.operationId, text: reported.text.slice(0, 2000), updatedAt: at } } : prior?.report ? { report: prior.report } : {}) };
      this.write(step.taskId, step.id, event.operationId, value);
      this.authority.event(step.scopeKey, step.taskId, 'fca_progress_observed', at, {}, { stepId: step.id, operationId: event.operationId, tool: event.tool, status: event.status });
      return true;
    });
  }
  private write(taskId: string, stepId: string, operationId: string, value: Stored): void {
    this.db.prepare(`INSERT INTO fca_task_progress VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE
      SET step_id=excluded.step_id,operation_id=excluded.operation_id,payload_json=excluded.payload_json`).run(taskId, stepId, operationId, JSON.stringify(value));
  }
}
