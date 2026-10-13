import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskAuthority, TaskView } from '../taskRuntimePorts.js';

/** Own-time tasks of the Executive open at once. */
export const OWN_TIME_OPEN_TASKS = 2;
const ACTIVE_TASKS = 256;

/**
 * One own-time task of the Executive (Syzygy ADR-0009 stage 2, E4): under the root for its tree, but of origin `own_time`, with no
 * source of the root's (nothing of a conversation is inherited) and no result sent to the root when it ends (the runtime's commit
 * tells only an owner's request's parent; the Executive reads the end itself). At most two open at once; idempotent by the
 * deliberation's id. The worker admits it on the shared file; the API process runs it.
 */
export class TaskOwnTimeStore {
  constructor(private readonly db: DatabaseSync, private readonly options: {
    authority: TaskAuthority; now(): string; ensureRoot(scopeKey: string): TaskView; get(scopeKey: string, id: string): TaskView | null;
  }) {}

  create(scopeKey: string, spec: { title: string; goal: string; kind: 'research' | 'generic'; capability: string }, requestId: string): TaskView {
    const bounds = [[requestId, 160, 'REQUEST'], [spec.title, 240, 'TITLE'], [spec.goal, 16_000, 'GOAL'], [spec.capability, 80, 'CAPABILITY']] as const;
    for (const [value, maximum, code] of bounds) {
      if (!value.trim() || value.length > maximum) throw new Error(`FCA_${code}`);
    }
    const root = this.options.ensureRoot(scopeKey);
    const { authority } = this.options;
    return authority.transaction(() => {
      const requestKey = `fca:own:${requestId}`;
      const known = authority.byRequest(scopeKey, requestKey);
      if (known) return this.options.get(scopeKey, known.id)!;
      const open = this.db.prepare(`SELECT fca_origin AS origin, COUNT(*) AS n FROM agent_tasks WHERE scope_key = ? AND fca_kind IS NOT NULL
        AND status NOT IN ('completed', 'failed', 'cancelled') GROUP BY fca_origin`).all(scopeKey);
      const count = (origin?: string) => open.filter(row => !origin || row.origin === origin).reduce((sum, row) => sum + Number(row.n), 0);
      if (count('own_time') >= OWN_TIME_OPEN_TASKS) throw new Error('FCA_OWN_TIME_LIMIT');
      if (count() >= ACTIVE_TASKS) throw new Error('FCA_ACTIVE_TASK_LIMIT');
      const task = authority.create({ id: randomUUID(), scopeKey, parentId: root.id, kind: spec.kind, origin: 'own_time', title: spec.title,
        goal: spec.goal, completionCriteria: '', status: 'queued', pauseReason: null, summary: '', requestKey, createdAt: this.options.now(),
        capability: spec.capability });
      this.db.prepare('INSERT INTO fca_task_checkpoints(task_id,wait_reason) VALUES(?,NULL)').run(task.id);
      authority.refresh?.(task.id, this.options.now());
      return this.options.get(scopeKey, task.id)!;
    });
  }

}
