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
import { intentCaptureKey, ownerFacingStatement } from '../turnCaptureKeys.js';
export { turnCaptureId, intentCaptureKey, ownerFacingStatement } from '../turnCaptureKeys.js';

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

export { resolveTurnCaptures, resolveReminders, conversationWithCaptures, type ConversationCaptureDependencies } from '../turnCaptureProjection.js';
