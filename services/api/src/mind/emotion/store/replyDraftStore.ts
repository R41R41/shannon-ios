import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { REPLY_DRAFTS_STEPS } from '../../../infra/sqlite/migrations/emotionSteps.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';

/**
 * Her rewritten drafts (owner 2026-10-20, `SHANNON_NATURAL_TALK`; table `shannon_reply_drafts`, schema step `emotion/007_reply_drafts`,
 * applied only when the switch opens this store). Core: emotion. The owner alone only (the caller hands only his turns): the first draft,
 * the flags it was rewritten for and the rewrite, for `REPLY_DRAFT_LIMITS.retentionDays`; every write prunes what is older.
 */
export const REPLY_DRAFT_LIMITS = Object.freeze({ retentionDays: 7, characters: 4_000 });

export interface ReplyDraft { turn: string; flags: readonly string[]; first: string; second: string | null }

export class SQLiteReplyDraftStore {
  private readonly database: DatabaseSync;
  private readonly owned: boolean;

  constructor(source: string | DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {
    this.owned = typeof source === 'string';
    this.database = typeof source === 'string' ? openDatabase(source, 'innerNotes') : source;
    applySchemaSteps(this.database, REPLY_DRAFTS_STEPS);
    if (typeof source === 'string') secureDatabaseFiles(source);
  }

  keep(scopeKey: string, draft: ReplyDraft): void {
    const at = this.now();
    this.database.prepare(`INSERT OR REPLACE INTO shannon_reply_drafts (scope_key, turn_id, flags_json, first_draft, rewrite, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(scopeKey, draft.turn || randomUUID(), JSON.stringify(draft.flags), draft.first.slice(0, REPLY_DRAFT_LIMITS.characters),
      draft.second === null ? null : draft.second.slice(0, REPLY_DRAFT_LIMITS.characters), at);
    const before = new Date(Date.parse(at) - REPLY_DRAFT_LIMITS.retentionDays * 24 * 60 * 60_000).toISOString();
    this.database.prepare('DELETE FROM shannon_reply_drafts WHERE recorded_at < ?').run(before);
  }

  /** A scope's drafts, newest first (diagnosis and tests). */
  recent(scopeKey: string, limit = 50): (ReplyDraft & { at: string })[] {
    const rows = this.database.prepare(`SELECT turn_id, flags_json, first_draft, rewrite, recorded_at FROM shannon_reply_drafts WHERE scope_key = ?
      ORDER BY recorded_at DESC LIMIT ?`).all(scopeKey, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map(row => ({ turn: String(row.turn_id), flags: flagsOf(row.flags_json), first: String(row.first_draft),
      second: typeof row.rewrite === 'string' ? row.rewrite : null, at: String(row.recorded_at) }));
  }

  close(): void {
    if (this.owned) this.database.close();
  }
}

function flagsOf(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter((flag): flag is string => typeof flag === 'string') : [];
  } catch { return []; }
}
