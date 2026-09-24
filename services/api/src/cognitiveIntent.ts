import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ShannonCognitiveFrame, ShannonExperienceChannel, ShannonIntent } from '@shannon/cognition';

export type CognitiveIntentStatus = ShannonIntent['status'];

export interface CognitiveCycleReceipt {
  id: string;
  threadId: string;
  channel: ShannonExperienceChannel;
  primaryIntentID?: string;
  recalledMemoryIDs: readonly string[];
  action: 'respond' | 'command' | 'delegate';
  outcome: 'completed' | 'failed';
  summary: string;
  occurredAt: string;
}

export interface CognitiveIntentStore {
  list(scopeKey: string, status?: CognitiveIntentStatus): readonly ShannonIntent[];
  capture(scopeKey: string, intent: ShannonIntent, sourceExperienceId?: string): ShannonIntent;
  updateStatus(scopeKey: string, intentID: string, status: CognitiveIntentStatus, at: string): ShannonIntent | null;
  recordCycle(scopeKey: string, frame: ShannonCognitiveFrame, receipt: Omit<CognitiveCycleReceipt, 'id'>): CognitiveCycleReceipt;
  recentCycles(scopeKey: string, limit?: number): readonly CognitiveCycleReceipt[];
}

export function extractExplicitUserIntent(
  message: string,
  threadId: string,
  occurredAt: string,
): ShannonIntent | null {
  const text = message.replace(/\s+/gu, ' ').trim();
  if (text.length < 4 || text.length > 1_000 || /(?:したくない|するつもりはない|やめたい|中止したい)/u.test(text)) return null;
  if (/^(?:その方針で)?(?:引き続き)?[、\s]*(?:お願い(?:します)?|よろしく(?:お願い(?:します)?)?|続けて(?:ください)?|進めて(?:ください)?)[。.!！]?$/u.test(text)) return null;

  const goalMatch = text.match(/^(?:私の)?(?:目標|目的|ゴール)(?:は|:|：)?[、\s]*(.{3,320})[。.!！]?$/u);
  const ongoingMatch = text.match(/^(?:今後|これから|引き続き|最終的には|最終目標として)[、\s]*(.{3,320})[。.!！]?$/u);
  const directMatch = text.match(/^(.{3,280}?(?:実装|改善|統合|構築|作成|開発|修正|整理|実現|完成|進め|育て)(?:したい|たい|てほしい|てください|てお願いします))[。.!！]?$/u);
  const captured = goalMatch?.[1] ?? (ongoingMatch && meaningfulOngoingGoal(ongoingMatch[1]!) ? ongoingMatch[1] : undefined)
    ?? directMatch?.[1];
  if (!captured) return null;
  const desiredOutcome = captured.replace(/[。.!！]+$/gu, '').trim();
  const title = conciseIntentTitle(desiredOutcome);
  if (title.length < 3) return null;
  return Object.freeze({
    id: randomUUID(),
    title,
    desiredOutcome,
    status: 'active',
    source: 'explicit-user-goal',
    threadId,
    priority: goalMatch ? 0.8 : 0.65,
    confidence: 0.95,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

function meaningfulOngoingGoal(value: string): boolean {
  const normalized = value.replace(/[。.!！]+$/gu, '').replace(/(?:してください|お願いします)$/u, '').trim();
  if (/^(?:お願い(?:します)?|よろしく(?:お願い(?:します)?)?|続けて|進めて)$/u.test(normalized)) return false;
  return /(?:したい|てほしい|てください|てお願いします|続けたい|進めたい|実現したい|完成させたい)$/u.test(normalized);
}

function conciseIntentTitle(value: string): string {
  return value.replace(/(?:してください|してほしい|お願いします)$/u, '')
    .replace(/^(?:私は|シャノンに|シャノンを)[、\s]*/u, '')
    .trim().slice(0, 120);
}

function intentKey(intent: ShannonIntent): string {
  return intent.title.toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 160);
}

export class InMemoryCognitiveIntentStore implements CognitiveIntentStore {
  private readonly intents = new Map<string, ShannonIntent[]>();
  private readonly cycles = new Map<string, CognitiveCycleReceipt[]>();

  list(scopeKey: string, status?: CognitiveIntentStatus): readonly ShannonIntent[] {
    return Object.freeze((this.intents.get(scopeKey) ?? []).filter(item => !status || item.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(item => Object.freeze({ ...item })));
  }

  capture(scopeKey: string, intent: ShannonIntent, sourceExperienceId?: string): ShannonIntent {
    const rows = this.intents.get(scopeKey) ?? [];
    const existing = rows.find(item => item.status === 'active' && intentKey(item) === intentKey(intent));
    const saved = Object.freeze({
      ...(existing ?? intent),
      desiredOutcome: intent.desiredOutcome,
      threadId: intent.threadId,
      priority: Math.max(existing?.priority ?? 0, intent.priority),
      confidence: Math.max(existing?.confidence ?? 0, intent.confidence),
      updatedAt: intent.updatedAt,
      ...(sourceExperienceId ? { sourceExperienceId } : {}),
    });
    const next = existing ? rows.map(item => item.id === existing.id ? saved : item) : [...rows, saved];
    this.intents.set(scopeKey, next.slice(-100));
    return saved;
  }

  updateStatus(scopeKey: string, intentID: string, status: CognitiveIntentStatus, at: string): ShannonIntent | null {
    const rows = this.intents.get(scopeKey) ?? [];
    const existing = rows.find(item => item.id === intentID);
    if (!existing) return null;
    if (status === 'active' && rows.some(item => item.id !== intentID && item.status === 'active' && intentKey(item) === intentKey(existing))) {
      throw new Error('COGNITIVE_INTENT_ACTIVE_CONFLICT');
    }
    const saved = Object.freeze({ ...existing, status, updatedAt: at });
    this.intents.set(scopeKey, rows.map(item => item.id === intentID ? saved : item));
    return saved;
  }

  recordCycle(scopeKey: string, frame: ShannonCognitiveFrame, receipt: Omit<CognitiveCycleReceipt, 'id'>): CognitiveCycleReceipt {
    const saved = Object.freeze({ id: randomUUID(), ...receipt,
      ...(frame.primaryIntent ? { primaryIntentID: frame.primaryIntent.id } : {}),
      recalledMemoryIDs: frame.recalledMemoryIDs });
    this.cycles.set(scopeKey, [...this.cycles.get(scopeKey) ?? [], saved].slice(-500));
    return saved;
  }

  recentCycles(scopeKey: string, limit = 20): readonly CognitiveCycleReceipt[] {
    return Object.freeze((this.cycles.get(scopeKey) ?? []).slice(-boundedLimit(limit)).reverse());
  }
}

export class SQLiteCognitiveIntentStore implements CognitiveIntentStore {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
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
    this.secureFiles();
  }

  list(scopeKey: string, status?: CognitiveIntentStatus): readonly ShannonIntent[] {
    const rows = this.database.prepare(`SELECT * FROM cognitive_intents WHERE scope_key = ?
      ${status ? 'AND status = ?' : ''} ORDER BY updated_at DESC LIMIT 100`)
      .all(...(status ? [scopeKey, status] : [scopeKey])) as unknown as Array<Record<string, unknown>>;
    return Object.freeze(rows.map(decodeIntent));
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
}

function decodeIntent(row: Record<string, unknown>): ShannonIntent {
  return Object.freeze({
    id: String(row.intent_id), title: String(row.title), desiredOutcome: String(row.desired_outcome),
    status: String(row.status) as CognitiveIntentStatus, source: 'explicit-user-goal',
    ...(row.source_experience_id ? { sourceExperienceId: String(row.source_experience_id) } : {}),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.next_step ? { nextStep: String(row.next_step) } : {}),
    priority: Number(row.priority), confidence: Number(row.confidence),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  });
}

function safeStringArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string').slice(0, 20) : [];
  } catch { return []; }
}

function boundedLimit(value: number): number { return Math.max(1, Math.min(100, Math.trunc(value) || 20)); }
