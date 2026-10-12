import { normalizedPlaceContext, validatedPlaces, type PlaceSearchContext } from '../../../../integrations/places/placeDiscovery.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskRecord, TaskStep } from '../taskRuntimePorts.js';
import type { TaskProgress, TaskProgressEvent } from '../taskProgressPorts.js';

/** Subordinate to the same task, step and action lease. No scheduler or alternate status authority. */
export class TaskProgressStore {
  constructor(private readonly db: DatabaseSync, private readonly authority: TaskAuthority, private readonly now: () => string) {
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
    const row = this.db.prepare('SELECT payload_json FROM fca_task_progress WHERE task_id=?').get(taskId);
    return row ? JSON.parse(String(row.payload_json)) as TaskProgress : null;
  }
  /**
   * The runtime's own notice that a task could not finish when no step can record it (an unknown step retired after its
   * deadline): the status becomes failed and the notice becomes the report, so the owner's activity and call hear of it.
   */
  notice(scopeKey: string, taskId: string, stepId: string | null, operationId: string, text: string): void {
    this.authority.transaction(() => {
      const at = this.now(), prior = this.read(taskId);
      const report = { id: operationId, text: text.slice(0, 2000), updatedAt: at };
      const value: TaskProgress = { currentStep: 'fca.result', status: 'failed', startedAt: prior?.startedAt ?? at, updatedAt: at,
        findings: prior?.findings ?? [], ...(prior?.places ? { places: prior.places } : {}), report };
      this.write(taskId, stepId ?? operationId, operationId, value);
      this.authority.event(scopeKey, taskId, 'fca_progress_observed', at, {}, { stepId, operationId, tool: 'fca.result', status: 'failed' });
    });
  }
  /**
   * A piece of work that finished without telling its parent anything (`fca_complete` with no `task.send`): its completion
   * summary becomes the report, so the owner's activity shows it and a call says it (2026-10-13: a finished weather search was
   * not said until he asked). A report already sent stays the report. The caller holds the committing transaction.
   */
  completion(scopeKey: string, task: Pick<TaskRecord, 'id' | 'kind' | 'origin'>, stepId: string, text: string): void {
    // Work the owner asked for only: not the root, a conversation or a nightly sleep.
    if (task.origin !== 'owner_request' || !['research', 'generic'].includes(task.kind) || !text.trim()) return;
    const taskId = task.id, prior = this.read(taskId);
    if (prior?.report) return;
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
      const prior = this.read(taskId);
      if (!prior?.report || prior.report.id !== reportId || prior.report.spoken || !spoken.trim()) return false;
      const row = this.db.prepare('SELECT step_id,operation_id FROM fca_task_progress WHERE task_id=?').get(taskId)!;
      this.write(taskId, String(row.step_id), String(row.operation_id), { ...prior, report: { ...prior.report, spoken: spoken.slice(0, 400) } });
      return true;
    });
  }
  record(step: TaskStep, event: TaskProgressEvent, valid: () => boolean): boolean {
    return this.authority.transaction(() => {
      if (!valid()) return false;
      if (!/^[a-zA-Z0-9_.:-]{1,320}$/.test(event.operationId) || !/^[a-z][a-zA-Z0-9_.-]{0,199}$/.test(event.tool)
        || !['running', 'received', 'failed', 'unknown'].includes(event.status)) throw new Error('FCA_PROGRESS');
      const at = this.now(), prior = this.read(step.taskId);
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
  private write(taskId: string, stepId: string, operationId: string, value: TaskProgress): void {
    this.db.prepare(`INSERT INTO fca_task_progress VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE
      SET step_id=excluded.step_id,operation_id=excluded.operation_id,payload_json=excluded.payload_json`).run(taskId, stepId, operationId, JSON.stringify(value));
  }
}
