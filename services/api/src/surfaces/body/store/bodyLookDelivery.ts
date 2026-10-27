import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BodyLookMessage, BodyLookSpeaker } from '../bodyLook.js';

/**
 * Her message about a look, delivered the way she says anything on her own: one assistant
 * message in the Talk the look was asked in, and one initiative so the apps and the push
 * worker notice it. This module is handed her words only. Nothing here can receive what
 * the camera captured, and there is no column to put it in.
 *
 * The message has no user side and no `turn.completed` event, so it is display history:
 * the extraction that runs after a turn never reads it, and no fact, promise, goal, or
 * person memory is made from it.
 */
import { BODY_LOOK_SOURCE_PREFIX, BODY_LOOK_SOURCE_TITLE, BODY_SCREEN_LOOK_SOURCE_TITLE } from '../../../contracts/bodyLookContract.js';
export { BODY_LOOK_SOURCE_PREFIX, BODY_LOOK_SOURCE_TITLE, bodyLookIdOfSource } from '../../../contracts/bodyLookContract.js';

export class SQLiteBodyLookSpeaker implements BodyLookSpeaker {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  say(scopeKey: string, threadId: string, look: { id: string; outcome: 'seen' | 'not_seen'; source?: 'camera' | 'screen' }, text: string, at: string): BodyLookMessage | null {
    // The conversation and initiative tables belong to other stores; without them there is nowhere to speak.
    for (const table of ['initiative_messages', 'conversation_messages', 'conversation_threads']) {
      if (!this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) return null;
    }
    const initiativeId = randomUUID();
    const messageId = randomUUID();
    const sourceItemId = `${BODY_LOOK_SOURCE_PREFIX}${look.id}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const thread = this.thread(scopeKey, threadId, at);
      // One message per look: the unique source reference refuses a second one.
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO initiative_messages
          (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url,
           content, expression, day_key, created_at)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)
      `).run(initiativeId, scopeKey, thread, sourceItemId, look.source === 'screen' ? BODY_SCREEN_LOOK_SOURCE_TITLE : BODY_LOOK_SOURCE_TITLE, text,
        look.outcome === 'seen' ? 'curious' : 'thinking', sourceItemId, at);
      if (!inserted.changes) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(messageId, scopeKey, thread, `initiative:${initiativeId}`, text, at, JSON.stringify({
        initiativeId, sourceItemId, bodyLook: { id: look.id, outcome: look.outcome, ...(look.source === 'screen' ? { source: 'screen' } : {}) },
      }));
      this.database.prepare('UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?').run(at, scopeKey, thread);
      this.database.exec('COMMIT');
      return { id: messageId, threadId: thread, text, initiativeId };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  /** The Talk the look was asked in while it still exists, otherwise the most recent one. */
  private thread(scopeKey: string, threadId: string, at: string): string {
    const columns = this.database.prepare(`PRAGMA table_info('conversation_threads')`).all() as unknown as Array<{ name: string }>;
    const open = columns.some(column => column.name === 'archived_at') ? 'AND archived_at IS NULL' : '';
    if (this.database.prepare(`SELECT 1 AS found FROM conversation_threads WHERE scope_key = ? AND thread_id = ? ${open}`).get(scopeKey, threadId)) return threadId;
    const latest = this.database.prepare(`
      SELECT thread_id FROM conversation_threads WHERE scope_key = ? ${open} ORDER BY updated_at DESC LIMIT 1
    `).get(scopeKey) as unknown as { thread_id: string } | undefined;
    if (latest) return latest.thread_id;
    const created = randomUUID();
    this.database.prepare(`
      INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at) VALUES (?, ?, 'シャノンから', ?, ?)
    `).run(created, scopeKey, at, at);
    return created;
  }
}

/** For a kernel without the SQLite tables (local runs, tests): the message is a note in the Talk, with no initiative. */
export function noteBodyLookSpeaker(
  store: {
    appendNote?(scopeKey: string, threadId: string, content: string, observedAt: string, noteKind: string): { id: string };
    /** The Talk a thread id names, or the latest one for an empty id (a screen look the owner started without naming a Talk). */
    threadId?(scopeKey: string, threadId?: string): string;
  },
): BodyLookSpeaker {
  return {
    say(scopeKey, requested, _look, text, at) {
      const threadId = requested ? requested : store.threadId?.(scopeKey) ?? requested;
      const note = store.appendNote?.(scopeKey, threadId, text, at, 'body-look');
      return note ? { id: note.id, threadId, text } : null;
    },
  };
}
