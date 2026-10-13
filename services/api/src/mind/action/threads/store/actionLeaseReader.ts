import type { DatabaseSync } from 'node:sqlite';
import type { ActionKind, ActionOrigin, ActionState, ActionView, SlotClass, SlotLimits } from '@shannon/mind';
import { liveSlotClasses, readSlotLimits } from './actionSlotColumns.js';

/** An action as its lease is read, with the resources it was admitted with (the dispatch may add more to `resources`). */
export interface ActionLeaseRecord extends ActionView {
  readonly baseResources: readonly string[];
}
/** The FCA checkpoint of a task joined with the action its step holds, read as one row (one snapshot). */
export interface CheckpointedLease {
  readonly stepId: unknown;
  readonly leaseJson: unknown;
  readonly stopRequested: unknown;
  readonly action: ActionLeaseRecord;
}

type Row = Record<string, unknown>;

/** One action row as the action store hands it out (no notification: that is presentation, never a right). */
export function actionView(input: object): ActionView {
  const r = input as Row;
  return {
    id: String(r.id), scopeKey: String(r.scope_key), kind: r.kind as ActionKind, origin: r.origin as ActionOrigin,
    sourceId: String(r.source_id), parentId: r.parent_id as string | null,
    state: r.state as ActionState, generation: Number(r.generation), holder: r.holder as string | null,
    lastHolder: r.last_holder as string | null, leaseUntil: r.lease_until as string | null,
    resources: JSON.parse(String(r.resources_json)), ownerInformed: r.owner_informed === 1,
    deadline: r.deadline as string | null, progress: r.progress as string | null, result: r.result as string | null,
    sent: r.sent === 1, failures: Number(r.failures), lastFailure: r.last_failure as string | null,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

function leaseRecord(row: Row): ActionLeaseRecord {
  return { ...actionView(row), baseResources: JSON.parse(String(row.base_resources_json)) as string[] };
}

const FCA_SOURCE = /^fca:([^:]+):[0-9]+$/u;

/** The task of an FCA step's action source (`fca:<task>:<revision>`), by the exact form the scheduler writes. */
export function fcaTaskIdOf(sourceId: string): string | undefined {
  return FCA_SOURCE.exec(sourceId)?.[1];
}

/** Whether a source belongs to the task by its prefix `fca:<task>:` (the lease checks' looser test, kept as it was). */
export function fcaSourceOf(sourceId: string, taskId: string): boolean {
  return sourceId.startsWith(`fca:${taskId}:`);
}

/**
 * The one read path of action leases outside the action store (Syzygy ADR-0009 stage 1, S1). Every read is synchronous on the
 * caller's own connection, so a caller inside its own transaction keeps that transaction as its commit fence. It never writes.
 */
export class ActionLeaseReader {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): ActionLeaseRecord | null {
    const row = this.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(id);
    return row ? leaseRecord(row) : null;
  }

  /** The action only when it belongs to the scope; another scope's action reads as missing. */
  inScope(id: string, scopeKey: string): ActionLeaseRecord | null {
    const action = this.get(id);
    return action?.scopeKey === scopeKey ? action : null;
  }

  bySource(scopeKey: string, kind: ActionKind, sourceId: string): ActionLeaseRecord | null {
    const row = this.db.prepare('SELECT * FROM mind_actions WHERE scope_key=? AND kind=? AND source_id=?').get(scopeKey, kind, sourceId);
    return row ? leaseRecord(row) : null;
  }

  /** The task an FCA step's action (agentTask, in the scope) runs for, when its source has the scheduler's exact form. */
  fcaTaskOf(id: string, scopeKey: string): string | undefined {
    const row = this.db.prepare('SELECT source_id FROM mind_actions WHERE id=? AND scope_key=? AND kind=?').get(id, scopeKey, 'agentTask');
    return typeof row?.source_id === 'string' ? fcaTaskIdOf(row.source_id) : undefined;
  }

  /**
   * The Agent Host tasks whose action closed at the unknown exit as `outcome_unknown_closed` while the task row still shows it
   * open, with the time the action closed (ADR-0009 stage 1, S5). A task is closed once: one a late Host report reopened (paused
   * again) is not closed again. Read-only; nothing before the tables exist.
   */
  closedUnknownHostTasks(): Array<{ taskId: string; closedAt: string }> {
    const tables = this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('mind_actions','agent_tasks')").get();
    if (Number(tables?.count) !== 2) return [];
    return this.db.prepare(`SELECT a.source_id, a.updated_at FROM mind_actions a JOIN agent_tasks t ON t.task_id = a.source_id
      WHERE a.kind = 'agentTask' AND a.state = 'unknown' AND a.result = 'outcome_unknown_closed'
      AND t.status NOT IN ('completed','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM agent_task_events e
        WHERE e.task_id = t.task_id AND e.event_type = 'execution.outcome_unknown_closed') ORDER BY a.updated_at, a.id LIMIT 100`).all()
      .map(row => ({ taskId: String(row.source_id), closedAt: String(row.updated_at) }));
  }

  /** The slot classes holding a slot in the scope at `at`, and the limits they are held to (ADR-0009 stage 1, S6). */
  slots(scopeKey: string, at: string): { live: SlotClass[]; limits: SlotLimits } {
    return { live: liveSlotClasses(this.db, scopeKey, at), limits: readSlotLimits(this.db) };
  }

  checkpointed(actionId: string, taskId: string): CheckpointedLease | null {
    const row = this.db.prepare(`SELECT c.step_id,c.lease_json,c.stop_requested,a.*
      FROM fca_task_checkpoints c JOIN mind_actions a ON a.id=? WHERE c.task_id=?`).get(actionId, taskId);
    if (!row) return null;
    return { stepId: row.step_id, leaseJson: row.lease_json, stopRequested: row.stop_requested, action: leaseRecord(row) };
  }

  /** Whether the action left `unknown` at its one exit (ADR-0009 D2, S5): its slot is free and nothing of it is resent. */
  unknownExited(id: string): boolean {
    const tables = this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='mind_actions'").get();
    const row = tables ? this.db.prepare('SELECT state,result FROM mind_actions WHERE id=?').get(id) : undefined;
    return row?.state === 'unknown' && ['outcome_unknown_closed', 'unknown_retired'].includes(String(row.result));
  }

  /**
   * The lifecycle operations of the scope that ran under their own Minecraft action (the source is the operation's id) and have
   * an accepted receipt, newest first, at most 50: closed values only (id, action, outcome, time). Nothing before both tables exist.
   */
  ownLifecycleReceipts(scopeKey: string): Array<{ id: string; action: string; outcome: string; observedAt: string }> {
    const tables = this.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'
      AND name IN ('mind_actions','minecraft_lifecycle_operations')`).get();
    if (Number(tables?.count) !== 2) return [];
    const rows = this.db.prepare(`SELECT o.id,json_extract(o.receipt_json,'$.action') AS action,
      json_extract(o.receipt_json,'$.outcome') AS outcome,json_extract(o.receipt_json,'$.observedAt') AS observed_at
      FROM minecraft_lifecycle_operations o JOIN mind_actions a ON a.id=o.execution_id
      WHERE a.scope_key=? AND a.kind='minecraft' AND a.source_id=o.id AND o.receipt_json IS NOT NULL
      AND json_extract(o.receipt_json,'$.outcome')!='unknown' ORDER BY o.rowid DESC LIMIT 50`).all(scopeKey);
    return rows.map(row => ({ id: String(row.id), action: String(row.action), outcome: String(row.outcome), observedAt: String(row.observed_at) }));
  }

  /**
   * One original lifecycle command per unknown action that still holds `resource` and whose command ran under the attempt
   * just before (the one the sweep closed), oldest first, at most 128.
   */
  unknownLifecycleCommands(resource: string): string[] {
    const rows = this.db.prepare(`SELECT o.command_json FROM minecraft_lifecycle_operations o JOIN mind_actions a ON a.id=o.execution_id
      WHERE a.state='unknown' AND json_extract(o.command_json,'$.authority.lease.generation')=a.generation-1
      AND json_extract(o.command_json,'$.authority.lease.holder')=a.last_holder AND EXISTS(SELECT 1 FROM json_each(a.resources_json) WHERE value=?)
      GROUP BY o.execution_id ORDER BY a.updated_at,a.id LIMIT 128`).all(resource);
    return rows.map(row => String(row.command_json));
  }
}
