import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';
import { LIFECYCLE_OUTCOME_SOURCE_PREFIX } from '../../../contracts/minecraftLifecycleContract.js';

/**
 * Her message telling how a Minecraft lifecycle operation he asked for ended (owner decision 2026-10-14), delivered the way her
 * answer to a look is (`bodyLookDelivery.ts`): one assistant message in the Talk it was asked in (the most recent open one when that
 * Talk is gone), and one initiative so the apps, the push worker and her body notice it. Once per operation: the source reference
 * (`lifecycle-outcome:<operation id>`) is unique, and its day key is the reference, so the day's one message of her own is not
 * spent. No proactive gate: it answers his request.
 *
 * The message has no user side and no `turn.completed` event, so it is display history: the extraction after a turn never reads it.
 */
export interface LifecycleOutcomeMessage { id: string; threadId: string; initiativeId: string }

export class SQLiteLifecycleOutcomeSpeaker {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path, 'outreach');
  }

  /** Whether this operation's end was already told. */
  told(scopeKey: string, operationId: string): boolean {
    if (!this.tableExists('initiative_messages')) return false;
    return Boolean(this.database.prepare('SELECT 1 AS found FROM initiative_messages WHERE scope_key = ? AND source_item_id = ? LIMIT 1')
      .get(scopeKey, `${LIFECYCLE_OUTCOME_SOURCE_PREFIX}${operationId}`));
  }

  /** Says `text` once for this operation; null when it was already said or there is nowhere to say it. */
  say(scopeKey: string, threadId: string | null, operationId: string, text: string, done: boolean, at: string): LifecycleOutcomeMessage | null {
    for (const table of ['initiative_messages', 'conversation_messages', 'conversation_threads']) if (!this.tableExists(table)) return null;
    const initiativeId = randomUUID(), messageId = randomUUID();
    const sourceItemId = `${LIFECYCLE_OUTCOME_SOURCE_PREFIX}${operationId}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const thread = this.thread(scopeKey, threadId, at);
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO initiative_messages
          (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url, content, expression, day_key, created_at)
        VALUES (?, ?, ?, ?, 'マイクラ管理', '', ?, ?, ?, ?)
      `).run(initiativeId, scopeKey, thread, sourceItemId, text, done ? 'excited' : 'thinking', sourceItemId, at);
      if (!inserted.changes) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`
        INSERT INTO conversation_messages (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(messageId, scopeKey, thread, `initiative:${initiativeId}`, text, at, JSON.stringify({ initiativeId, sourceItemId }));
      this.database.prepare('UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?').run(at, scopeKey, thread);
      this.database.exec('COMMIT');
      return { id: messageId, threadId: thread, initiativeId };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  /** The Talk it was asked in while it is open, otherwise the most recent open one, otherwise a new one. */
  private thread(scopeKey: string, threadId: string | null, at: string): string {
    const open = 'AND archived_at IS NULL';
    if (threadId && this.database.prepare(`SELECT 1 AS found FROM conversation_threads WHERE scope_key = ? AND thread_id = ? ${open}`)
      .get(scopeKey, threadId)) return threadId;
    const latest = this.database.prepare(`SELECT thread_id FROM conversation_threads WHERE scope_key = ? ${open} ORDER BY updated_at DESC LIMIT 1`)
      .get(scopeKey) as unknown as { thread_id: string } | undefined;
    if (latest) return latest.thread_id;
    const created = randomUUID();
    this.database.prepare(`INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at) VALUES (?, ?, 'シャノンから', ?, ?)`)
      .run(created, scopeKey, at, at);
    return created;
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }
}
