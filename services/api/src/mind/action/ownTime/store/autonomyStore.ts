import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AutonomyActivityRecord } from '../../../inhibition/store/autonomyActivity.js';
import { roundYen } from '../../../inhibition/inhibitionPorts.js';
import { AutonomyHostFolderSteps } from './autonomyHostFolderSteps.js';
import { HostFolderOperationsStore } from './hostFolderOperationsStore.js';
import { AutonomyLoopState } from './autonomyLoopState.js';
import { AutonomyProposalLedger } from './autonomyProposals.js';
import { AutonomyPursuitLedger } from './pursuitLedger.js';
import { OwnerInformedMarks } from '../../../inhibition/store/ownerInformedMarks.js';
import { secureDatabaseFiles } from '../../../../infra/sqlite/sqliteStoreContext.js';
import { StudyStore } from './studyStore.js';

/**
 * Durable state of bounded autonomy. Every table is created with
 * `CREATE TABLE IF NOT EXISTS` outside the numbered migrations, so the schema
 * version is unchanged and an older API binary can still open the database.
 */
export interface AutonomyControlState {
  paused: boolean;
  changedAt: string | null;
}

export type AutonomyBudgetRequestStatus = 'pending' | 'approved' | 'declined';

export interface AutonomyBudgetRequest {
  id: string;
  dayKey: string;
  reason: string;
  requestedYen: number;
  status: AutonomyBudgetRequestStatus;
  /** What the owner added for that day; 0 unless approved. */
  approvedYen: number;
  createdAt: string;
  decidedAt?: string;
}

export interface AutonomySpend {
  model: string;
  purpose?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costYen: number;
  activityId?: string;
}

export interface AutonomyModelPreference {
  purpose: string;
  modelId: string;
  reason: string;
  updatedAt: string;
}

interface BudgetRequestRow {
  request_id: string; day_key: string; reason: string; requested_yen: number; status: string;
  approved_yen: number; created_at: string; decided_at: string | null;
}

export class SQLiteAutonomyStore {
  private readonly database: DatabaseSync;
  readonly activity: AutonomyActivityRecord;
  readonly pursuits: AutonomyPursuitLedger;
  readonly proposals: AutonomyProposalLedger;
  /** Her study and the activity loop's journal share this connection, so a step and its record commit together. */
  readonly study: StudyStore;
  readonly loop: AutonomyLoopState;
  /** What she wrote after reading the owner's documents or a shared Notion page, and the sessions that read them (`ownerInformedMarks.ts`). */
  readonly informed: OwnerInformedMarks;
  /** Work queued for her folder on the owner's machines. */
  readonly hostSteps: AutonomyHostFolderSteps;
  /** v2 operations in her folder, and the presence of each host's device. */
  readonly hostOperations: HostFolderOperationsStore;

