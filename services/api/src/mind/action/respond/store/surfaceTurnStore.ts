import { DatabaseSync } from 'node:sqlite';
import { secureDatabaseFiles } from '../../../../infra/sqlite/sqliteStoreContext.js';

/**
 * The answer given to each game-chat turn of her Minecraft body, by requestId, so that a retried request gets
 * the same reply and is not answered (and paid for) twice. Additive table; rows older than the replay window
 * are dropped on a later write. It holds what was already said in the game, nothing more.
 */
export interface StoredMinecraftTurn {
  payloadHash: string;
  response: Record<string, unknown>;
}

export interface MinecraftTurnLog {
  find(scopeKey: string, requestId: string): StoredMinecraftTurn | null;
  save(scopeKey: string, requestId: string, deviceId: string, payloadHash: string, response: Record<string, unknown>, at: string, keepDays: number): void;
}

/**
 * The answer log of a surface that answers through the conversation kernel. Her Minecraft body keeps it in
 * `minecraft_body_turns`; the platform reply route (`platformReply.ts`) in `platform_reply_turns`, the voice channel
 * (`platformVoice.ts`) in `platform_voice_turns`, where `device_id` holds
 * the platform. Same shape, separate tables.
 */
const SURFACE_TURN_TABLES = ['minecraft_body_turns', 'platform_reply_turns', 'platform_voice_turns'] as const;
export type SurfaceTurnTable = (typeof SURFACE_TURN_TABLES)[number];

export class SQLiteSurfaceTurnLog implements MinecraftTurnLog {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly table: SurfaceTurnTable) {
    if (!SURFACE_TURN_TABLES.includes(table)) throw new Error('Unknown surface turn table');
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        scope_key TEXT NOT NULL,
        request_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, request_id)
      );
      CREATE INDEX IF NOT EXISTS ${table}_created ON ${table} (created_at);
    `);
    secureDatabaseFiles(path);
  }

  find(scopeKey: string, requestId: string): StoredMinecraftTurn | null {
    const row = this.database.prepare(`SELECT payload_hash, response_json FROM ${this.table} WHERE scope_key = ? AND request_id = ?`)
      .get(scopeKey, requestId) as unknown as { payload_hash: string; response_json: string } | undefined;
    if (!row) return null;
    try {
      return { payloadHash: row.payload_hash, response: JSON.parse(row.response_json) as Record<string, unknown> };
    } catch { return null; }
  }

  save(scopeKey: string, requestId: string, deviceId: string, payloadHash: string, response: Record<string, unknown>, at: string, keepDays: number): void {
    this.database.prepare(`DELETE FROM ${this.table} WHERE created_at < ?`)
      .run(new Date(Date.parse(at) - keepDays * 24 * 60 * 60_000).toISOString());
    this.database.prepare(`
      INSERT OR IGNORE INTO ${this.table} (scope_key, request_id, device_id, payload_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(scopeKey, requestId, deviceId, payloadHash, JSON.stringify(response), at);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

export class SQLiteMinecraftTurnLog extends SQLiteSurfaceTurnLog {
  constructor(path: string) { super(path, 'minecraft_body_turns'); }
}

/** The same, kept in memory: for tests and for a server without a database file. */
export class InMemoryMinecraftTurnLog implements MinecraftTurnLog {
  private readonly rows = new Map<string, StoredMinecraftTurn>();
  find(scopeKey: string, requestId: string): StoredMinecraftTurn | null { return this.rows.get(`${scopeKey}\u0000${requestId}`) ?? null; }
  save(scopeKey: string, requestId: string, _deviceId: string, payloadHash: string, response: Record<string, unknown>): void {
    const key = `${scopeKey}\u0000${requestId}`;
    if (!this.rows.has(key)) this.rows.set(key, { payloadHash, response });
  }
}
