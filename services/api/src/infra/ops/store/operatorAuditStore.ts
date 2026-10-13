import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { appliedSchemaSteps, applySchemaSteps, schemaStepChecksum } from '../../sqlite/migrations/schemaSteps.js';
import { openDatabase } from '../../sqlite/sqliteOpen.js';
import { OPERATOR_AUDIT_STEP } from '../../sqlite/migrations/execution/012_operator_audit.js';
import { OPERATOR_VIA, type OperatorCode } from '../../../contracts/operatorContract.js';
import type { MinecraftLifecycleAction } from '../../../contracts/minecraftLifecycleContract.js';

export type OperatorAuditEvent = 'invoked' | 'accepted' | 'refused' | 'settled' | 'stopped' | 'time_limit';
export interface OperatorAuditDraft {
  operationId: string; scopeKey: string; at: string; operator: string; command: string; event: OperatorAuditEvent; code: OperatorCode | string;
  argsJson: string; action?: string | null; serverId?: string | null; taskId?: string | null; lifecycleId?: string | null;
  actionId?: string | null; deadlineAt?: string | null; budgetYen?: number | null; detail?: string | null;
}
export interface OperatorAuditRow extends Required<Omit<OperatorAuditDraft, 'action' | 'serverId' | 'taskId' | 'lifecycleId' | 'actionId'
  | 'deadlineAt' | 'budgetYen' | 'detail'>> {
  sequence: number; eventId: string; via: typeof OPERATOR_VIA;
  action: string | null; serverId: string | null; taskId: string | null; lifecycleId: string | null; actionId: string | null;
  deadlineAt: string | null; budgetYen: number | null; detail: string | null;
}

const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

function row(value: Record<string, unknown>): OperatorAuditRow {
  return Object.freeze({
    sequence: Number(value.sequence), eventId: String(value.event_id), operationId: String(value.operation_id), scopeKey: String(value.scope_key),
    at: String(value.occurred_at), operator: String(value.operator), via: OPERATOR_VIA, command: String(value.command),
    event: String(value.event) as OperatorAuditEvent, code: String(value.code), argsJson: String(value.args_json),
    action: text(value.action), serverId: text(value.server_id), taskId: text(value.task_id), lifecycleId: text(value.lifecycle_id),
    actionId: text(value.action_id), deadlineAt: text(value.deadline_at), budgetYen: value.budget_yen === null ? null : Number(value.budget_yen),
    detail: text(value.detail),
  });
}

/**
 * The operator's append-only audit (`operator_audit`, schema step 012). Only `append` writes; nothing updates or deletes a row
 * (triggers refuse both). It is also the marker of what the operator started: a request is the operator's only when an
 * `accepted` row of command `request` names its task.
 */
export class OperatorAuditStore {
  constructor(private readonly db: DatabaseSync) { applySchemaSteps(db, [OPERATOR_AUDIT_STEP]); }