  constructor(private readonly path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_control (
        scope_key TEXT PRIMARY KEY,
        paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_spend (
        spend_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        model TEXT NOT NULL,
        purpose TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
        cost_yen REAL NOT NULL CHECK (cost_yen >= 0),
        activity_id TEXT
      );
      CREATE INDEX IF NOT EXISTS autonomy_spend_scope_day ON autonomy_spend (scope_key, day_key);
      CREATE TRIGGER IF NOT EXISTS autonomy_spend_no_update BEFORE UPDATE ON autonomy_spend
        BEGIN SELECT RAISE(ABORT, 'AUTONOMY_SPEND_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS autonomy_spend_no_delete BEFORE DELETE ON autonomy_spend
        BEGIN SELECT RAISE(ABORT, 'AUTONOMY_SPEND_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS autonomy_spend_no_replace BEFORE INSERT ON autonomy_spend
        WHEN EXISTS (SELECT 1 FROM autonomy_spend WHERE spend_id = NEW.spend_id)
        BEGIN SELECT RAISE(ABORT, 'AUTONOMY_SPEND_APPEND_ONLY'); END;
      CREATE TABLE IF NOT EXISTS autonomy_budget_requests (
        request_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_yen REAL NOT NULL CHECK (requested_yen > 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
        approved_yen REAL NOT NULL DEFAULT 0 CHECK (approved_yen >= 0),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE (scope_key, day_key)
      );
      CREATE TABLE IF NOT EXISTS autonomy_model_preferences (
        scope_key TEXT NOT NULL,
        purpose TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, purpose)
      );
    `);
    this.activity = new AutonomyActivityRecord(this.database);
    this.pursuits = new AutonomyPursuitLedger(this.database);
    this.proposals = new AutonomyProposalLedger(this.database);
    this.study = new StudyStore(this.database);
    this.loop = new AutonomyLoopState(this.database);
    this.informed = new OwnerInformedMarks(this.database);
    this.hostSteps = new AutonomyHostFolderSteps(this.database);
    this.hostOperations = new HostFolderOperationsStore(this.database);
    secureDatabaseFiles(path);
  }

  transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Throws when the state cannot be read; the caller treats that as paused. */
  control(scopeKey: string): AutonomyControlState {
    const row = this.database.prepare(`
      SELECT paused, changed_at FROM autonomy_control WHERE scope_key = ?
    `).get(scopeKey) as unknown as { paused: number; changed_at: string } | undefined;
    return Object.freeze({ paused: row ? Number(row.paused) === 1 : false, changedAt: row?.changed_at ?? null });
  }

  setPaused(scopeKey: string, paused: boolean, at: string): AutonomyControlState {
    this.database.prepare(`
      INSERT INTO autonomy_control (scope_key, paused, changed_at) VALUES (?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET paused = excluded.paused, changed_at = excluded.changed_at
    `).run(scopeKey, paused ? 1 : 0, at);
    return this.control(scopeKey);
  }

  recordSpend(scopeKey: string, dayKey: string, occurredAt: string, spend: AutonomySpend): void {
    this.database.prepare(`
      INSERT INTO autonomy_spend
        (spend_id, scope_key, day_key, occurred_at, model, purpose, input_tokens, output_tokens, cost_usd, cost_yen, activity_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), scopeKey, dayKey, occurredAt, spend.model, spend.purpose ?? null,
      Math.max(0, Math.trunc(spend.inputTokens)), Math.max(0, Math.trunc(spend.outputTokens)),
      Math.max(0, spend.costUsd), Math.max(0, spend.costYen), spend.activityId ?? null,
    );
  }

  spentYen(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(cost_yen), 0) AS cost FROM autonomy_spend WHERE scope_key = ? AND day_key = ?
    `).get(scopeKey, dayKey) as unknown as { cost: number };
    return roundYen(Number(row.cost));
  }

  budgetRequest(scopeKey: string, dayKey: string): AutonomyBudgetRequest | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_budget_requests WHERE scope_key = ? AND day_key = ?
    `).get(scopeKey, dayKey) as unknown as BudgetRequestRow | undefined;
    return row ? budgetRequest(row) : null;
  }

  budgetRequestById(scopeKey: string, requestId: string): AutonomyBudgetRequest | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_budget_requests WHERE scope_key = ? AND request_id = ?
    `).get(scopeKey, requestId) as unknown as BudgetRequestRow | undefined;
    return row ? budgetRequest(row) : null;
  }

  /** One request per owner-local day; a second one returns null. */
  createBudgetRequest(scopeKey: string, dayKey: string, reason: string, requestedYen: number, at: string): AutonomyBudgetRequest | null {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO autonomy_budget_requests
        (request_id, scope_key, day_key, reason, requested_yen, status, approved_yen, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(randomUUID(), scopeKey, dayKey, reason, requestedYen, at);
    return result.changes ? this.budgetRequest(scopeKey, dayKey) : null;
  }

  /** Decides a pending request; anything already decided is left as it is and null is returned. */
  decideBudgetRequest(scopeKey: string, requestId: string, status: 'approved' | 'declined', approvedYen: number, at: string): AutonomyBudgetRequest | null {
    const result = this.database.prepare(`
      UPDATE autonomy_budget_requests SET status = ?, approved_yen = ?, decided_at = ?
      WHERE scope_key = ? AND request_id = ? AND status = 'pending'
    `).run(status, status === 'approved' ? approvedYen : 0, at, scopeKey, requestId);
    return result.changes ? this.budgetRequestById(scopeKey, requestId) : null;
  }

  approvedExtraYen(scopeKey: string, dayKey: string): number {
    const request = this.budgetRequest(scopeKey, dayKey);
    return request?.status === 'approved' ? request.approvedYen : 0;
  }

  modelPreferences(scopeKey: string): readonly AutonomyModelPreference[] {
    const rows = this.database.prepare(`
      SELECT purpose, model_id, reason, updated_at FROM autonomy_model_preferences WHERE scope_key = ? ORDER BY purpose
    `).all(scopeKey) as unknown as Array<{ purpose: string; model_id: string; reason: string; updated_at: string }>;
    return Object.freeze(rows.map(row => Object.freeze({
      purpose: row.purpose, modelId: row.model_id, reason: row.reason, updatedAt: row.updated_at,
    })));
  }

  setModelPreference(scopeKey: string, preference: AutonomyModelPreference): void {
    this.database.prepare(`
      INSERT INTO autonomy_model_preferences (scope_key, purpose, model_id, reason, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, purpose) DO UPDATE SET
        model_id = excluded.model_id, reason = excluded.reason, updated_at = excluded.updated_at
    `).run(scopeKey, preference.purpose, preference.modelId, preference.reason, preference.updatedAt);
  }

  close(): void {
    if (!this.database.isOpen) return;
    secureDatabaseFiles(this.path);
    this.database.close();
  }
}

function budgetRequest(row: BudgetRequestRow): AutonomyBudgetRequest {
  return Object.freeze({
    id: row.request_id,
    dayKey: row.day_key,
    reason: row.reason,
    requestedYen: Number(row.requested_yen),
    status: row.status as AutonomyBudgetRequestStatus,
    approvedYen: Number(row.approved_yen),
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  });
}
