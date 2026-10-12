import type { DatabaseSync } from 'node:sqlite';
import { ensureMessageReactionSchema } from './messageReactionsMigration.js';

/** The owner's emoji reactions on Talk messages (rich chat, `docs/rich-chat-contract.md`); the tables: `messageReactionsMigration.ts`. */
export interface ReactedMessage { messageId: string; threadId: string; turnId: string; role: 'user' | 'assistant'; content: string }
export interface StoredReaction { messageId: string; emoji: string; createdAt: string }

export class SQLiteMessageReactions {
  constructor(private readonly db: DatabaseSync, createSchema = true) { if (createSchema) ensureMessageReactionSchema(db); }

  /** A Talk message by its id, or her reply by its turn's id (a reply the app has shown before it read the Talk back). */
  message(scopeKey: string, threadId: string, id: string): ReactedMessage | null {
    const row = this.db.prepare(`SELECT message_id, thread_id, turn_id, role, content FROM conversation_messages
      WHERE scope_key=? AND thread_id=? AND (message_id=? OR (turn_id=? AND role='assistant')) ORDER BY sequence DESC LIMIT 1`)
      .get(scopeKey, threadId, id, id) as Record<string, unknown> | undefined;
    return row ? { messageId: String(row.message_id), threadId: String(row.thread_id), turnId: String(row.turn_id),
      role: row.role === 'assistant' ? 'assistant' : 'user', content: String(row.content) } : null;
  }
  emojis(scopeKey: string, messageId: string): string[] {
    return (this.db.prepare('SELECT emoji FROM shannon_message_reactions WHERE scope_key=? AND message_id=? ORDER BY created_at, rowid')
      .all(scopeKey, messageId) as Array<{ emoji: string }>).map(row => row.emoji);
  }
  forThread(scopeKey: string, threadId: string): StoredReaction[] {
    return (this.db.prepare(`SELECT message_id, emoji, created_at FROM shannon_message_reactions WHERE scope_key=? AND thread_id=?
      ORDER BY created_at, rowid`).all(scopeKey, threadId) as Array<Record<string, unknown>>)
      .map(row => ({ messageId: String(row.message_id), emoji: String(row.emoji), createdAt: String(row.created_at) }));
  }
  add(scopeKey: string, threadId: string, messageId: string, emoji: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO shannon_message_reactions(scope_key,thread_id,message_id,emoji,created_at,noticed_at) VALUES(?,?,?,?,?,NULL)')
      .run(scopeKey, threadId, messageId, emoji, at);
  }
  remove(scopeKey: string, messageId: string, emoji: string): void {
    this.db.prepare('DELETE FROM shannon_message_reactions WHERE scope_key=? AND message_id=? AND emoji=?').run(scopeKey, messageId, emoji);
  }
  /** Reactions on this Talk added since `since` that no turn was told of yet, oldest first. */
  unnoticed(scopeKey: string, threadId: string, since: string): StoredReaction[] {
    return (this.db.prepare(`SELECT message_id, emoji, created_at FROM shannon_message_reactions
      WHERE scope_key=? AND thread_id=? AND noticed_at IS NULL AND created_at>=? ORDER BY created_at, rowid LIMIT 12`)
      .all(scopeKey, threadId, since) as Array<Record<string, unknown>>)
      .map(row => ({ messageId: String(row.message_id), emoji: String(row.emoji), createdAt: String(row.created_at) }));
  }
  markNoticed(scopeKey: string, reactions: readonly StoredReaction[], at: string): void {
    const statement = this.db.prepare(`UPDATE shannon_message_reactions SET noticed_at=?
      WHERE scope_key=? AND message_id=? AND emoji=? AND noticed_at IS NULL`);
    for (const reaction of reactions) statement.run(at, scopeKey, reaction.messageId, reaction.emoji);
  }
  /** What the reactions last wrote to this message's feedback, so a reaction never clears a choice the owner made himself. */
  syncedFeedback(scopeKey: string, messageId: string): 'good' | 'bad' | null | undefined {
    const row = this.db.prepare('SELECT reaction FROM shannon_message_reaction_feedback WHERE scope_key=? AND message_id=?')
      .get(scopeKey, messageId) as { reaction: string | null } | undefined;
    return row ? row.reaction === 'good' || row.reaction === 'bad' ? row.reaction : null : undefined;
  }
  recordFeedback(scopeKey: string, messageId: string, reaction: 'good' | 'bad' | null): void {
    this.db.prepare(`INSERT INTO shannon_message_reaction_feedback(scope_key,message_id,reaction) VALUES(?,?,?)
      ON CONFLICT(scope_key,message_id) DO UPDATE SET reaction=excluded.reaction`).run(scopeKey, messageId, reaction);
  }
}
