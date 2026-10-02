import type { DatabaseSync } from 'node:sqlite';
import type { ReplaySummaryRecord, StoredConversationMessage } from './conversationStore.js';
import { freezeStoredMessage, type MessageRow } from './sqliteStoreCodecs.js';

/** The reply model never replays more stored messages than this, whatever the caller asks for. */
const MAXIMUM_RECENT_MESSAGES = 2_000;

/**
 * One replay summary per thread, beside the short navigation summary on `conversation_threads`.
 * Additive and outside the numbered migrations, so an older API binary still opens the database.
 * The table is not indexed for memory search: the summary serves its own thread only.
 */
export function ensureReplaySummarySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_replay_summaries (
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      covered_through_message_id TEXT NOT NULL,
      chain_started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, thread_id)
    );
  `);
}

interface ReplaySummaryRow { summary: string; covered_through_message_id: string; chain_started_at: string; updated_at: string; }

export function selectReplaySummary(database: DatabaseSync, scopeKey: string, threadId: string): ReplaySummaryRecord | undefined {
  const row = database.prepare(`
    SELECT summary, covered_through_message_id, chain_started_at, updated_at
    FROM conversation_replay_summaries WHERE scope_key = ? AND thread_id = ?
  `).get(scopeKey, threadId) as unknown as ReplaySummaryRow | undefined;
  return row ? Object.freeze({
    summary: row.summary, coveredThroughMessageId: row.covered_through_message_id,
    chainStartedAt: row.chain_started_at, updatedAt: row.updated_at,
  }) : undefined;
}

export function upsertReplaySummary(database: DatabaseSync, scopeKey: string, threadId: string, record: ReplaySummaryRecord): void {
  database.prepare(`
    INSERT INTO conversation_replay_summaries
      (scope_key, thread_id, summary, covered_through_message_id, chain_started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, thread_id) DO UPDATE SET
      summary = excluded.summary, covered_through_message_id = excluded.covered_through_message_id,
      chain_started_at = excluded.chain_started_at, updated_at = excluded.updated_at
  `).run(scopeKey, threadId, record.summary, record.coveredThroughMessageId, record.chainStartedAt, record.updatedAt);
}

export function selectThreadOfTurn(database: DatabaseSync, scopeKey: string, experienceId: string): string | undefined {
  const row = database.prepare(`
    SELECT thread_id FROM conversation_messages WHERE scope_key = ? AND turn_id = ? LIMIT 1
  `).get(scopeKey, experienceId) as unknown as { thread_id: string } | undefined;
  return row?.thread_id;
}

/** The newest `limit` messages of a thread, oldest first; independent of the displayed-history limit. */
export function selectRecentMessages(database: DatabaseSync, scopeKey: string, threadId: string, limit: number): readonly StoredConversationMessage[] {
  const rows = database.prepare(`
    SELECT message_id, thread_id, turn_id, role, content, observed_at, metadata_json
    FROM (
      SELECT sequence, message_id, thread_id, turn_id, role, content, observed_at, metadata_json
      FROM conversation_messages
      WHERE scope_key = ? AND thread_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    )
    ORDER BY sequence ASC
  `).all(scopeKey, threadId, Math.max(1, Math.min(MAXIMUM_RECENT_MESSAGES, Math.trunc(limit)))) as unknown as MessageRow[];
  return Object.freeze(rows.map(row => freezeStoredMessage(row)));
}
