import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { formatYen } from './mind/inhibition/store/autonomyActivity.js';

/**
 * Tells the owner about a budget request the way Shannon tells them anything else:
 * one ordinary initiative message in her voice, in the most recent Talk.
 *
 * The request is limited to one per owner-local day by the budget store, and this
 * message is keyed by that request, so it never repeats. It does not use the day's
 * single spontaneous-topic slot, which stays with the initiative loop.
 */
export interface AutonomyBudgetAnnouncement {
  requestId: string;
  dayKey: string;
  reason: string;
  requestedYen: number;
  capYen: number;
}

export interface AutonomyAnnouncer {
  /** Returns the Talk the message was added to, or null when nothing was sent. */
  announceBudgetRequest(scopeKey: string, announcement: AutonomyBudgetAnnouncement, at: string): string | null;
}

/** Sentence presented as Shannon speaking (です・ます, ボク, ライ氏). */
export function budgetRequestMessage(announcement: AutonomyBudgetAnnouncement): string {
  const reason = announcement.reason.replace(/\s+/gu, ' ').trim().replace(/[。.!！]+$/u, '');
  return `${SHANNON_OWNER_NAME}、お願いがあります。今日の予算の${formatYen(announcement.capYen)}では足りなくなりそうです。`
    + `理由は「${reason}」です。今日だけ、あと${formatYen(announcement.requestedYen)}増やしてもらえますか。`
    + '増やすかどうかは、頭の中の「したことの記録」から決められます。断ってもらっても大丈夫です。';
}

export class DisabledAutonomyAnnouncer implements AutonomyAnnouncer {
  announceBudgetRequest(): string | null { return null; }
}

export class SQLiteAutonomyAnnouncer implements AutonomyAnnouncer {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  announceBudgetRequest(scopeKey: string, announcement: AutonomyBudgetAnnouncement, at: string): string | null {
    // The conversation and initiative tables belong to other stores; without them there is nowhere to speak.
    for (const table of ['initiative_messages', 'conversation_messages', 'conversation_threads']) {
      if (!this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) return null;
    }
    const content = budgetRequestMessage(announcement);
    const initiativeId = randomUUID();
    const sourceItemId = `autonomy-budget:${announcement.requestId}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const threadId = this.latestThread(scopeKey, at);
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO initiative_messages
          (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url,
           content, expression, day_key, created_at)
        VALUES (?, ?, ?, ?, '今日の予算', '', ?, 'thinking', ?, ?)
      `).run(initiativeId, scopeKey, threadId, sourceItemId, content, `autonomy-budget:${announcement.dayKey}`, at);
      if (!inserted.changes) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(randomUUID(), scopeKey, threadId, `initiative:${initiativeId}`, content, at, JSON.stringify({
        initiativeId, sourceItemId, autonomyBudgetRequestId: announcement.requestId,
      }));
      this.database.prepare(`
        UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?
      `).run(at, scopeKey, threadId);
      this.database.exec('COMMIT');
      return threadId;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private latestThread(scopeKey: string, at: string): string {
    const existing = this.database.prepare(`
      SELECT thread_id FROM conversation_threads
      WHERE scope_key = ? AND archived_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(scopeKey) as unknown as { thread_id: string } | undefined;
    if (existing) return existing.thread_id;
    const threadId = randomUUID();
    this.database.prepare(`
      INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at)
      VALUES (?, ?, 'シャノンから', ?, ?)
    `).run(threadId, scopeKey, at, at);
    return threadId;
  }
}
