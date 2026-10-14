import type { DatabaseSync } from 'node:sqlite';
import { ensureColumns } from '../../../infra/sqlite/schemaColumns.js';

/**
 * The voice summaries of a thread (`SHANNON_VOICE_HISTORY_SUMMARY`; `voiceHistorySummary.ts`): a few versions per thread, the
 * newest written in the background and the one a running voice epoch replays, and when a voice turn last asked for a newer one.
 * Additive and outside the numbered migrations, like `conversation_replay_epochs`, created only with that switch and replay
 * epochs on: an older API binary still opens the database and never reads them. The epoch row gains one nullable number, the
 * version it replays (`summary_version`); a row without it is an epoch of the budget window.
 */
export function ensureVoiceSummarySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_voice_summaries (
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      summary TEXT NOT NULL,
      covers_from_message_id TEXT NOT NULL,
      covered_through_message_id TEXT NOT NULL,
      chain_started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, thread_id, version)
    );
    CREATE TABLE IF NOT EXISTS conversation_voice_summary_wants (
      scope_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      wanted_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, thread_id)
    );
  `);
  ensureColumns(database, 'conversation_replay_epochs', { summary_version: 'INTEGER' });
}

