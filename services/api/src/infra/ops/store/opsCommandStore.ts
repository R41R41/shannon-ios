import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  OPS_COMMAND_LIMITS, OPS_COMMAND_NO_REPORT,
  type OpsCommandCode, type OpsCommandOutcome, type OpsCommandReportCode, type OpsCommandRequest, type OpsCommandStatus, type OpsCommandType,
} from '../../../contracts/opsCommandContract.js';
import { opsActionKindMatches, opsLifecycleMapping, type OpsLifecycleMapping } from '../../../contracts/opsMinecraftLifecycleContract.js';
import type { ActionLease } from '../../../contracts/actionThreadContract.js';
import { ActionLeaseReader } from '../../../mind/action/threads/store/actionLeaseReader.js';

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
  /**
   * Only on a finished Minecraft start that made a new world (「新しいワールドで始める」): where the previous world is kept (a name in
   * the server directory; null when there was none). Absent everywhere else; a client that predates it ignores it and shows the plain
   * result, one that knows it says 「新しいワールドで始めました（前のワールドは … として残しています）」.
   */
  freshWorld?: { movedTo: string | null };
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
  code: string | null; requested_by_device_id: string; fresh_world_json?: string | null;
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
      CREATE TABLE IF NOT EXISTS ops_lifecycle_dispatches (
        command_id TEXT PRIMARY KEY, server_id TEXT NOT NULL CHECK(server_id='shannon-home'),
        action TEXT NOT NULL CHECK(action IN ('start','stop','login','logout')), lifecycle_id TEXT NOT NULL UNIQUE,
        action_id TEXT UNIQUE, lease_generation INTEGER, lease_holder TEXT,
        execution_kind TEXT NOT NULL DEFAULT 'minecraft' CHECK(execution_kind IN ('minecraft','respond'))
      );
    `);
    this.transaction(() => {
      if (!this.database.prepare('PRAGMA table_info(ops_lifecycle_dispatches)').all().some(row => row.name === 'execution_kind')) {
        // Preserve old pending/unknown identities; deployment cannot turn an old request into new foreground work.
        this.database.exec("ALTER TABLE ops_lifecycle_dispatches ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'minecraft' CHECK(execution_kind IN ('minecraft','respond'))");
      }
      if (!this.database.prepare('PRAGMA table_info(ops_commands)').all().some(row => row.name === 'fresh_world_json')) {
        // Additive: the result of a start that made a new world (null on every other row, and on every row written before).
        this.database.exec('ALTER TABLE ops_commands ADD COLUMN fresh_world_json TEXT');
      }
      this.database.exec(`CREATE TRIGGER IF NOT EXISTS ops_lifecycle_execution_kind_immutable
        BEFORE UPDATE OF execution_kind ON ops_lifecycle_dispatches WHEN NEW.execution_kind != OLD.execution_kind
        BEGIN SELECT RAISE(ABORT,'OPS_EXECUTION_KIND_IMMUTABLE'); END;`);
    });
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

  create(scopeKey: string, request: OpsCommandRequest, deviceId: string, at: string, lifecycle?: OpsLifecycleMapping | null): OpsCommandCreation {
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
      if (lifecycle) this.mapLifecycle(id, request, lifecycle);
      return { command: command(this.row(scopeKey, id)!), created: true };
    });
  }

  /** Hands the oldest pending command to the runtime, once. A command is never returned by two claims. */
  claim(scopeKey: string, at: string): ClaimedOpsCommand | null {
    return this.transaction(() => {
      this.settle(scopeKey, at);
      const row = this.database.prepare(`
        SELECT * FROM ops_commands WHERE scope_key = ? AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM ops_lifecycle_dispatches m WHERE m.command_id=ops_commands.command_id) ORDER BY created_at, rowid LIMIT 1
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
    if (this.database.prepare('SELECT 1 FROM ops_lifecycle_dispatches WHERE command_id=?').get(id)) return 'OPS_COMMAND_FINISHED';
    return this.reportLifecycle(scopeKey,id,outcome,code,at);
  }
  reportLifecycle(scopeKey: string, id: string, outcome: OpsCommandOutcome, code: OpsCommandCode | undefined, at: string,
    freshWorld?: { movedTo: string | null }): OpsCommandReceipt {
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
      this.database.prepare('UPDATE ops_commands SET status = ?, finished_at = ?, code = ?, fresh_world_json = ? WHERE command_id = ?')
        .run(outcome, at, code ?? null, outcome === 'done' && freshWorld ? JSON.stringify({ movedTo: freshWorld.movedTo }) : null, id);
      return { ...receipt(this.row(scopeKey, id)!), duplicate: false };
    });
  }

  private mapLifecycle(id:string, request:Pick<OpsCommandRequest,'type'|'target'>, mapping:OpsLifecycleMapping):void {
    const expected = opsLifecycleMapping(request);
    if (!expected || expected.serverId !== mapping.serverId || expected.action !== mapping.action) throw new Error('OPS_LIFECYCLE_MAPPING');
    this.database.prepare("INSERT INTO ops_lifecycle_dispatches(command_id,server_id,action,lifecycle_id,execution_kind) VALUES(?,?,?,?,'respond')")
      .run(id,mapping.serverId,mapping.action,`ops-lifecycle:${id}`);
  }
  lifecyclePending(scopeKey:string,at:string):Array<{command:OpsCommand;mapping:OpsLifecycleMapping;actionId:string|null;lifecycleId:string}> {
    this.settle(scopeKey,at);
    const rows=this.database.prepare(`SELECT o.*,m.server_id,m.action,m.action_id,m.lifecycle_id FROM ops_commands o
      JOIN ops_lifecycle_dispatches m ON m.command_id=o.command_id WHERE o.scope_key=? AND o.status='pending'
      AND m.execution_kind='respond' ORDER BY o.created_at,o.rowid`).all(scopeKey) as unknown as Array<Row & {server_id:'shannon-home';action:OpsLifecycleMapping['action'];action_id:string|null;lifecycle_id:string}>;
    return rows.map(row=>({command:command(row),mapping:{serverId:row.server_id,action:row.action},actionId:row.action_id,lifecycleId:row.lifecycle_id}));
  }
  /** Late native ACKs are read by their original ID; no claimed/unknown row is executed again. */
  lifecycleAwaiting(scopeKey:string,at:string):Array<{commandId:string;lifecycleId:string}> {
    this.settle(scopeKey,at);
    return (this.database.prepare(`SELECT o.command_id,m.lifecycle_id FROM ops_commands o JOIN ops_lifecycle_dispatches m
      ON m.command_id=o.command_id WHERE o.scope_key=? AND (o.status='claimed' OR o.status='failed' AND o.code=?)`)
      .all(scopeKey,OPS_COMMAND_NO_REPORT) as Array<{command_id:string;lifecycle_id:string}>).map(row=>({commandId:row.command_id,lifecycleId:row.lifecycle_id}));
  }
  bindLifecycle(scopeKey:string,id:string,actionId:string):boolean {
    return this.transaction(()=>{
      const row=this.row(scopeKey,id);if(!row||row.status!=='pending')return false;
      const bound=this.database.prepare('SELECT action_id,execution_kind FROM ops_lifecycle_dispatches WHERE command_id=?').get(id) as {action_id:string|null;execution_kind:string}|undefined;
      const action=new ActionLeaseReader(this.database).get(actionId);
      if(!bound||bound.execution_kind!=='respond'||bound.action_id&&bound.action_id!==actionId
        ||!action||!opsActionKindMatches(bound.execution_kind,action.kind)
        ||action.origin!=='owner_request'||action.scopeKey!==scopeKey||action.sourceId!==`ops:${id}`)return false;
      this.database.prepare('UPDATE ops_lifecycle_dispatches SET action_id=? WHERE command_id=?').run(actionId,id);return true;
    });
  }
  claimLifecycle(scopeKey:string,id:string,lease:ActionLease,at:string):boolean {
    return this.transaction(()=>{
      this.settle(scopeKey,at);const row=this.row(scopeKey,id);if(!row||row.status!=='pending')return false;
      const bound=this.database.prepare('SELECT action_id,execution_kind FROM ops_lifecycle_dispatches WHERE command_id=?').get(id) as {action_id:string|null;execution_kind:string}|undefined;
      if(bound?.execution_kind!=='respond'||bound.action_id!==lease.id)return false;
      this.database.prepare("UPDATE ops_commands SET status='claimed',claimed_at=?,report_by=? WHERE command_id=?").run(at,after(at,OPS_COMMAND_LIMITS.reportWithinSeconds),id);
      this.database.prepare('UPDATE ops_lifecycle_dispatches SET lease_generation=?,lease_holder=? WHERE command_id=?').run(lease.generation,lease.holder,id);
      return true;
    });
  }
  lifecycleReportBy(scopeKey:string,id:string,lease:ActionLease):string|null {
    const row=this.database.prepare(`SELECT o.report_by FROM ops_commands o JOIN ops_lifecycle_dispatches m ON m.command_id=o.command_id
      WHERE o.scope_key=? AND o.command_id=? AND o.status='claimed' AND m.execution_kind='respond'
      AND m.action_id=? AND m.lease_generation=? AND m.lease_holder=?`).get(scopeKey,id,lease.id,lease.generation,lease.holder);
    return typeof row?.report_by==='string'?row.report_by:null;
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
    ...freshWorldOf(row),
  };
}

/** The stored result of a start that made a new world, or nothing. */
function freshWorldOf(row: Row): { freshWorld?: { movedTo: string | null } } {
  if (!row.fresh_world_json) return {};
  try {
    const value = JSON.parse(row.fresh_world_json) as { movedTo?: unknown };
    return { freshWorld: { movedTo: typeof value.movedTo === 'string' ? value.movedTo : null } };
  } catch { return {}; }
}