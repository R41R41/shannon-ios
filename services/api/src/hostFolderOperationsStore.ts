import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HostStepCode } from './autonomyHostFolderPath.js';

/**
 * The queue of v2 operations in her folder (`docs/host-folder-contract.md`, 「v2: operations in her folder」) and the
 * presence of the device of each host. v1 copies keep their own table (`autonomy_host_steps`).
 *
 * An operation is `queued` by a tool call, `leased` to the bound device, and closed exactly once: `done`, `failed`
 * or `refused` by the device's report, `expired` when its lease ran out, `dropped` when the tool stopped waiting
 * before the device took it (so it never runs later by surprise). Closing removes the arguments (which may hold
 * text she wrote). A result is kept only until the waiting tool takes it.
 */
export const HOST_OPERATIONS = ['list', 'read', 'search', 'create', 'update', 'move', 'delete'] as const;
export type HostOperation = typeof HOST_OPERATIONS[number];
export type HostOperationOrigin = 'conversation' | 'autonomy';
export type HostOperationStatus = 'queued' | 'leased' | 'done' | 'failed' | 'refused' | 'expired' | 'dropped';

export interface HostOperationRow {
  id: string;
  host: string;
  origin: HostOperationOrigin;
  operation: HostOperation;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  relativePath: string;
  toRelativePath?: string;
  status: HostOperationStatus;
  queuedAt: string;
  /** Not handed out after this: the tool has stopped waiting. */
  handOutBefore: string;
  leaseSeconds: number;
  leaseUntil?: string;
  deviceId?: string;
  code?: HostStepCode;
  result?: unknown;
  finishedAt?: string;
}

export interface HostPresence {
  deviceId: string;
  seenAt: string;
  localStop: boolean;
  operations: readonly string[];
}

interface OperationRow {
  op_id: string; host: string; origin: string; operation: string; tool: string; args_json: string; relative_path: string;
  to_relative_path: string | null; status: string; queued_at: string; hand_out_before: string; lease_seconds: number;
  lease_until: string | null; device_id: string | null; outcome_code: string | null; result_json: string | null; finished_at: string | null;
}

