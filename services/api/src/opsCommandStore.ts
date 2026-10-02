import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  OPS_COMMAND_LIMITS, OPS_COMMAND_NO_REPORT,
  type OpsCommandCode, type OpsCommandOutcome, type OpsCommandReportCode, type OpsCommandRequest, type OpsCommandStatus, type OpsCommandType,
} from './opsCommandContract.js';

/** A command as a device reads it. `expiresAt` is the time by which the runtime must have claimed it. */
export interface OpsCommand {
  id: string;
  type: OpsCommandType;
  target: string;
  status: OpsCommandStatus;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  finishedAt?: string;
  code?: OpsCommandCode;
  requestedByDeviceId: string;
}

/** A command as the runtime receives it. `expiresAt` is the time by which it must have reported. */
export interface ClaimedOpsCommand {
  id: string;
  type: OpsCommandType;
  target: string;
  createdAt: string;
  expiresAt: string;
}

export type OpsCommandCreation =
  | { command: OpsCommand; created: boolean }
  | 'IDEMPOTENCY_KEY_REUSED' | 'TOO_MANY_OPEN_COMMANDS' | 'RATE_LIMITED';

export type OpsCommandReceipt =
  | { id: string; status: OpsCommandStatus; code?: OpsCommandCode; duplicate: boolean }
  | 'OPS_COMMAND_NOT_FOUND' | 'OPS_COMMAND_NOT_CLAIMED' | 'OPS_COMMAND_FINISHED';

interface Row {
  command_id: string; scope_key: string; idempotency_key: string; type: string; target: string; status: string;
  created_at: string; expires_at: string; claimed_at: string | null; report_by: string | null; finished_at: string | null;
  code: string | null; requested_by_device_id: string;
}

const after = (at: string, seconds: number): string => new Date(Date.parse(at) + seconds * 1000).toISOString();

/**
 * The record of what the owner asked the legacy runtime to do, and how each request ended
 * (`docs/ops-contract.md`, stage 2). Rows are added and their status advances; none is
 * deleted or handed out twice. The table is additive and shares the connection of
 * `SQLiteOpsStore`, so it has the same single holder: the ops routes.
 *
 * `pending` -> `claimed` -> `done` | `failed` | `refused`; `pending` -> `expired` when the
 * runtime did not take it in time; `claimed` -> `failed` (`no_report`) when it did not answer.
 */
