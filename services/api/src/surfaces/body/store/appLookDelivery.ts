import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BodyLookMessage, BodyLookSpeaker } from '../bodyLook.js';

/**
 * Her message about a look through the app, stored as one assistant message in the Talk the look
 * was asked in. Unlike a look through her body (`bodyLookDelivery.ts`) there is no initiative and
 * no push: the app that looked receives her words in the answer of its own request, and is the
 * device the owner is holding. This module is handed her words only; nothing here can receive
 * what the camera captured, and there is no column to put it in.
 *
 * The message carries the same `bodyLook` mark as a look through her body, so the one disclosure
 * gate treats it the same way later (it is not replayed while other people can hear), and it has
 * no user side and no `turn.completed` event: no fact, promise, goal, or person memory is made from it.
 */
export const APP_LOOK_TURN_PREFIX = 'app-look:';

export class SQLiteAppLookSpeaker implements BodyLookSpeaker {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  say(scopeKey: string, threadId: string, look: { id: string; outcome: 'seen' | 'not_seen' }, text: string, at: string): BodyLookMessage | null {
    // The conversation tables belong to another store; without them there is nowhere to speak.
    for (const table of ['conversation_messages', 'conversation_threads']) {
      if (!this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) return null;
    }
    const turnId = `${APP_LOOK_TURN_PREFIX}${look.id}`;
    const messageId = randomUUID();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // One message per look, and only in the Talk it was asked in: a Talk that is gone gets nothing.
      const thread = this.database.prepare('SELECT 1 AS found FROM conversation_threads WHERE scope_key = ? AND thread_id = ?').get(scopeKey, threadId);
      const said = this.database.prepare('SELECT 1 AS found FROM conversation_messages WHERE scope_key = ? AND turn_id = ?').get(scopeKey, turnId);
      if (!thread || said) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(messageId, scopeKey, threadId, turnId, text, at, JSON.stringify({ bodyLook: { id: look.id, outcome: look.outcome } }));
      this.database.prepare('UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?').run(at, scopeKey, threadId);
      this.database.exec('COMMIT');
      return { id: messageId, threadId, text };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
