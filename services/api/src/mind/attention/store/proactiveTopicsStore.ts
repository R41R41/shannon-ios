import type { DatabaseSync } from 'node:sqlite';

/**
 * `proactive_topics` (Syzygy ADR-0008 stage 3, owner answer 2, `docs/mind-workspace-contract.md`): what each message she started
 * on her own was, as the proactive gate needs it, and nothing more: the delivery point, the intent's closed reason and subject key,
 * and the MinHash signature of what it was about (512 hexadecimal characters). Never her words. Additive; created by whichever
 * process holds the gate (her own time's worker, the world worker) while `SHANNON_PROACTIVE_GATE` is on. Kept 30 days.
 */
export const PROACTIVE_TOPICS_KEEP_DAYS = 30;

export interface ProactiveTopicRow { scopeKey: string; at: string; point: string; reason: string; subject: string | null; signature: string | null }

export function ensureProactiveTopicsSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS proactive_topics (
      topic_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      at TEXT NOT NULL,
      point TEXT NOT NULL CHECK (point IN ('say', 'say_again', 'say_by_phone', 'initiative', 'call')),
      reason TEXT NOT NULL,
      subject TEXT,
      signature TEXT CHECK (signature IS NULL OR (length(signature) = 512 AND signature NOT GLOB '*[^0-9a-f]*'))
    );
    CREATE INDEX IF NOT EXISTS proactive_topics_scope ON proactive_topics (scope_key, at);
  `);
}

export class SQLiteProactiveTopics {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureProactiveTopicsSchema(database);
  }

  record(row: ProactiveTopicRow): void {
    this.database.prepare('INSERT INTO proactive_topics (scope_key, at, point, reason, subject, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.scopeKey, row.at, row.point, row.reason, row.subject, row.signature);
  }

  /** Her messages since `since`, oldest first. */
  since(scopeKey: string, since: string): ProactiveTopicRow[] {
    return (this.database.prepare('SELECT * FROM proactive_topics WHERE scope_key = ? AND at >= ? ORDER BY at, topic_id').all(scopeKey, since) as Array<Record<string, unknown>>)
      .map(row => ({ scopeKey: String(row.scope_key), at: String(row.at), point: String(row.point), reason: String(row.reason),
        subject: row.subject === null ? null : String(row.subject), signature: row.signature === null ? null : String(row.signature) }));
  }

  /** When the owner last wrote or spoke in any Talk (a timestamp, never what he said); null without the conversation's table. */
  ownerLastActiveAt(scopeKey: string): string | null {
    if (!this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'conversation_messages'`).get()) return null;
    const row = this.database.prepare(`SELECT MAX(observed_at) AS latest FROM conversation_messages WHERE scope_key = ? AND role = 'user'`).get(scopeKey) as { latest: string | null } | undefined;
    return row?.latest ?? null;
  }

  prune(before: string): number {
    return Number(this.database.prepare('DELETE FROM proactive_topics WHERE at < ?').run(before).changes);
  }
}
