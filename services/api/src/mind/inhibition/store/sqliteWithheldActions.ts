import type { DatabaseSync } from 'node:sqlite';
import { checkedWithheld, isWithheldReason, type StoredWithheld, type WithheldDraft } from '../../../contracts/withheldActionContract.js';

/**
 * Her withheld actions (Syzygy ADR-0008 §14; `contracts/withheldActionContract.ts`). Core: approval and budget.
 *
 * One row per tool call or step a rule stopped: the surface, the tool or step (a closed symbol), the reason and the rail (closed),
 * when it may be tried again, and when. Never a word of the call. Additive, created by the API process only, outside the numbered
 * migrations; kept 30 days.
 */
export const WITHHELD_TABLE = 'shannon_withheld_actions';

export function ensureWithheldSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_withheld_actions (
      withheld_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      surface TEXT NOT NULL CHECK (surface IN ('text', 'voice', 'autonomy')),
      tool TEXT NOT NULL,
      reason TEXT NOT NULL,
      rail TEXT NOT NULL CHECK (rail IN ('gate', 'budget', 'audience')),
      retry_at TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shannon_withheld_actions_scope ON shannon_withheld_actions (scope_key, at);
  `);
}

export class SQLiteWithheldActions {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureWithheldSchema(database);
  }

  insert(withheldId: string, scopeKey: string, draft: WithheldDraft, at: string): void {
    const checked = checkedWithheld(draft);
    if (!Number.isFinite(Date.parse(at))) throw new Error('WITHHELD_TIME');
    this.database.prepare('INSERT OR IGNORE INTO shannon_withheld_actions (withheld_id, scope_key, surface, tool, reason, rail, retry_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(withheldId, scopeKey, checked.surface, checked.tool, checked.reason, checked.rail, checked.retryAt, new Date(Date.parse(at)).toISOString());
  }

  /** The newest first, since an instant. */
  since(scopeKey: string, since: string, limit: number): StoredWithheld[] {
    return (this.database.prepare('SELECT * FROM shannon_withheld_actions WHERE scope_key = ? AND at >= ? ORDER BY at DESC, withheld_id LIMIT ?')
      .all(scopeKey, new Date(Date.parse(since)).toISOString(), Math.max(0, Math.trunc(limit))) as Array<Record<string, unknown>>).flatMap(parsed);
  }

  pruneBefore(before: string): number {
    return Number(this.database.prepare('DELETE FROM shannon_withheld_actions WHERE at < ?').run(before).changes);
  }
}

function parsed(row: Record<string, unknown>): StoredWithheld[] {
  if (!isWithheldReason(row.reason)) return [];
  return [{
    withheldId: String(row.withheld_id), scopeKey: String(row.scope_key), surface: String(row.surface) as StoredWithheld['surface'], tool: String(row.tool),
    reason: row.reason, rail: String(row.rail) as StoredWithheld['rail'], retryAt: row.retry_at === null ? null : String(row.retry_at), at: String(row.at),
  }];
}
