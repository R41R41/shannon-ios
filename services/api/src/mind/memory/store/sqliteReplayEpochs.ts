import type { DatabaseSync } from 'node:sqlite';
import type { ReplayChannel, ReplayEpochRecord } from './conversationStore.js';

/**
 * One replay epoch per thread and channel (Syzygy ADR-0009 stage 1, M5; `conversationWindow.ts`): two message ids and three
 * numbers, never a word. Additive and outside the numbered migrations, like `conversation_replay_summaries`, so an older API
 * binary still opens the database and simply never reads it. A missing or unreadable row only starts a new epoch.
 */
export function ensureReplayEpochSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_replay_epochs (
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      start_message_id TEXT NOT NULL,
      full_from_message_id TEXT NOT NULL,
      budget_characters INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, thread_id, channel)
    );
  `);
}

interface ReplayEpochRow {
  epoch: number;
  start_message_id: string;
  full_from_message_id: string;
  budget_characters: number;
  started_at: string;
}

export function selectReplayEpoch(database: DatabaseSync, scopeKey: string, threadId: string, channel: ReplayChannel): ReplayEpochRecord | undefined {
  const row = database.prepare(`
    SELECT epoch, start_message_id, full_from_message_id, budget_characters, started_at
    FROM conversation_replay_epochs WHERE scope_key = ? AND thread_id = ? AND channel = ?
  `).get(scopeKey, threadId, channel) as unknown as ReplayEpochRow | undefined;
  if (!row) return undefined;
  return Object.freeze({
    epoch: Number(row.epoch), startMessageId: row.start_message_id, fullFromMessageId: row.full_from_message_id,
    budgetCharacters: Number(row.budget_characters), startedAt: row.started_at,
  });
}

export function upsertReplayEpoch(database: DatabaseSync, scopeKey: string, threadId: string, channel: ReplayChannel, record: ReplayEpochRecord): void {
  database.prepare(`
    INSERT INTO conversation_replay_epochs
      (scope_key, thread_id, channel, epoch, start_message_id, full_from_message_id, budget_characters, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, thread_id, channel) DO UPDATE SET
      epoch = excluded.epoch, start_message_id = excluded.start_message_id, full_from_message_id = excluded.full_from_message_id,
      budget_characters = excluded.budget_characters, started_at = excluded.started_at
  `).run(scopeKey, threadId, channel, record.epoch, record.startMessageId, record.fullFromMessageId, record.budgetCharacters, record.startedAt);
}
