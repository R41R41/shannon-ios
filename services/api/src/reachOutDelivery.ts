import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { UNLABELLED_DISCLOSURE_MARKER } from '@shannon/cognition';
import { REACH_OUT_REASONS, type ReachOutReason } from './autonomyLoopPrompts.js';
import { speakTimePrivacyCheck } from './voiceCompanionPresence.js';

/**
 * A message she starts on her own, from her own activity (owner decision 2026-10-02),
 * delivered the way she says anything unprompted: one assistant message in the owner's
 * most recent Talk and one initiative, which the apps, the push worker and her body read.
 *
 * It does not use the day's one spontaneous-topic slot. Its own key is
 * `reach-out:<owner-local day>:<n>`, and the unique day key of `initiative_messages`
 * makes the daily count hold even if two writers race. The message has no user side and
 * no `turn.completed` event, so nothing is learned about the owner from it.
 */
export const REACH_OUT_SOURCE_PREFIX = 'reach-out:';
export const REACH_OUT_SOURCE_TITLE = 'シャノンから';

const EXPRESSION: Readonly<Record<ReachOutReason, 'curious' | 'excited' | 'thinking'>> = Object.freeze({
  share: 'excited', wonder: 'curious', upcoming: 'thinking', saw: 'curious',
});

/** What a source reference says about a reach-out, or null. `GET /v1/initiatives` returns it as `kind` and `reason`. */
export function reachOutOfSource(sourceItemId: unknown): { kind: 'reach_out'; reason: ReachOutReason } | null {
  if (typeof sourceItemId !== 'string' || !sourceItemId.startsWith(REACH_OUT_SOURCE_PREFIX)) return null;
  const reason = sourceItemId.slice(REACH_OUT_SOURCE_PREFIX.length).split(':')[0];
  return (REACH_OUT_REASONS as readonly string[]).includes(reason ?? '') ? { kind: 'reach_out', reason: reason as ReachOutReason } : null;
}

export type ReachOutDelivery = 'sent' | 'limit' | 'unavailable';

/**
 * What the prompt of a reach-out receives while someone other than the owner may see or hear her body:
 * the speak-time check and the marker of a conversation turn with other people present, unchanged.
 */
export const REACH_OUT_OTHERS_AUDIENCE = Object.freeze({
  instructions: [
    '[Other people may hear this — 同席者あり]\n- Her body reported that people other than ライ氏 can see or hear her now. This message is shown and spoken aloud by the body and may reach them.',
    speakTimePrivacyCheck,
  ].join('\n\n'),
  marker: UNLABELLED_DISCLOSURE_MARKER,
});

export class SQLiteReachOutSpeaker {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly others: (scopeKey: string, at: string) => boolean = () => false) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  /** Messages she started on the owner-local day. */
  sentOn(scopeKey: string, dayKey: string): number {
    if (!this.tableExists('initiative_messages')) return 0;
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM initiative_messages WHERE scope_key = ? AND day_key LIKE ?
    `).get(scopeKey, `${REACH_OUT_SOURCE_PREFIX}${dayKey}:%`) as unknown as { count: number };
    return Number(row.count);
  }

  lastSentAt(scopeKey: string): string | null {
    if (!this.tableExists('initiative_messages')) return null;
    const row = this.database.prepare(`
      SELECT MAX(created_at) AS latest FROM initiative_messages WHERE scope_key = ? AND source_item_id LIKE ?
    `).get(scopeKey, `${REACH_OUT_SOURCE_PREFIX}%`) as unknown as { latest: string | null };
    return row.latest ?? null;
  }

  /** Reach-outs the owner has not read yet, for the body: how many, and the newest one. */
  pending(scopeKey: string): { pending: number; latestId?: string } {
    if (!this.tableExists('initiative_messages')) return { pending: 0 };
    const rows = this.database.prepare(`
      SELECT initiative_id FROM initiative_messages WHERE scope_key = ? AND read_at IS NULL AND source_item_id LIKE ?
      ORDER BY created_at DESC LIMIT 20
    `).all(scopeKey, `${REACH_OUT_SOURCE_PREFIX}%`) as unknown as Array<{ initiative_id: string }>;
    return rows.length ? { pending: rows.length, latestId: rows[0]!.initiative_id } : { pending: 0 };
  }

  /** The speak-time rules and marker while someone other than the owner can see or hear her body, as far as the server was told; otherwise null. */
  audience(scopeKey: string, at: string): { instructions: string; marker: string } | null {
    try { return this.others(scopeKey, at) ? REACH_OUT_OTHERS_AUDIENCE : null; } catch { return null; }
  }

  say(scopeKey: string, input: { reason: ReachOutReason; text: string; dayKey: string; maximumPerDay: number }, at: string): ReachOutDelivery {
    // The conversation and initiative tables belong to other stores; without them there is nowhere to speak.
    for (const table of ['initiative_messages', 'conversation_messages', 'conversation_threads']) {
      if (!this.tableExists(table)) return 'unavailable';
    }
    const initiativeId = randomUUID();
    const sourceItemId = `${REACH_OUT_SOURCE_PREFIX}${input.reason}:${initiativeId}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const taken = new Set((this.database.prepare(`
        SELECT day_key FROM initiative_messages WHERE scope_key = ? AND day_key LIKE ?
      `).all(scopeKey, `${REACH_OUT_SOURCE_PREFIX}${input.dayKey}:%`) as unknown as Array<{ day_key: string }>).map(row => row.day_key));
      const slot = Array.from({ length: Math.max(0, input.maximumPerDay) }, (_, index) => `${REACH_OUT_SOURCE_PREFIX}${input.dayKey}:${index + 1}`)
        .find(key => !taken.has(key));
      if (!slot || taken.size >= input.maximumPerDay) {
        this.database.exec('ROLLBACK');
        return 'limit';
      }
      const threadId = this.latestThread(scopeKey, at);
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO initiative_messages
          (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url,
           content, expression, day_key, created_at)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)
      `).run(initiativeId, scopeKey, threadId, sourceItemId, REACH_OUT_SOURCE_TITLE, input.text, EXPRESSION[input.reason], slot, at);
      if (!inserted.changes) {
        this.database.exec('ROLLBACK');
        return 'limit';
      }
      this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(randomUUID(), scopeKey, threadId, `initiative:${initiativeId}`, input.text, at, JSON.stringify({
        initiativeId, sourceItemId, reachOut: { reason: input.reason },
      }));
      this.database.prepare('UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?').run(at, scopeKey, threadId);
      this.database.exec('COMMIT');
      return 'sent';
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private latestThread(scopeKey: string, at: string): string {
    const columns = this.database.prepare(`PRAGMA table_info('conversation_threads')`).all() as unknown as Array<{ name: string }>;
    const open = columns.some(column => column.name === 'archived_at') ? 'AND archived_at IS NULL' : '';
    const existing = this.database.prepare(`
      SELECT thread_id FROM conversation_threads WHERE scope_key = ? ${open} ORDER BY updated_at DESC LIMIT 1
    `).get(scopeKey) as unknown as { thread_id: string } | undefined;
    if (existing) return existing.thread_id;
    const threadId = randomUUID();
    this.database.prepare(`
      INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at) VALUES (?, ?, 'シャノンから', ?, ?)
    `).run(threadId, scopeKey, at, at);
    return threadId;
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }
}