export class OpsCommandStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ops_commands (
        command_id TEXT NOT NULL PRIMARY KEY,
        scope_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'refused', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        report_by TEXT,
        finished_at TEXT,
        code TEXT,
        requested_by_device_id TEXT NOT NULL,
        UNIQUE (scope_key, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS ops_commands_scope_created ON ops_commands (scope_key, created_at);
    `);
  }

  /** Closes what ran out of time. Every read and write below starts here, so a late command is never seen as open. */
  private settle(scopeKey: string, at: string): void {
    this.database.prepare(`
      UPDATE ops_commands SET status = 'expired', finished_at = expires_at
      WHERE scope_key = ? AND status = 'pending' AND expires_at <= ?
    `).run(scopeKey, at);
    this.database.prepare(`
      UPDATE ops_commands SET status = 'failed', finished_at = report_by, code = '${OPS_COMMAND_NO_REPORT}'
      WHERE scope_key = ? AND status = 'claimed' AND report_by <= ?
    `).run(scopeKey, at);
  }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private row(scopeKey: string, id: string): Row | undefined {
    return this.database.prepare('SELECT * FROM ops_commands WHERE scope_key = ? AND command_id = ?').get(scopeKey, id) as unknown as Row | undefined;
  }

  /** The command an idempotency key already made, `IDEMPOTENCY_KEY_REUSED` when it made a different one, or null. */
  replay(scopeKey: string, request: OpsCommandRequest, at: string): { command: OpsCommand; created: false } | 'IDEMPOTENCY_KEY_REUSED' | null {
    this.settle(scopeKey, at);
    const row = this.database.prepare('SELECT * FROM ops_commands WHERE scope_key = ? AND idempotency_key = ?')
      .get(scopeKey, request.idempotencyKey) as unknown as Row | undefined;
    if (!row) return null;
    return row.type === request.type && row.target === request.target ? { command: command(row), created: false } : 'IDEMPOTENCY_KEY_REUSED';
  }

  create(scopeKey: string, request: OpsCommandRequest, deviceId: string, at: string): OpsCommandCreation {
    return this.transaction(() => {
      const replayed = this.replay(scopeKey, request, at);
      if (replayed) return replayed;
      const count = (sql: string, ...values: string[]) => Number((this.database.prepare(sql).get(scopeKey, ...values) as { total: number }).total);
      if (count(`SELECT COUNT(*) AS total FROM ops_commands WHERE scope_key = ? AND status IN ('pending', 'claimed')`) >= OPS_COMMAND_LIMITS.open) {
        return 'TOO_MANY_OPEN_COMMANDS';
      }
      if (count('SELECT COUNT(*) AS total FROM ops_commands WHERE scope_key = ? AND created_at > ?', after(at, -3600)) >= OPS_COMMAND_LIMITS.perHour) {
        return 'RATE_LIMITED';
      }
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO ops_commands (command_id, scope_key, idempotency_key, type, target, status, created_at, expires_at, requested_by_device_id)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(id, scopeKey, request.idempotencyKey, request.type, request.target, at, after(at, OPS_COMMAND_LIMITS.claimWithinSeconds), deviceId);
      return { command: command(this.row(scopeKey, id)!), created: true };
    });
  }

  /** Hands the oldest pending command to the runtime, once. A command is never returned by two claims. */
  claim(scopeKey: string, at: string): ClaimedOpsCommand | null {
    return this.transaction(() => {
      this.settle(scopeKey, at);
      const row = this.database.prepare(`
        SELECT * FROM ops_commands WHERE scope_key = ? AND status = 'pending' ORDER BY created_at, rowid LIMIT 1
      `).get(scopeKey) as unknown as Row | undefined;
      if (!row) return null;
      const reportBy = after(at, OPS_COMMAND_LIMITS.reportWithinSeconds);
      this.database.prepare(`
        UPDATE ops_commands SET status = 'claimed', claimed_at = ?, report_by = ? WHERE command_id = ? AND status = 'pending'
      `).run(at, reportBy, row.command_id);
      return { id: row.command_id, type: row.type as OpsCommandType, target: row.target, createdAt: row.created_at, expiresAt: reportBy };
    });
  }

  /**
   * Records the outcome the runtime reports. The same report again is a duplicate. A report
   * that arrives after the server wrote `no_report` replaces it: what the runtime did is
   * the truer record, and the command was not handed out again in between.
   */
  report(scopeKey: string, id: string, outcome: OpsCommandOutcome, code: OpsCommandReportCode | undefined, at: string): OpsCommandReceipt {
    return this.transaction(() => {
      this.settle(scopeKey, at);
      const row = this.row(scopeKey, id);
      if (!row) return 'OPS_COMMAND_NOT_FOUND';
      if (row.status === 'pending') return 'OPS_COMMAND_NOT_CLAIMED';
      const unanswered = row.status === 'failed' && row.code === OPS_COMMAND_NO_REPORT;
      if (row.status !== 'claimed' && !unanswered) {
        if (row.status === outcome && (row.code ?? undefined) === code) return { ...receipt(row), duplicate: true };
        return 'OPS_COMMAND_FINISHED';
      }
      this.database.prepare('UPDATE ops_commands SET status = ?, finished_at = ?, code = ? WHERE command_id = ?')
        .run(outcome, at, code ?? null, id);
      return { ...receipt(this.row(scopeKey, id)!), duplicate: false };
    });
  }

  recent(scopeKey: string, at: string, limit: number = OPS_COMMAND_LIMITS.recent): OpsCommand[] {
    this.settle(scopeKey, at);
    return (this.database.prepare('SELECT * FROM ops_commands WHERE scope_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(scopeKey, limit) as unknown as Row[]).map(command);
  }

  count(): number {
    return Number((this.database.prepare('SELECT COUNT(*) AS total FROM ops_commands').get() as { total: number }).total);
  }
}

function receipt(row: Row): { id: string; status: OpsCommandStatus; code?: OpsCommandCode } {
  return { id: row.command_id, status: row.status as OpsCommandStatus, ...(row.code ? { code: row.code as OpsCommandCode } : {}) };
}

function command(row: Row): OpsCommand {
  return {
    id: row.command_id, type: row.type as OpsCommandType, target: row.target, status: row.status as OpsCommandStatus,
    createdAt: row.created_at, expiresAt: row.expires_at,
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.code ? { code: row.code as OpsCommandCode } : {}),
    requestedByDeviceId: row.requested_by_device_id,
  };
}
