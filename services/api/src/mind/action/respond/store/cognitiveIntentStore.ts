/** The owner's intentions she keeps, in SQLite (Syzygy ADR-0008 stage 3, S2: the SQLite part of `cognitiveIntent.ts`, moved unchanged into the respond action's store folder). */
import type { ShannonCognitiveFrame, ShannonExperienceChannel, ShannonIntent, ShannonVerifiedWork } from '@shannon/cognition';
import type { CognitiveCycleReceipt, CognitiveIntentPlan, CognitiveIntentStatus, CognitiveIntentStore } from '../cognitiveIntent.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';

export function intentKey(intent: ShannonIntent): string {
  return intent.title.toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 160);
}

export class SQLiteCognitiveIntentStore implements CognitiveIntentStore {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS cognitive_intents (
        intent_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        title TEXT NOT NULL,
        intent_key TEXT NOT NULL,
        desired_outcome TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','paused','completed','dismissed')),
        source TEXT NOT NULL CHECK (source = 'explicit-user-goal'),
        source_experience_id TEXT,
        thread_id TEXT,
        next_step TEXT,
        plan_steps_json TEXT,
        linked_task_id TEXT,
        verified_work_json TEXT,
        priority REAL NOT NULL CHECK (priority >= 0 AND priority <= 1),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cognitive_intents_scope_status_updated
        ON cognitive_intents (scope_key, status, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS cognitive_intents_active_key
        ON cognitive_intents (scope_key, intent_key) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS cognitive_cycle_receipts (
        receipt_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        primary_intent_id TEXT,
        recalled_memory_ids_json TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('respond','command','delegate')),
        outcome TEXT NOT NULL CHECK (outcome IN ('completed','failed')),
        summary TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cognitive_cycle_receipts_scope_occurred
        ON cognitive_cycle_receipts (scope_key, occurred_at DESC);
    `);
    this.ensureOptionalColumns();
    this.secureFiles();
  }

  list(scopeKey: string, status?: CognitiveIntentStatus): readonly ShannonIntent[] {
    const rows = this.database.prepare(`SELECT * FROM cognitive_intents WHERE scope_key = ?
      ${status ? 'AND status = ?' : ''} ORDER BY updated_at DESC LIMIT 100`)
      .all(...(status ? [scopeKey, status] : [scopeKey])) as unknown as Array<Record<string, unknown>>;
    return Object.freeze(rows.map(decodeIntent));
  }

  get(scopeKey: string, intentID: string): ShannonIntent | null {
    const row = this.database.prepare(`SELECT * FROM cognitive_intents
      WHERE scope_key = ? AND intent_id = ? LIMIT 1`).get(scopeKey, intentID) as Record<string, unknown> | undefined;
    return row ? decodeIntent(row) : null;
  }

  capture(scopeKey: string, intent: ShannonIntent, sourceExperienceId?: string): ShannonIntent {
    const key = intentKey(intent);
    const existing = this.database.prepare(`SELECT * FROM cognitive_intents
      WHERE scope_key = ? AND intent_key = ? AND status = 'active' LIMIT 1`).get(scopeKey, key) as Record<string, unknown> | undefined;
    if (existing) {
      const existingID = String(existing.intent_id);
      this.database.prepare(`UPDATE cognitive_intents SET desired_outcome = ?, thread_id = ?,
        source_experience_id = COALESCE(?, source_experience_id), priority = MAX(priority, ?),
        confidence = MAX(confidence, ?), updated_at = ? WHERE intent_id = ?`).run(
        intent.desiredOutcome, intent.threadId ?? null, sourceExperienceId ?? null,
        intent.priority, intent.confidence, intent.updatedAt, existingID,
      );
      this.secureFiles();
      return this.list(scopeKey, 'active').find(item => item.id === existingID)!;
    }
    this.database.prepare(`INSERT INTO cognitive_intents
      (intent_id, scope_key, title, intent_key, desired_outcome, status, source,
       source_experience_id, thread_id, next_step, priority, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      intent.id, scopeKey, intent.title, key, intent.desiredOutcome, intent.status, intent.source,
      sourceExperienceId ?? intent.sourceExperienceId ?? null, intent.threadId ?? null, intent.nextStep ?? null,
      intent.priority, intent.confidence, intent.createdAt, intent.updatedAt,
    );
    this.secureFiles();
    return { ...intent, ...(sourceExperienceId ? { sourceExperienceId } : {}) };
  }

  updateStatus(scopeKey: string, intentID: string, status: CognitiveIntentStatus, at: string): ShannonIntent | null {
    const target = this.database.prepare('SELECT intent_key FROM cognitive_intents WHERE scope_key = ? AND intent_id = ?')
      .get(scopeKey, intentID) as { intent_key: string } | undefined;
    if (!target) return null;
    if (status === 'active' && this.database.prepare(`SELECT 1 AS found FROM cognitive_intents
      WHERE scope_key = ? AND intent_key = ? AND status = 'active' AND intent_id <> ? LIMIT 1`)
      .get(scopeKey, target.intent_key, intentID)) throw new Error('COGNITIVE_INTENT_ACTIVE_CONFLICT');
    const result = this.database.prepare('UPDATE cognitive_intents SET status = ?, updated_at = ? WHERE scope_key = ? AND intent_id = ?')
      .run(status, at, scopeKey, intentID);
    if (Number(result.changes) === 0) return null;
    this.secureFiles();
    return this.list(scopeKey).find(item => item.id === intentID) ?? null;
  }

  updatePlan(scopeKey: string, intentID: string, plan: CognitiveIntentPlan, at: string): ShannonIntent | null {
    const result = this.database.prepare(`UPDATE cognitive_intents
      SET next_step = ?, plan_steps_json = ?, updated_at = ?
      WHERE scope_key = ? AND intent_id = ?`).run(
      plan.nextStep, JSON.stringify(plan.steps), at, scopeKey, intentID,
    );
    if (Number(result.changes) === 0) return null;
    this.secureFiles();
    return this.list(scopeKey).find(item => item.id === intentID) ?? null;
  }

  linkTask(scopeKey: string, intentID: string, taskID: string, at: string): ShannonIntent | null {
    const result = this.database.prepare(`UPDATE cognitive_intents
      SET linked_task_id = ?, updated_at = ? WHERE scope_key = ? AND intent_id = ?`)
      .run(taskID, at, scopeKey, intentID);
    if (Number(result.changes) === 0) return null;
    this.secureFiles();
    return this.get(scopeKey, intentID);
  }

  updateVerifiedWork(
    scopeKey: string,
    intentID: string,
    work: ShannonVerifiedWork,
    nextStep: string,
    at: string,
  ): ShannonIntent | null {
    const current = this.get(scopeKey, intentID);
    if (!current || (current.linkedTaskId && current.linkedTaskId !== work.taskId)) return null;
    const planSteps = work.plan.length ? work.plan.slice(0, 5).map(item => item.title) : current.planSteps ?? [];
    const result = this.database.prepare(`UPDATE cognitive_intents
      SET linked_task_id = ?, verified_work_json = ?, next_step = ?, plan_steps_json = ?, updated_at = ?
      WHERE scope_key = ? AND intent_id = ?`).run(
      work.taskId, JSON.stringify(work), nextStep, JSON.stringify(planSteps), at, scopeKey, intentID,
    );
    if (Number(result.changes) === 0) return null;
    this.secureFiles();
    return this.get(scopeKey, intentID);
  }

  recordCycle(scopeKey: string, frame: ShannonCognitiveFrame, receipt: Omit<CognitiveCycleReceipt, 'id'>): CognitiveCycleReceipt {
    const saved = Object.freeze({ id: randomUUID(), ...receipt });
    this.database.prepare(`INSERT INTO cognitive_cycle_receipts
      (receipt_id, scope_key, thread_id, channel, primary_intent_id, recalled_memory_ids_json,
       action, outcome, summary, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      saved.id, scopeKey, saved.threadId, saved.channel, frame.primaryIntent?.id ?? null,
      JSON.stringify(saved.recalledMemoryIDs), saved.action, saved.outcome, saved.summary.slice(0, 320), saved.occurredAt,
    );
    this.database.prepare(`DELETE FROM cognitive_cycle_receipts WHERE receipt_id IN (
      SELECT receipt_id FROM cognitive_cycle_receipts WHERE scope_key = ?
      ORDER BY occurred_at DESC LIMIT -1 OFFSET 500
    )`).run(scopeKey);
    this.secureFiles();
    return saved;
  }

  recentCycles(scopeKey: string, limit = 20): readonly CognitiveCycleReceipt[] {
    const rows = this.database.prepare(`SELECT * FROM cognitive_cycle_receipts
      WHERE scope_key = ? ORDER BY occurred_at DESC LIMIT ?`).all(scopeKey, boundedLimit(limit)) as unknown as Array<Record<string, unknown>>;
    return Object.freeze(rows.map(row => Object.freeze({
      id: String(row.receipt_id), threadId: String(row.thread_id), channel: String(row.channel) as ShannonExperienceChannel,
      ...(row.primary_intent_id ? { primaryIntentID: String(row.primary_intent_id) } : {}),
      recalledMemoryIDs: Object.freeze(safeStringArray(row.recalled_memory_ids_json)),
      action: String(row.action) as CognitiveCycleReceipt['action'], outcome: String(row.outcome) as CognitiveCycleReceipt['outcome'],
      summary: String(row.summary), occurredAt: String(row.occurred_at),
    })));
  }

  close(): void { this.secureFiles(); this.database.close(); }

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }

  private ensureOptionalColumns(): void {
    const columns = this.database.prepare('PRAGMA table_info(cognitive_intents)').all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'plan_steps_json')) {
      this.database.exec('ALTER TABLE cognitive_intents ADD COLUMN plan_steps_json TEXT');
    }
    if (!columns.some(column => column.name === 'linked_task_id')) {
      this.database.exec('ALTER TABLE cognitive_intents ADD COLUMN linked_task_id TEXT');
    }
    if (!columns.some(column => column.name === 'verified_work_json')) {
      this.database.exec('ALTER TABLE cognitive_intents ADD COLUMN verified_work_json TEXT');
    }
  }
}

function decodeIntent(row: Record<string, unknown>): ShannonIntent {
  const planSteps = safeStringArray(row.plan_steps_json);
  const verifiedWork = safeVerifiedWork(row.verified_work_json);
  return Object.freeze({
    id: String(row.intent_id), title: String(row.title), desiredOutcome: String(row.desired_outcome),
    status: String(row.status) as CognitiveIntentStatus, source: 'explicit-user-goal',
    ...(row.source_experience_id ? { sourceExperienceId: String(row.source_experience_id) } : {}),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.next_step ? { nextStep: String(row.next_step) } : {}),
    ...(planSteps.length ? { planSteps: Object.freeze(planSteps) } : {}),
    ...(row.linked_task_id ? { linkedTaskId: String(row.linked_task_id) } : {}),
    ...(verifiedWork ? { verifiedWork } : {}),
    priority: Number(row.priority), confidence: Number(row.confidence),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  });
}

function safeVerifiedWork(value: unknown): ShannonVerifiedWork | null {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    const statuses = new Set(['queued', 'starting', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled']);
    if (typeof row.taskId !== 'string' || typeof row.title !== 'string' || typeof row.status !== 'string'
      || !statuses.has(row.status) || typeof row.summary !== 'string' || !Array.isArray(row.plan)
      || typeof row.updatedAt !== 'string') return null;
    const plan = row.plan.slice(0, 20).flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const step = item as Record<string, unknown>;
      if (typeof step.title !== 'string' || !['pending', 'running', 'completed'].includes(String(step.status))) return [];
      return [{ title: step.title, status: step.status as 'pending' | 'running' | 'completed' }];
    });
    return Object.freeze({
      taskId: row.taskId,
      title: row.title.slice(0, 160),
      status: row.status as ShannonVerifiedWork['status'],
      summary: row.summary.slice(0, 2_000),
      ...(typeof row.currentAction === 'string' ? { currentAction: row.currentAction.slice(0, 500) } : {}),
      plan: Object.freeze(plan),
      completedPlanSteps: boundedCount(row.completedPlanSteps),
      totalPlanSteps: boundedCount(row.totalPlanSteps),
      testsPassed: boundedCount(row.testsPassed),
      testsFailed: boundedCount(row.testsFailed),
      updatedAt: row.updatedAt,
    });
  } catch { return null; }
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(0, Math.min(10_000, value)) : 0;
}

function safeStringArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').slice(0, 20) : [];
  } catch { return []; }
}

export function boundedLimit(value: number): number { return Math.max(1, Math.min(100, Math.trunc(value) || 20)); }
