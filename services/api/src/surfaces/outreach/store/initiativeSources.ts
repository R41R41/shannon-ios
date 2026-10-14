import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';

/**
 * What a body's delivery of her initiatives needs to know of each one (`initiativeFreshness.ts`, owner decision 2026-10-14): its
 * source key, when it was written, and whether a topic of the world carries her own words (`authoredOpening` in the message's
 * metadata, written by `initiativeStore.ts`). Read by id, for the ids of one inbox answer; it writes nothing. Without the tables it
 * answers nothing.
 */
export interface InitiativeSource {
  sourceItemId: string; createdAt: string; authored: boolean;
  /** A message of hers she chose to leave as text (`reachOut.spoken: false`, her moment speech, owner decision 2026-10-14). */
  textOnly?: true;
}

export class SQLiteInitiativeSources {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path, 'outreach');
  }

  sources(scopeKey: string, ids: readonly string[]): Map<string, InitiativeSource> {
    const found = new Map<string, InitiativeSource>();
    if (!ids.length || !this.tableExists('initiative_messages') || !this.tableExists('conversation_messages')) return found;
    const rows = this.database.prepare(`
      SELECT im.initiative_id, im.source_item_id, im.created_at, cm.metadata_json FROM initiative_messages im
      LEFT JOIN conversation_messages cm ON cm.scope_key = im.scope_key AND cm.turn_id = 'initiative:' || im.initiative_id
      WHERE im.scope_key = ? AND im.initiative_id IN (${ids.map(() => '?').join(', ')})
    `).all(scopeKey, ...ids) as unknown as Array<{ initiative_id: string; source_item_id: string; created_at: string; metadata_json: string | null }>;
    for (const row of rows) {
      found.set(row.initiative_id, { sourceItemId: row.source_item_id, createdAt: row.created_at, authored: authored(row.metadata_json),
        ...(textOnly(row.metadata_json) ? { textOnly: true as const } : {}) });
    }
    return found;
  }

  /** Whether an initiative from this source was already written (a promise's notice is written once). */
  delivered(scopeKey: string, sourceItemId: string): boolean {
    if (!this.tableExists('initiative_messages')) return false;
    const sql = 'SELECT 1 AS found FROM initiative_messages WHERE scope_key = ? AND source_item_id = ? LIMIT 1';
    return Boolean(this.database.prepare(sql).get(scopeKey, sourceItemId));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }
}

function authored(metadata: string | null): boolean {
  try { return metadata !== null && (JSON.parse(metadata) as { authoredOpening?: unknown }).authoredOpening === true; } catch { return false; }
}

function textOnly(metadata: string | null): boolean {
  try { return metadata !== null && (JSON.parse(metadata) as { reachOut?: { spoken?: unknown } }).reachOut?.spoken === false; } catch { return false; }
}
