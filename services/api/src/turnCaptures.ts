import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isMemoryEvidenceVisible,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type ProspectiveMemory,
  type ShannonIntent,
} from '@shannon/cognition';
import type { ConversationStore, StoredConversationMessage } from './conversationStore.js';

/**
 * What Shannon took in from one completed turn. The record is written by the
 * same background step that creates the item, after the reply, so the reply
 * never waits for it. What the owner sees is resolved at read time against the
 * current memory controls: a forgotten, cancelled or dismissed item shows
 * nothing, and a turn that captured nothing has no record at all.
 */
export type TurnCaptureKind = 'commitment' | 'knowledge' | 'intent' | 'notice';

export interface TurnCaptureRecord {
  id: string;
  turnId: string;
  kind: TurnCaptureKind;
  /** Short text at capture time (約束・覚えたこと・目的 の内容). */
  text: string;
  /** Memory id, or the normalized title key of an intention. Absent for a notice. */
  itemId?: string;
  change?: 'created' | 'updated' | 'confirmed';
  previousText?: string;
  note?: string;
  dueDate?: string;
  dueAt?: string;
  dueHint?: string;
  timeZone?: string;
  createdAt: string;
}

export interface TurnCaptureView extends Omit<TurnCaptureRecord, 'turnId'> {
  status: 'active' | 'completed';
}

export interface ReminderReference { commitmentId: string; revision: string; }
export interface ReminderView { commitmentId: string; state: 'pending' | 'snoozed' | 'completed' | 'dismissed' | 'superseded'; text: string; }

export interface TurnCaptureStore {
  recordTurnCaptures(scopeKey: string, captures: readonly TurnCaptureRecord[]): void;
  turnCaptures(scopeKey: string, turnIds: readonly string[]): readonly TurnCaptureRecord[];
}

export function turnCaptureId(turnId: string, kind: TurnCaptureKind, key: string): string {
  return `capture-${createHash('sha256').update(`${turnId}\u0000${kind}\u0000${key}`).digest('hex').slice(0, 24)}`;
}

/** Same normalization the intention ledger uses to deduplicate a restated goal. */
export function intentCaptureKey(title: string): string {
  return title.toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 160);
}

/** The owner reads their own fact, not the internal third-person sentence. */
export function ownerFacingStatement(statement: string): string {
  return statement.replace(/^ユーザー(?:は|の|が)(?:シャノンに)?/u, '').trim() || statement;
}

/** `commitment:<memory id>:<revision>` is the initiative source reference of a reminder. */
export function reminderReference(sourceItemId: unknown): ReminderReference | null {
  const match = typeof sourceItemId === 'string' ? sourceItemId.match(/^commitment:([^:]{1,120}):(.{1,64})$/u) : null;
  return match ? { commitmentId: match[1]!, revision: match[2]! } : null;
}

export function ensureTurnCaptureSchema(database: DatabaseSync): void {
  // Additive and outside the numbered migrations: an older API binary can still
  // open this database and simply ignores the table.
  database.exec(`
    CREATE TABLE IF NOT EXISTS turn_captures (
      capture_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_captures_scope_turn ON turn_captures (scope_key, turn_id);
  `);
}

