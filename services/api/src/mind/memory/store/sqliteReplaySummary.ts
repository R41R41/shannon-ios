import type { DatabaseSync } from 'node:sqlite';
import { checkedTemplate } from '@shannon/mind';
import type { ReplaySummaryRecord, StoredConversationMessage } from './conversationStore.js';
import { freezeStoredMessage, type MessageRow } from '../../../infra/sqlite/sqliteStoreCodecs.js';
import { ensureColumns } from '../../../infra/sqlite/schemaColumns.js';

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

/**
 * Structured compaction (Syzygy ADR-0008 stage 3, F7): the template the summary is rendered from, and the raw range it stands for
 * (`covers_from_id`..`covers_to_id`, so recall can open the messages themselves). Additive nullable columns, added only while
 * `SHANNON_STRUCTURED_COMPACTION` is on; a row written without them is the 600-character summary as it was.
 */
export function ensureReplaySummaryTemplateColumns(database: DatabaseSync): void {
  ensureColumns(database, 'conversation_replay_summaries', { template_json: 'TEXT', covers_from_id: 'TEXT', covers_to_id: 'TEXT' });
}

interface ReplaySummaryRow { summary: string; covered_through_message_id: string; chain_started_at: string; updated_at: string;
  template_json?: string | null; covers_from_id?: string | null; covers_to_id?: string | null; }

export function selectReplaySummary(database: DatabaseSync, scopeKey: string, threadId: string, structured = false): ReplaySummaryRecord | undefined {
  const row = database.prepare(`
    SELECT summary, covered_through_message_id, chain_started_at, updated_at${structured ? ', template_json, covers_from_id, covers_to_id' : ''}
    FROM conversation_replay_summaries WHERE scope_key = ? AND thread_id = ?
  `).get(scopeKey, threadId) as unknown as ReplaySummaryRow | undefined;
  if (!row) return undefined;
  const template = structured && row.template_json
    ? checkedTemplate(row.template_json, { fromId: row.covers_from_id ?? null, toId: row.covers_to_id ?? null }) : null;
  return Object.freeze({
    summary: row.summary, coveredThroughMessageId: row.covered_through_message_id,
    chainStartedAt: row.chain_started_at, updatedAt: row.updated_at, ...(template ? { template } : {}),
  });
}

export function upsertReplaySummary(database: DatabaseSync, scopeKey: string, threadId: string, record: ReplaySummaryRecord, structured = false): void {
  if (structured) {
    const { coversFromId, coversToId, ...sections } = record.template ?? { coversFromId: null, coversToId: null };
    database.prepare(`
      INSERT INTO conversation_replay_summaries
        (scope_key, thread_id, summary, covered_through_message_id, chain_started_at, updated_at, template_json, covers_from_id, covers_to_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, thread_id) DO UPDATE SET
        summary = excluded.summary, covered_through_message_id = excluded.covered_through_message_id,
        chain_started_at = excluded.chain_started_at, updated_at = excluded.updated_at,
        template_json = excluded.template_json, covers_from_id = excluded.covers_from_id, covers_to_id = excluded.covers_to_id
    `).run(scopeKey, threadId, record.summary, record.coveredThroughMessageId, record.chainStartedAt, record.updatedAt,
      record.template ? JSON.stringify(sections) : null, coversFromId, coversToId);
    return;
  }
  database.prepare(`
    INSERT INTO conversation_replay_summaries
      (scope_key, thread_id, summary, covered_through_message_id, chain_started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, thread_id) DO UPDATE SET
      summary = excluded.summary, covered_through_message_id = excluded.covered_through_message_id,
      chain_started_at = excluded.chain_started_at, updated_at = excluded.updated_at
  `).run(scopeKey, threadId, record.summary, record.coveredThroughMessageId, record.chainStartedAt, record.updatedAt);
  // A summary written without a template, where the columns exist (structured compaction was on before): the old template and its
  // range no longer stand for this summary, and are cleared, so switching on again never reads a template of an older summary
  // (stage 3 review M3).
  const columns = (database.prepare(`PRAGMA table_info(conversation_replay_summaries)`).all() as Array<{ name: string }>).map(column => column.name);
  if (columns.includes('template_json')) {
    database.prepare(`UPDATE conversation_replay_summaries SET template_json = NULL, covers_from_id = NULL, covers_to_id = NULL
      WHERE scope_key = ? AND thread_id = ?`).run(scopeKey, threadId);
  }
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
