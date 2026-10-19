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
/** A step of an FCA task whose outcome was lost, with the lease it ran under (`ActionLeaseReader.lostFcaSteps`). */
export interface LostFcaStep {
  actionId: string; taskId: string; lease: { id: string; generation: number; holder: string };
  /** When the lost step began (its `fca_step_started` event), or null. */
  startedAt: string | null;
  /**
   * When the step was last known alive: the end of its lease while the action still records it, else the latest sign of life it left
   * (the newest progress observation of its task or body operation of its lease, never past the sweep), else the step's start. Never
   * "when the recovery noticed": a swept action loses its lease end, and a request is not made young by a reboot, nor a long step old.
   */
  lostAt: string | null;
}
/** How an accepted lifecycle operation ended (`lifecycleOutcomes`). */
export type LifecycleOutcome = 'completed' | 'refused' | 'cancelled' | 'not_started' | 'unknown';

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

  /**
   * A conversation's lifecycle actions (source `lifecycle:<sha256>`) that closed without starting their operation
   * (`lifecycle_not_started:<action>:<reason>`), newest first, at most 50: the operation's id, the result code and when.
   */
  notStartedLifecycle(scopeKey: string): Array<{ id: string; result: string; at: string }> {
    const tables = this.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='mind_actions'").get();
    if (!tables) return [];
    return this.db.prepare(`SELECT source_id,result,updated_at FROM mind_actions WHERE scope_key=? AND kind='minecraft'
      AND source_id LIKE 'lifecycle:%' AND result LIKE 'lifecycle_not_started:%' ORDER BY updated_at DESC LIMIT 50`).all(scopeKey)
      .map(row => ({ id: String(row.source_id), result: String(row.result), at: String(row.updated_at) }));
  }

  /**
   * The lifecycle operations of the scope that ran under their own Minecraft action and left `unknown` at its one exit
   * (`outcome_unknown_closed`) with no accepted receipt, newest first, at most 50: id, action and the time of the exit.
   */
  unknownExitedLifecycle(scopeKey: string): Array<{ id: string; action: string; at: string }> {
    const tables = this.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'
      AND name IN ('mind_actions','minecraft_lifecycle_operations')`).get();
    if (Number(tables?.count) !== 2) return [];
    return this.db.prepare(`SELECT o.id,json_extract(o.command_json,'$.action') AS action,a.updated_at FROM minecraft_lifecycle_operations o
      JOIN mind_actions a ON a.id=o.execution_id WHERE a.scope_key=? AND a.kind='minecraft' AND a.source_id=o.id AND a.state='unknown'
      AND a.result='outcome_unknown_closed' AND (o.receipt_json IS NULL OR json_extract(o.receipt_json,'$.outcome')='unknown')
      ORDER BY a.updated_at DESC LIMIT 50`).all(scopeKey)
      .map(row => ({ id: String(row.id), action: String(row.action), at: String(row.updated_at) }));
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
   * How each of these lifecycle operations of the scope ended, as far as known now (the 2026-10-14 incident: a login accepted in
   * one voice turn completed two seconds later, and her next turn read only 「受け付けた」 and a failed first attempt). Closed
   * values only: `completed`, `refused` or `cancelled` from an accepted receipt; `not_started` when its own action closed before
   * the operation began; `unknown` when it left at the unknown exit, or closed without an accepted receipt. An operation still
   * running (or one this scope never ran under its own action) is absent. Null when the tables are not there (nothing can be
   * known). Every id is read, in pages of 100.
   */
  lifecycleOutcomes(scopeKey: string, ids: readonly string[]): Map<string, LifecycleOutcome> | null {
    const tables = this.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'
      AND name IN ('mind_actions','minecraft_lifecycle_operations')`).get();
    if (Number(tables?.count) !== 2) return null;
    const wanted = [...new Set(ids)].filter(id => /^lifecycle:[a-f0-9]{64}$/u.test(id));
    const outcomes = new Map<string, LifecycleOutcome>();
    for (let start = 0; start < wanted.length; start += 100) {
      const page = wanted.slice(start, start + 100);
      const rows = this.db.prepare(`SELECT a.source_id,a.state,a.result,json_extract(o.receipt_json,'$.outcome') AS outcome
        FROM mind_actions a LEFT JOIN minecraft_lifecycle_operations o ON o.id=a.source_id AND o.execution_id=a.id
        WHERE a.scope_key=? AND a.kind='minecraft' AND a.source_id IN (${page.map(() => '?').join(',')})`).all(scopeKey, ...page);
      for (const row of rows) {
        const id = String(row.source_id), state = String(row.state), result = String(row.result ?? '');
        const outcome = row.outcome == null ? null : String(row.outcome);
        if (outcome === 'completed' || outcome === 'refused' || outcome === 'cancelled') outcomes.set(id, outcome);
        else if (result.startsWith('lifecycle_not_started:')) outcomes.set(id, 'not_started');
        else if (['completed', 'failed', 'cancelled', 'unknown'].includes(state)) outcomes.set(id, 'unknown');
      }
    }
    return outcomes;
  }

  /**
   * One original lifecycle command per unknown action that still holds `resource` and whose command ran under the attempt
   * just before (the one the sweep closed), oldest first, at most 128.
   */
  /**
   * The unknown FCA step attempts (agentTask) whose `resource` is still recorded as retained, with the lease of that attempt
   * (`generation - 1`, the last holder): what a body re-check may prove released (`minecraftBodyRecheckWiring.ts`).
   */
  retainedUnknownSteps(resource: string): Array<{ actionId: string; scopeKey: string; lease: { id: string; generation: number; holder: string } }> {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mind_action_retained_resources'").get()) return [];
    const rows = this.db.prepare(`SELECT a.id,a.scope_key,a.generation,a.last_holder FROM mind_actions a
      JOIN mind_action_retained_resources r ON r.action_id=a.id AND r.resource=?
      WHERE a.state='unknown' AND a.kind='agentTask' AND a.holder IS NULL AND a.last_holder IS NOT NULL ORDER BY r.retained_at,a.id LIMIT 32`).all(resource);
    return rows.map(row => ({ actionId: String(row.id), scopeKey: String(row.scope_key),
      lease: { id: String(row.id), generation: Number(row.generation) - 1, holder: String(row.last_holder) } }));
  }

  /**
   * The steps of nonterminal FCA tasks (in the scope) whose outcome was lost, oldest first, each as the lease it ran under: the
   * action is `unknown` (the attempt before the one that closed it), or still marked live though its lease ended before `at`
   * (a process that died cannot renew it; the sweep has not run yet). The Minecraft recovery closes them (`fcaBodyRecovery.ts`).
   * `include` is asked per task before that step's detail is read: false leaves the step out.
   */
  lostFcaSteps(scopeKey: string, at: string, include: (taskId: string) => boolean = () => true): LostFcaStep[] {
    const instant = Date.parse(at);
    return this.db.prepare(`SELECT a.id,a.source_id,a.state,a.generation,a.holder,a.last_holder,a.lease_until,a.updated_at FROM mind_actions a
      JOIN agent_tasks t ON t.task_id=substr(a.source_id,5,instr(substr(a.source_id,5),':')-1)
      WHERE a.scope_key=? AND a.kind='agentTask' AND a.source_id LIKE 'fca:%' AND a.state IN ('unknown','running','waiting','stopping')
      AND t.scope_key=a.scope_key AND t.status NOT IN ('completed','failed','cancelled') ORDER BY a.created_at,a.id`).all(scopeKey).flatMap(row => {
      const taskId = fcaTaskIdOf(String(row.source_id)), unknown = row.state === 'unknown';
      const ended = row.lease_until === null || Date.parse(String(row.lease_until)) <= instant;
      const holder = unknown ? row.last_holder : row.holder;
      // `include` first (L-1): a step of a task the caller does not want costs no per-step query.
      if (!taskId || !(unknown || ended) || typeof holder !== 'string' || !include(taskId)) return [];
      const lease = { id: String(row.id), generation: Number(row.generation) - (unknown ? 1 : 0), holder };
      const started = this.db.prepare(`SELECT occurred_at FROM agent_task_events WHERE task_id=? AND event_type='fca_step_started'
        AND json_extract(payload_json,'$.actionId')=? AND json_extract(payload_json,'$.generation')=? ORDER BY sequence DESC LIMIT 1`)
        .get(taskId, lease.id, lease.generation);
      const startedAt = typeof started?.occurred_at === 'string' ? started.occurred_at : null;
      const leaseEnd = typeof row.lease_until === 'string' && Number.isFinite(Date.parse(row.lease_until)) ? row.lease_until : null;
      return [{ actionId: lease.id, taskId, lease, startedAt,
        lostAt: leaseEnd ?? this.lastAliveAt(taskId, lease, startedAt, String(row.updated_at)) }];
    });
  }

  /**
   * When a swept step (no lease end on record) was last known alive, from what it left: the newest progress observation of the task
   * and the newest body operation (made, or answered) of this lease, never later than the action's own last update (the sweep) and never
   * earlier than the step's start. A long step is therefore not dated from its start (L-2). Without any of them: the step's start.
   */
  private lastAliveAt(taskId: string, lease: { id: string; generation: number }, startedAt: string | null, updatedAt: string): string | null {
    if (startedAt === null) return null;
    const floor = Date.parse(startedAt), ceiling = Date.parse(updatedAt);
    if (!Number.isFinite(floor)) return startedAt;
    let latest = floor;
    const consider = (value: unknown) => {
      const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
      if (Number.isFinite(at) && at > latest && (!Number.isFinite(ceiling) || at <= ceiling)) latest = at;
    };
    consider(this.db.prepare(`SELECT MAX(occurred_at) AS at FROM agent_task_events WHERE task_id=? AND event_type='fca_progress_observed'
      AND occurred_at>=?`).get(taskId, startedAt)?.at);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_body_operations'").get()) {
      const operations = this.db.prepare(`SELECT created_at,json_extract(receipt_json,'$.observedAt') AS observed FROM fca_body_operations
        WHERE task_id=? AND json_extract(command_json,'$.lease.id')=? AND json_extract(command_json,'$.lease.generation')=?`)
        .all(taskId, lease.id, lease.generation);
      for (const operation of operations) {
        consider(operation.created_at);
        consider(operation.observed);
      }
    }
    return new Date(latest).toISOString();
  }

  unknownLifecycleCommands(resource: string): string[] {
    const rows = this.db.prepare(`SELECT o.command_json FROM minecraft_lifecycle_operations o JOIN mind_actions a ON a.id=o.execution_id
      WHERE a.state='unknown' AND json_extract(o.command_json,'$.authority.lease.generation')=a.generation-1
      AND json_extract(o.command_json,'$.authority.lease.holder')=a.last_holder AND EXISTS(SELECT 1 FROM json_each(a.resources_json) WHERE value=?)
      GROUP BY o.execution_id ORDER BY a.updated_at,a.id LIMIT 128`).all(resource);
    return rows.map(row => String(row.command_json));
  }
}
