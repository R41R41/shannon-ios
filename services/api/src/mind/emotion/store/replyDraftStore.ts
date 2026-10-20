import { randomUUID } from 'node:crypto';
import { GUARD_FLAGS } from '@shannon/cognition';
import type { DatabaseSync } from 'node:sqlite';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { REPLY_DRAFTS_STEPS } from '../../../infra/sqlite/migrations/emotionSteps.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';

/**
 * Her rewritten drafts (owner 2026-10-20, `SHANNON_NATURAL_TALK`; table `shannon_reply_drafts`, schema step `emotion/007_reply_drafts`,
 * applied only when the switch opens this store). Core: emotion. The owner alone only (the caller hands only his turns): the first draft,
 * the flags it was rewritten for and the rewrite, for `REPLY_DRAFT_LIMITS.retentionDays` (pruned when the store opens and at every write).
 * A draft flagged for a guard line or a private matter is kept as its flags only, never its words (`WITHHELD_DRAFT`).
 */
export const REPLY_DRAFT_LIMITS = Object.freeze({ retentionDays: 7, characters: 4_000 });

export interface ReplyDraft { turn: string; flags: readonly string[]; first: string; second: string | null }

/** In place of the words of a draft that crossed a guard line or told a private matter. */
export const WITHHELD_DRAFT = '（守りの線か私的な事実の印が立ったので、本文は残していません）';
const withheld = (flags: readonly string[]) => flags.some(flag => (GUARD_FLAGS as readonly string[]).includes(flag) || flag === 'private_leak'
  || flag === 'marker_spoken');

export class SQLiteReplyDraftStore {
  private readonly database: DatabaseSync;
  private readonly owned: boolean;

  constructor(source: string | DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {
    this.owned = typeof source === 'string';
    this.database = typeof source === 'string' ? openDatabase(source, 'innerNotes') : source;
    applySchemaSteps(this.database, REPLY_DRAFTS_STEPS);
    if (typeof source === 'string') secureDatabaseFiles(source);
    this.prune();
  }

  /** Drops what is older than the retention. */
  prune(): void {
    const before = new Date(Date.parse(this.now()) - REPLY_DRAFT_LIMITS.retentionDays * 24 * 60 * 60_000).toISOString();
    this.database.prepare('DELETE FROM shannon_reply_drafts WHERE recorded_at < ?').run(before);
  }

  keep(scopeKey: string, draft: ReplyDraft): void {
    const words = (text: string | null) => (text === null ? null : withheld(draft.flags) ? WITHHELD_DRAFT : text.slice(0, REPLY_DRAFT_LIMITS.characters));
    this.database.prepare(`INSERT OR REPLACE INTO shannon_reply_drafts (scope_key, turn_id, flags_json, first_draft, rewrite, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(scopeKey, draft.turn || randomUUID(), JSON.stringify(draft.flags), words(draft.first) ?? '', words(draft.second),
      this.now());
    this.prune();
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