export class HostFolderOperationsStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_host_operations (
        op_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        host TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('conversation', 'autonomy')),
        operation TEXT NOT NULL CHECK (operation IN ('list', 'read', 'search', 'create', 'update', 'move', 'delete')),
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        to_relative_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'refused', 'expired', 'dropped')),
        queued_at TEXT NOT NULL,
        hand_out_before TEXT NOT NULL,
        lease_seconds INTEGER NOT NULL,
        lease_until TEXT,
        device_id TEXT,
        outcome_code TEXT,
        result_json TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS autonomy_host_operations_queue ON autonomy_host_operations (scope_key, host, status, queued_at);
      CREATE TABLE IF NOT EXISTS autonomy_host_presence (
        scope_key TEXT NOT NULL,
        host TEXT NOT NULL,
        device_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        local_stop INTEGER NOT NULL CHECK (local_stop IN (0, 1)),
        operations_json TEXT NOT NULL,
        PRIMARY KEY (scope_key, host)
      );
    `);
  }

  enqueue(scopeKey: string, draft: {
    host: string; origin: HostOperationOrigin; operation: HostOperation; tool: string; args: Record<string, unknown>;
    relativePath: string; toRelativePath?: string; handOutBefore: string; leaseSeconds: number;
  }, at: string): HostOperationRow {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO autonomy_host_operations
        (op_id, scope_key, host, origin, operation, tool, args_json, relative_path, to_relative_path, status, queued_at, hand_out_before, lease_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(id, scopeKey, draft.host, draft.origin, draft.operation, draft.tool, JSON.stringify(draft.args), draft.relativePath,
      draft.toRelativePath ?? null, at, draft.handOutBefore, draft.leaseSeconds);
    return this.get(scopeKey, id)!;
  }

  get(scopeKey: string, id: string): HostOperationRow | null {
    const row = this.database.prepare(`SELECT * FROM autonomy_host_operations WHERE scope_key = ? AND op_id = ?`)
      .get(scopeKey, id) as unknown as OperationRow | undefined;
    return row ? operation(row) : null;
  }

  /** The next operation to hand out: a conversation's first, then her own time's (only with `ownTime`), oldest first. */
  nextQueued(scopeKey: string, host: string, operations: readonly string[], at: string, ownTime: boolean): HostOperationRow | null {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_host_operations WHERE scope_key = ? AND host = ? AND status = 'queued' AND hand_out_before > ?
      ORDER BY CASE origin WHEN 'conversation' THEN 0 ELSE 1 END, queued_at, rowid
    `).all(scopeKey, host, at) as unknown as OperationRow[];
    const found = rows.map(operation).find(item => operations.includes(item.operation) && (ownTime || item.origin === 'conversation'));
    return found ?? null;
  }

  leased(scopeKey: string, host: string): HostOperationRow | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_host_operations WHERE scope_key = ? AND host = ? AND status = 'leased' ORDER BY queued_at LIMIT 1
    `).get(scopeKey, host) as unknown as OperationRow | undefined;
    return row ? operation(row) : null;
  }

  /** Leases that ran out without a report, and queued operations nobody waits for any more. */
  stale(scopeKey: string, at: string): readonly HostOperationRow[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_host_operations WHERE scope_key = ?
        AND ((status = 'leased' AND lease_until <= ?) OR (status = 'queued' AND hand_out_before <= ?))
      ORDER BY queued_at, rowid
    `).all(scopeKey, at, at) as unknown as OperationRow[];
    return Object.freeze(rows.map(operation));
  }

  lease(scopeKey: string, id: string, deviceId: string, leaseUntil: string): boolean {
    const result = this.database.prepare(`
      UPDATE autonomy_host_operations SET status = 'leased', device_id = ?, lease_until = ?
      WHERE scope_key = ? AND op_id = ? AND status = 'queued'
    `).run(deviceId, leaseUntil, scopeKey, id);
    return Number(result.changes) > 0;
  }

  /** Closes an open operation once. Its arguments go; its result stays only for the waiting tool. */
  close(scopeKey: string, id: string, status: Exclude<HostOperationStatus, 'queued' | 'leased'>, at: string, detail: { code?: HostStepCode; result?: unknown } = {}): boolean {
    const result = this.database.prepare(`
      UPDATE autonomy_host_operations SET status = ?, finished_at = ?, args_json = '{}', outcome_code = ?, result_json = ?
      WHERE scope_key = ? AND op_id = ? AND status IN ('queued', 'leased')
    `).run(status, at, detail.code ?? null, detail.result === undefined ? null : JSON.stringify(detail.result), scopeKey, id);
    return Number(result.changes) > 0;
  }

  /** The result of a closed operation, once: it is removed as it is read. */
  takeResult(scopeKey: string, id: string): unknown {
    const row = this.database.prepare(`SELECT result_json FROM autonomy_host_operations WHERE scope_key = ? AND op_id = ?`)
      .get(scopeKey, id) as unknown as { result_json: string | null } | undefined;
    this.database.prepare(`UPDATE autonomy_host_operations SET result_json = NULL WHERE scope_key = ? AND op_id = ?`).run(scopeKey, id);
    if (!row?.result_json) return undefined;
    try { return JSON.parse(row.result_json); } catch { return undefined; }
  }

  /** Results nobody took within `before` are removed. */
  forgetResults(scopeKey: string, before: string): void {
    this.database.prepare(`
      UPDATE autonomy_host_operations SET result_json = NULL WHERE scope_key = ? AND result_json IS NOT NULL AND finished_at <= ?
    `).run(scopeKey, before);
  }

  presence(scopeKey: string, host: string): HostPresence | null {
    const row = this.database.prepare(`SELECT * FROM autonomy_host_presence WHERE scope_key = ? AND host = ?`).get(scopeKey, host) as unknown as
      { device_id: string; seen_at: string; local_stop: number; operations_json: string } | undefined;
    if (!row) return null;
    let operations: string[] = [];
    try { const parsed: unknown = JSON.parse(row.operations_json); if (Array.isArray(parsed)) operations = parsed.filter(item => typeof item === 'string'); } catch { operations = []; }
    return Object.freeze({ deviceId: row.device_id, seenAt: row.seen_at, localStop: row.local_stop === 1, operations: Object.freeze(operations) });
  }

  markSeen(scopeKey: string, host: string, presence: HostPresence): void {
    this.database.prepare(`
      INSERT INTO autonomy_host_presence (scope_key, host, device_id, seen_at, local_stop, operations_json) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, host) DO UPDATE SET device_id = excluded.device_id, seen_at = excluded.seen_at,
        local_stop = excluded.local_stop, operations_json = excluded.operations_json
    `).run(scopeKey, host, presence.deviceId, presence.seenAt, presence.localStop ? 1 : 0, JSON.stringify(presence.operations));
  }
}

function operation(row: OperationRow): HostOperationRow {
  let args: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(row.args_json); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>; } catch { args = {}; }
  let result: unknown;
  try { result = row.result_json ? JSON.parse(row.result_json) : undefined; } catch { result = undefined; }
  return Object.freeze({
    id: row.op_id, host: row.host, origin: row.origin as HostOperationOrigin, operation: row.operation as HostOperation, tool: row.tool,
    args: Object.freeze(args), relativePath: row.relative_path, ...(row.to_relative_path !== null ? { toRelativePath: row.to_relative_path } : {}),
    status: row.status as HostOperationStatus, queuedAt: row.queued_at, handOutBefore: row.hand_out_before, leaseSeconds: Number(row.lease_seconds),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}), ...(row.device_id ? { deviceId: row.device_id } : {}),
    ...(row.outcome_code ? { code: row.outcome_code as HostStepCode } : {}), ...(result !== undefined ? { result } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  });
}
