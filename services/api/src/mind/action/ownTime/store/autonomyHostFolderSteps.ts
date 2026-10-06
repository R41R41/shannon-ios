import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HostStepCode } from '../autonomyHostFolderPath.js';

/**
 * The queue of work for her folder on the owner's machines (`docs/host-folder-contract.md`).
 *
 * A step is `queued` by her activity loop, `leased` to the one device bound to its host,
 * and then closed exactly once: `done`, `failed` or `refused` by the device's report,
 * `expired` when the lease ran out without one, `dropped` when the gate would no longer
 * allow it. A closed step is never handed out again and its text is removed from the row.
 */
export type HostStepStatus = 'queued' | 'leased' | 'done' | 'failed' | 'refused' | 'expired' | 'dropped';

export interface HostStep {
  id: string;
  host: string;
  dayKey: string;
  pieceId: string;
  pieceVersion: number;
  operation: 'write';
  relativePath: string;
  /** Empty once the step is closed. */
  content: string;
  contentSha256: string;
  bytes: number;
  status: HostStepStatus;
  queuedAt: string;
  /** The gate decision the hand-out was allowed by; the report is recorded against it. */
  claimDecisionId?: string;
  deviceId?: string;
  leaseUntil?: string;
  finishedAt?: string;
  code?: HostStepCode;
}

export interface HostStepDraft {
  host: string;
  dayKey: string;
  pieceId: string;
  pieceVersion: number;
  relativePath: string;
  content: string;
  contentSha256: string;
  bytes: number;
}

interface StepRow {
  step_id: string; host: string; day_key: string; piece_id: string; piece_version: number; operation: string; relative_path: string;
  content: string; content_sha256: string; bytes: number; status: string; queued_at: string; claim_decision_id: string | null;
  device_id: string | null; lease_until: string | null; finished_at: string | null; outcome_code: string | null;
}

export class AutonomyHostFolderSteps {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_host_steps (
        step_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        host TEXT NOT NULL,
        day_key TEXT NOT NULL,
        piece_id TEXT NOT NULL,
        piece_version INTEGER NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('write')),
        relative_path TEXT NOT NULL,
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'refused', 'expired', 'dropped')),
        queued_at TEXT NOT NULL,
        claim_decision_id TEXT,
        device_id TEXT,
        lease_until TEXT,
        finished_at TEXT,
        outcome_code TEXT,
        reported_bytes INTEGER
      );
      CREATE INDEX IF NOT EXISTS autonomy_host_steps_scope_host ON autonomy_host_steps (scope_key, host, status, queued_at);
    `);
  }

  enqueue(scopeKey: string, draft: HostStepDraft, at: string): HostStep {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO autonomy_host_steps
        (step_id, scope_key, host, day_key, piece_id, piece_version, operation, relative_path, content, content_sha256, bytes, status, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, 'write', ?, ?, ?, ?, 'queued', ?)
    `).run(id, scopeKey, draft.host, draft.dayKey, draft.pieceId, draft.pieceVersion, draft.relativePath,
      draft.content, draft.contentSha256, draft.bytes, at);
    return this.get(scopeKey, id)!;
  }

  get(scopeKey: string, id: string): HostStep | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_host_steps WHERE scope_key = ? AND step_id = ?
    `).get(scopeKey, id) as unknown as StepRow | undefined;
    return row ? step(row) : null;
  }

  /** Steps queued on an owner-local day, whatever became of them: the count the daily limit is held against. */
  queuedOn(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM autonomy_host_steps WHERE scope_key = ? AND day_key = ?
    `).get(scopeKey, dayKey) as unknown as { count: number };
    return Number(row.count);
  }

  /** True while this version of the piece is waiting for, held by, or already written by that host. */
  hasCopy(scopeKey: string, host: string, pieceId: string, pieceVersion: number): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM autonomy_host_steps
      WHERE scope_key = ? AND host = ? AND piece_id = ? AND piece_version = ? AND status IN ('queued', 'leased', 'done') LIMIT 1
    `).get(scopeKey, host, pieceId, pieceVersion));
  }

  /** The oldest waiting step of a host. */
  nextQueued(scopeKey: string, host: string): HostStep | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_host_steps WHERE scope_key = ? AND host = ? AND status = 'queued' ORDER BY queued_at, rowid LIMIT 1
    `).get(scopeKey, host) as unknown as StepRow | undefined;
    return row ? step(row) : null;
  }

  /** The step a device currently holds for a host, if any. */
  leased(scopeKey: string, host: string): HostStep | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_host_steps WHERE scope_key = ? AND host = ? AND status = 'leased' ORDER BY queued_at, rowid LIMIT 1
    `).get(scopeKey, host) as unknown as StepRow | undefined;
    return row ? step(row) : null;
  }

  /** Leases whose time ran out without a report. */
  overdue(scopeKey: string, at: string): readonly HostStep[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_host_steps WHERE scope_key = ? AND status = 'leased' AND lease_until <= ? ORDER BY queued_at, rowid
    `).all(scopeKey, at) as unknown as StepRow[];
    return Object.freeze(rows.map(step));
  }

  /** Hands a waiting step to a device. False when it was no longer waiting. */
  lease(scopeKey: string, id: string, input: { deviceId: string; decisionId: string; leaseUntil: string }): boolean {
    const result = this.database.prepare(`
      UPDATE autonomy_host_steps SET status = 'leased', device_id = ?, claim_decision_id = ?, lease_until = ?
      WHERE scope_key = ? AND step_id = ? AND status = 'queued'
    `).run(input.deviceId, input.decisionId, input.leaseUntil, scopeKey, id);
    return Number(result.changes) > 0;
  }

  /** Closes an open step and removes its text. False when it was already closed, so nothing is recorded twice. */
  close(
    scopeKey: string, id: string, status: Exclude<HostStepStatus, 'queued' | 'leased'>, at: string,
    detail: { code?: HostStepCode; bytes?: number; decisionId?: string } = {},
  ): boolean {
    const result = this.database.prepare(`
      UPDATE autonomy_host_steps
      SET status = ?, finished_at = ?, content = '', outcome_code = ?, reported_bytes = ?, claim_decision_id = COALESCE(claim_decision_id, ?)
      WHERE scope_key = ? AND step_id = ? AND status IN ('queued', 'leased')
    `).run(status, at, detail.code ?? null, detail.bytes ?? null, detail.decisionId ?? null, scopeKey, id);
    return Number(result.changes) > 0;
  }
}

function step(row: StepRow): HostStep {
  return Object.freeze({
    id: row.step_id, host: row.host, dayKey: row.day_key, pieceId: row.piece_id, pieceVersion: Number(row.piece_version),
    operation: 'write' as const, relativePath: row.relative_path, content: row.content, contentSha256: row.content_sha256,
    bytes: Number(row.bytes), status: row.status as HostStepStatus, queuedAt: row.queued_at,
    ...(row.claim_decision_id ? { claimDecisionId: row.claim_decision_id } : {}),
    ...(row.device_id ? { deviceId: row.device_id } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.outcome_code ? { code: row.outcome_code as HostStepCode } : {}),
  });
}
