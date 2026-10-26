import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import type { ShannonPlatform } from '../../../mind/memory/platformMemoryPorts.js';
import { PLATFORM_REACTION_LIMITS, type PlatformReactionLog, type RecordedPlatformReaction, type StoredPlatformReaction } from '../platformReactions.js';
import { ensurePlatformReactionSchema } from './platformReactionsMigration.js';

/** The events, in the database the platform's answer logs use (`platform_reaction_events`). */
export class SQLitePlatformReactionLog implements PlatformReactionLog {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    this.database = openDatabase(path, 'platformReactions');
    ensurePlatformReactionSchema(this.database);
    secureDatabaseFiles(path);
  }
  record(scopeKey: string, event: RecordedPlatformReaction, at: string): void {
    this.database.prepare('DELETE FROM platform_reaction_events WHERE created_at < ?')
      .run(new Date(Date.parse(at) - PLATFORM_REACTION_LIMITS.keepHours * 3_600_000).toISOString());
    this.database.prepare(`INSERT INTO platform_reaction_events
      (scope_key, platform, conversation_id, message_id, event_json, observed_at, created_at, noticed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(scopeKey, event.platform, event.conversationId, event.messageId, JSON.stringify(event), event.observedAt, at);
  }
  unnoticed(scopeKey: string, platform: ShannonPlatform, conversationId: string, since: string, limit: number): StoredPlatformReaction[] {
    const rows = this.database.prepare(`SELECT rowid, event_json FROM platform_reaction_events
      WHERE scope_key = ? AND platform = ? AND conversation_id = ? AND noticed_at IS NULL AND observed_at >= ? ORDER BY observed_at, rowid LIMIT ?`)
      .all(scopeKey, platform, conversationId, since, limit) as Array<{ rowid: number; event_json: string }>;
    return rows.flatMap(row => {
      try { return [{ ...JSON.parse(row.event_json) as RecordedPlatformReaction, rowid: Number(row.rowid) }]; } catch { return []; }
    });
  }
  markNoticed(scopeKey: string, rowids: readonly number[], at: string): void {
    const statement = this.database.prepare('UPDATE platform_reaction_events SET noticed_at = ? WHERE scope_key = ? AND rowid = ? AND noticed_at IS NULL');
    for (const rowid of rowids) statement.run(at, scopeKey, rowid);
  }
  close(): void { if (this.database.isOpen) this.database.close(); }
}