  append(draft: OperatorAuditDraft): OperatorAuditRow {
    const eventId = randomUUID();
    this.db.prepare(`INSERT INTO operator_audit (event_id, operation_id, scope_key, occurred_at, operator, via, command, event, code,
      args_json, action, server_id, task_id, lifecycle_id, action_id, deadline_at, budget_yen, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(eventId, draft.operationId, draft.scopeKey, draft.at,
      draft.operator.slice(0, 64), OPERATOR_VIA, draft.command.slice(0, 40), draft.event, String(draft.code).slice(0, 60), draft.argsJson.slice(0, 4000),
      draft.action ?? null, draft.serverId ?? null, draft.taskId ?? null, draft.lifecycleId ?? null, draft.actionId ?? null,
      draft.deadlineAt ?? null, draft.budgetYen ?? null, draft.detail ? draft.detail.slice(0, 600) : null);
    return row(this.db.prepare('SELECT * FROM operator_audit WHERE event_id=?').get(eventId) as Record<string, unknown>);
  }

  /** Every event of one invocation, oldest first. */
  operation(operationId: string): OperatorAuditRow[] {
    return this.db.prepare('SELECT * FROM operator_audit WHERE operation_id=? ORDER BY sequence').all(operationId)
      .map(value => row(value as Record<string, unknown>));
  }

  /** Newest first, at most `limit` (bounded to 200). */
  recent(scopeKey: string, limit = 50): OperatorAuditRow[] {
    return this.db.prepare('SELECT * FROM operator_audit WHERE scope_key=? ORDER BY sequence DESC LIMIT ?')
      .all(scopeKey, Math.max(1, Math.min(200, Math.trunc(limit)))).map(value => row(value as Record<string, unknown>));
  }

  /** The accepted operator request that created this task, or null: the task is then not the operator's. */
  requestOf(scopeKey: string, taskId: string): OperatorAuditRow | null {
    const found = this.db.prepare(`SELECT * FROM operator_audit WHERE scope_key=? AND task_id=? AND command='request' AND event='accepted'
      ORDER BY sequence LIMIT 1`).get(scopeKey, taskId);
    return found ? row(found as Record<string, unknown>) : null;
  }

  /**
   * Accepted operator requests since `since`, newest first, whatever the audit says happened to them since: whether one still
   * runs is the task's phase, not a `stopped` row (a stop asked for may not have taken yet).
   */
  requestsSince(scopeKey: string, since: string): OperatorAuditRow[] {
    return this.db.prepare(`SELECT * FROM operator_audit WHERE scope_key=? AND command='request' AND event='accepted' AND occurred_at>=?
      ORDER BY sequence DESC LIMIT 50`).all(scopeKey, since).map(value => row(value as Record<string, unknown>));
  }

  /** Whether a task already has an event of this kind (a time limit is audited, noted and recorded once). */
  hasEvent(taskId: string, event: OperatorAuditEvent): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM operator_audit WHERE task_id=? AND event=? LIMIT 1').get(taskId, event));
  }

  /** Invocations since `since`: every `invoked` row and every refusal at the socket itself (the flood limit counts both). */
  invocationsSince(scopeKey: string, since: string): number {
    const found = this.db.prepare(`SELECT COUNT(*) AS count FROM operator_audit WHERE scope_key=? AND occurred_at>=?
      AND (event='invoked' OR command='socket')`).get(scopeKey, since);
    return Number(found?.count ?? 0);
  }

  /** Refusals since `since`, the coalesced flood rows aside (the activity record shows only the first few an hour). */
  refusalsSince(scopeKey: string, since: string): number {
    const found = this.db.prepare(`SELECT COUNT(*) AS count FROM operator_audit WHERE scope_key=? AND occurred_at>=? AND event='refused'
      AND code<>'flooded'`).get(scopeKey, since);
    return Number(found?.count ?? 0);
  }

  /** The per-task yen cap the operator asked for, or null for any task it did not start. */
  budgetYen(taskId: string): number | null {
    const found = this.db.prepare(`SELECT budget_yen FROM operator_audit WHERE task_id=? AND command='request' AND event='accepted'
      ORDER BY sequence LIMIT 1`).get(taskId);
    return found && found.budget_yen !== null ? Number(found.budget_yen) : null;
  }

  /** Accepted invocations of the last hour (the rate limit counts the record, so a restart does not reset it). */
  acceptedSince(scopeKey: string, since: string): number {
    const found = this.db.prepare(`SELECT COUNT(*) AS count FROM operator_audit WHERE scope_key=? AND event='accepted' AND occurred_at>=?`)
      .get(scopeKey, since);
    return Number(found?.count ?? 0);
  }
}

/**
 * Whether a lifecycle command with this id is the operator's own: an `invoked` row of command `lifecycle` with the same action and
 * server, and no refusal. Read on the lifecycle's own connection (API and own-time worker alike); a missing table answers false.
 */
export function operatorLifecycleAllowed(db: DatabaseSync, scopeKey: string, operationId: string,
  command: { serverId: string; action: MinecraftLifecycleAction }): boolean {
  try {
    const invoked = db.prepare(`SELECT 1 AS found FROM operator_audit WHERE scope_key=? AND operation_id=? AND command='lifecycle'
      AND event='invoked' AND action=? AND server_id=?`).get(scopeKey, operationId, command.action, command.serverId);
    const refused = db.prepare(`SELECT 1 AS found FROM operator_audit WHERE operation_id=? AND event='refused'`).get(operationId);
    return Boolean(invoked) && !refused;
  } catch { return false; }
}

export interface OperatorAuditInspection {
  /** Whether schema step 012 is recorded with the checksum this build pins. */
  step: 'applied' | 'missing' | 'changed';
  recent: OperatorAuditRow[];
  /** Accepted requests of the last two days that the operator has not stopped and no time limit stopped. */
  open: OperatorAuditRow[];
}

/**
 * The CLI's read of the audit (`opsCli.ts minecraft status`): a read-only connection, nothing applied or written. A database
 * without the step answers `missing` and no rows.
 */
export function inspectOperatorAudit(path: string, now: string, limit = 10): OperatorAuditInspection {
  const db = openDatabase(path, 'readOnly');
  try {
    const recorded = appliedSchemaSteps(db).find(step => step.id === OPERATOR_AUDIT_STEP.id);
    if (!recorded) return { step: 'missing', recent: [], open: [] };
    const step = recorded.checksum === schemaStepChecksum(OPERATOR_AUDIT_STEP) ? 'applied' : 'changed';
    const read = (sql: string, ...values: Array<string | number>) => db.prepare(sql).all(...values).map(value => row(value as Record<string, unknown>));
    const since = new Date(Date.parse(now) - 48 * 3600_000).toISOString();
    return {
      step,
      recent: read('SELECT * FROM operator_audit ORDER BY sequence DESC LIMIT ?', Math.max(1, Math.min(200, Math.trunc(limit)))),
      open: read(`SELECT a.* FROM operator_audit a WHERE a.command='request' AND a.event='accepted' AND a.occurred_at>=?
        AND NOT EXISTS (SELECT 1 FROM operator_audit b WHERE b.task_id=a.task_id AND b.event IN ('stopped','time_limit'))
        ORDER BY a.sequence DESC LIMIT 20`, since),
    };
  } finally {
    db.close();
  }
}
