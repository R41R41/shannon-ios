import type { DatabaseSync } from 'node:sqlite';

/**
 * Reactions on platform messages (rich chat §4, `platformReactions.ts`): one row per event someone put an emoji on a message or took
 * it off, told once to her next turn there (`noticed_at`) and deleted a day later. Additive, created by its log's opener.
 */
export function ensurePlatformReactionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS platform_reaction_events (
      scope_key TEXT NOT NULL, platform TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      event_json TEXT NOT NULL, observed_at TEXT NOT NULL, created_at TEXT NOT NULL, noticed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS platform_reaction_events_conversation
      ON platform_reaction_events (scope_key, platform, conversation_id, observed_at);
  `);
}
