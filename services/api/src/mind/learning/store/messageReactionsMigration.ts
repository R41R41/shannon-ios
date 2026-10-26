import type { DatabaseSync } from 'node:sqlite';

/**
 * The owner's emoji reactions on Talk messages (rich chat, `docs/rich-chat-contract.md`). A row is a reaction that is on now;
 * taking it off deletes the row. Her own reactions (§4, 2026-10-26) are rows of their own table, and every time the owner puts one
 * on or takes one off is an event her next turn is told once. Additive tables, created by the API process only.
 */
export function ensureMessageReactionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shannon_message_reactions (
      scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL,
      created_at TEXT NOT NULL, noticed_at TEXT,
      PRIMARY KEY(scope_key, message_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS shannon_message_reactions_thread ON shannon_message_reactions(scope_key, thread_id, created_at);
    CREATE TABLE IF NOT EXISTS shannon_message_reaction_feedback (
      scope_key TEXT NOT NULL, message_id TEXT NOT NULL, reaction TEXT, PRIMARY KEY(scope_key, message_id)
    );
    CREATE TABLE IF NOT EXISTS shannon_own_message_reactions (
      scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key, message_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS shannon_own_message_reactions_thread ON shannon_own_message_reactions(scope_key, thread_id, created_at);
    CREATE TABLE IF NOT EXISTS shannon_message_reaction_events (
      scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL,
      added INTEGER NOT NULL, at TEXT NOT NULL, noticed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS shannon_message_reaction_events_thread ON shannon_message_reaction_events(scope_key, thread_id, at);
  `);
}

