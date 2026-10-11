import { normalizedPlaceContext, validatedPlaces, type PlaceSearchContext } from '../../../../integrations/places/placeDiscovery.js';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskStep } from '../taskRuntimePorts.js';
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
  record(step: TaskStep, event: TaskProgressEvent, valid: () => boolean): boolean {
    return this.authority.transaction(() => {
      if (!valid()) return false;
      if (!/^[a-zA-Z0-9_.:-]{1,320}$/.test(event.operationId) || !/^[a-z][a-zA-Z0-9_.-]{0,199}$/.test(event.tool)
        || !['running', 'received', 'failed', 'unknown'].includes(event.status)) throw new Error('FCA_PROGRESS');
      const at = this.now(), prior = this.read(step.taskId);
      const sources = (event.read?.sources ?? []).filter(source => {
        try { const url = new URL(source.url); return source.url.length <= 2048 && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
      }).slice(0, 8).map(source => ({ title: source.title.slice(0, 200), url: source.url.slice(0, 2048) }));
      const findings = [...prior?.findings ?? []];
      if (event.status === 'received' && event.read?.text && sources.length) findings.push({ id: event.operationId,
        text: event.read.text.slice(0, 2000), status: 'unconfirmed', sources, updatedAt: at });
      const value: TaskProgress = { currentStep: event.tool, status: event.status,
        startedAt: event.status === 'running' ? at : prior?.startedAt ?? at, updatedAt: at,
        findings: findings.slice(-8), ...(event.read?.places ? { places: validatedPlaces(event.read.places) } : prior?.places ? { places: prior.places } : {}),
        ...(event.report && event.status === 'received' ? { report: { id: event.operationId, text: event.report.text.slice(0, 2000), updatedAt: at } } : prior?.report ? { report: prior.report } : {}) };
      this.db.prepare('INSERT INTO fca_task_progress VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET step_id=excluded.step_id,operation_id=excluded.operation_id,payload_json=excluded.payload_json')
        .run(step.taskId, step.id, event.operationId, JSON.stringify(value));
      this.authority.event(step.scopeKey, step.taskId, 'fca_progress_observed', at, {}, { stepId: step.id, operationId: event.operationId, tool: event.tool, status: event.status });
      return true;
    });
  }
}