export function insertTurnCaptures(database: DatabaseSync, scopeKey: string, captures: readonly TurnCaptureRecord[]): void {
  const insert = database.prepare(`
    INSERT OR IGNORE INTO turn_captures (capture_id, scope_key, turn_id, kind, item_id, body_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const capture of captures) {
    insert.run(capture.id, scopeKey, capture.turnId, capture.kind, capture.itemId ?? null, JSON.stringify(capture), capture.createdAt);
  }
}

export function selectTurnCaptures(database: DatabaseSync, scopeKey: string, turnIds: readonly string[]): TurnCaptureRecord[] {
  const records: TurnCaptureRecord[] = [];
  for (let offset = 0; offset < turnIds.length; offset += 200) {
    const chunk = turnIds.slice(offset, offset + 200);
    const rows = database.prepare(`
      SELECT body_json FROM turn_captures
      WHERE scope_key = ? AND turn_id IN (${chunk.map(() => '?').join(',')})
      ORDER BY rowid ASC
    `).all(scopeKey, ...chunk) as unknown as Array<{ body_json: string }>;
    for (const row of rows) {
      const record = parseRecord(row.body_json);
      if (record) records.push(record);
    }
  }
  return records;
}

function parseRecord(raw: string): TurnCaptureRecord | null {
  try {
    const row = JSON.parse(raw) as Partial<TurnCaptureRecord>;
    const kinds: readonly string[] = ['commitment', 'knowledge', 'intent', 'notice'];
    return typeof row.id === 'string' && typeof row.turnId === 'string' && typeof row.text === 'string'
      && typeof row.createdAt === 'string' && kinds.includes(String(row.kind)) ? row as TurnCaptureRecord : null;
  } catch { return null; }
}

function visibleCommitment(state: CompanionStateSnapshot, id: string): { memory: ProspectiveMemory; text: string } | null {
  const memory = state.prospectiveMemories.find(item => item.id === id);
  if (!memory || memory.status === 'dismissed') return null;
  const text = visibleMemoryText(state, memory.id, memory.summary);
  if (!text || (memory.sourceExperienceId && !visibleMemoryText(state, memory.sourceExperienceId, memory.summary))) return null;
  return { memory, text };
}

/** Applies the current forget/cancel/dismiss state. Hidden items yield no line. */
export function resolveTurnCaptures(
  records: readonly TurnCaptureRecord[], state: CompanionStateSnapshot, intents: readonly ShannonIntent[],
): Map<string, TurnCaptureView[]> {
  const byTurn = new Map<string, TurnCaptureView[]>();
  const sourceVisible = (turnId: string) => !state.memoryControls.some(control => control.memoryId === turnId && control.status !== 'active');
  for (const record of records) {
    if (!sourceVisible(record.turnId)) continue;
    const { turnId, ...base } = record;
    let view: TurnCaptureView | null = null;
    if (record.kind === 'commitment' && record.itemId) {
      const current = visibleCommitment(state, record.itemId);
      const corrected = state.memoryControls.find(control => control.memoryId === record.itemId)?.overrideText;
      const { dueDate: _date, dueAt: _at, dueHint: _hint, timeZone: _zone, ...undated } = base;
      if (current) view = { ...undated, text: corrected ? current.text : record.text,
        ...(current.memory.dueDate ? { dueDate: current.memory.dueDate } : {}),
        ...(current.memory.dueAt ? { dueAt: current.memory.dueAt } : {}),
        ...(current.memory.dueHint ? { dueHint: current.memory.dueHint } : {}),
        ...(current.memory.timeZone ? { timeZone: current.memory.timeZone } : {}),
        status: current.memory.status === 'completed' ? 'completed' : 'active' };
    } else if (record.kind === 'knowledge' && record.itemId) {
      const stored = state.userFacts.find(item => item.id === record.itemId) ?? state.relationships.find(item => item.id === record.itemId);
      const text = stored ? visibleMemoryText(state, stored.id, stored.statement) : null;
      const { previousText, ...withoutPrevious } = base;
      if (text) view = { ...withoutPrevious, text: ownerFacingStatement(text),
        ...(previousText && isMemoryEvidenceVisible(state, previousText) ? { previousText: ownerFacingStatement(previousText) } : {}),
        status: 'active' };
    } else if (record.kind === 'intent' && record.itemId) {
      const matching = intents.filter(item => intentCaptureKey(item.title) === record.itemId);
      const intent = matching.find(item => item.status === 'active') ?? matching.find(item => item.status !== 'dismissed');
      if (intent && !matching.some(item => item.status === 'dismissed' && item.updatedAt > intent.updatedAt)) {
        view = { ...base, itemId: intent.id, text: intent.title, status: intent.status === 'completed' ? 'completed' : 'active' };
      }
    } else if (record.kind === 'notice') {
      view = { ...base, status: 'active' };
    }
    if (view) byTurn.set(turnId, [...byTurn.get(turnId) ?? [], view]);
  }
  return byTurn;
}

/** Only the newest reminder about a promise offers actions; older ones are plain history. */
export function resolveReminders(
  messages: readonly { id: string; reminder?: ReminderReference }[], state: CompanionStateSnapshot,
): Map<string, ReminderView> {
  const views = new Map<string, ReminderView>();
  const newest = new Map<string, string>();
  for (const message of messages) if (message.reminder) newest.set(message.reminder.commitmentId, message.id);
  for (const message of messages) {
    if (!message.reminder) continue;
    const memory = state.prospectiveMemories.find(item => item.id === message.reminder!.commitmentId);
    const text = memory ? visibleMemoryText(state, memory.id, memory.summary) : null;
    if (!memory || !text || (memory.sourceExperienceId && !visibleMemoryText(state, memory.sourceExperienceId, memory.summary))) continue;
    const reminderState: ReminderView['state'] = newest.get(memory.id) !== message.id ? 'superseded'
      : memory.status === 'completed' ? 'completed' : memory.status === 'dismissed' ? 'dismissed'
        : memory.remindAfter && memory.updatedAt !== message.reminder.revision ? 'snoozed' : 'pending';
    views.set(message.id, { commitmentId: memory.id, state: reminderState, text });
  }
  return views;
}

export interface ConversationCaptureDependencies {
  conversationStore: ConversationStore;
  stateStore: CompanionStateStore;
  cognitiveIntents: { list(scopeKey: string): readonly ShannonIntent[] };
}

/** The Talk history as clients read it: each reply carries what it captured, each reminder its promise. */
export function conversationWithCaptures(
  dependencies: ConversationCaptureDependencies, scopeKey: string, threadId: string,
): readonly StoredConversationMessage[] {
  const messages = dependencies.conversationStore.conversationHistory(scopeKey, threadId);
  const state = dependencies.stateStore.snapshot(scopeKey);
  const turnIds = [...new Set(messages.flatMap(message => message.role === 'assistant' && message.sourceExperienceId
    ? [message.sourceExperienceId] : []))];
  const records = turnIds.length ? dependencies.conversationStore.turnCaptures?.(scopeKey, turnIds) ?? [] : [];
  const captures = records.length ? resolveTurnCaptures(records, state, dependencies.cognitiveIntents.list(scopeKey)) : null;
  const reminders = resolveReminders(messages.map(message => ({ id: message.id,
    ...(message.reminder && 'revision' in message.reminder ? { reminder: message.reminder } : {}) })), state);
  return Object.freeze(messages.map(message => {
    const { reminder: _reference, captures: _stale, ...plain } = message;
    const captured = message.role === 'assistant' && message.sourceExperienceId ? captures?.get(message.sourceExperienceId) : undefined;
    const reminder = reminders.get(message.id);
    return Object.freeze({ ...plain, ...(captured?.length ? { captures: Object.freeze(captured) } : {}), ...(reminder ? { reminder } : {}) });
  }));
}
