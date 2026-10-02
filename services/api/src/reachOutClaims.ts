import { DatabaseSync } from 'node:sqlite';
import { REACH_OUT_SOURCE_PREFIX, reachOutOfSource } from './reachOutDelivery.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

/**
 * Which surface speaks one message she started on her own (`docs/private-listening-contract.md`).
 *
 * Her body, the Mac app and the iPhone app can each say a message aloud. Exactly one of them does:
 * the first to hold the message's claim. The claim is one row whose primary key is the message, so
 * two devices that ask at the same instant cannot both get it, and it stays through a restart.
 * A claim holds identifiers, a closed surface and a timestamp; no text.
 */
export const REACH_OUT_SURFACES = ['body', 'mac', 'iphone'] as const;
export type ReachOutSurface = typeof REACH_OUT_SURFACES[number];

export interface ReachOutClaim { deviceId: string; surface: ReachOutSurface; claimedAt: string; /** When the holder said it had spoken the message; null until then. */ spokenAt: string | null }

/** One of her own unread messages, as far as choosing its surface needs it: identifiers and a time. */
export interface UnreadReachOut { id: string; createdAt: string; claim: ReachOutClaim | null }

/** Her message as the claiming app speaks it. */
export interface ClaimedReachOut { id: string; threadId: string; content: string; expression: string; reason: string; createdAt: string }

export type ReachOutClaimResult = 'claimed' | 'held' | 'taken';

export class SQLiteReachOutClaims {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS reach_out_claims (
        scope_key TEXT NOT NULL,
        initiative_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        surface TEXT NOT NULL CHECK (surface IN ('body', 'mac', 'iphone')),
        claimed_at TEXT NOT NULL,
        spoken_at TEXT,
        PRIMARY KEY (scope_key, initiative_id)
      );
      CREATE TABLE IF NOT EXISTS reach_out_declines (
        scope_key TEXT NOT NULL,
        initiative_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        declined_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, initiative_id, device_id)
      );
    `);
    secureDatabaseFiles(path);
  }

  /**
   * Takes the message for one device. `claimed`: this request took it. `held`: the same device already
   * holds it (a repeated request). `taken`: another device holds it, and nothing changed.
   */
  claim(scopeKey: string, initiativeId: string, deviceId: string, surface: ReachOutSurface, at: string): ReachOutClaimResult {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO reach_out_claims (scope_key, initiative_id, device_id, surface, claimed_at) VALUES (?, ?, ?, ?, ?)
    `).run(scopeKey, initiativeId, deviceId, surface, at);
    if (Number(inserted.changes) > 0) return 'claimed';
    return this.holder(scopeKey, initiativeId)?.deviceId === deviceId ? 'held' : 'taken';
  }

  /** Gives the message back, only if this device holds it and has not spoken it. Another surface may then take it. */
  release(scopeKey: string, initiativeId: string, deviceId: string): boolean {
    return Number(this.database.prepare(`
      DELETE FROM reach_out_claims WHERE scope_key = ? AND initiative_id = ? AND device_id = ? AND spoken_at IS NULL
    `).run(scopeKey, initiativeId, deviceId).changes) > 0;
  }

  /**
   * An app took the message, could not say it (private listening had ended) and gave it back. It is not offered to that
   * device again, and that device no longer keeps the message from the other surfaces.
   */
  decline(scopeKey: string, initiativeId: string, deviceId: string, at: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO reach_out_declines (scope_key, initiative_id, device_id, declined_at) VALUES (?, ?, ?, ?)
    `).run(scopeKey, initiativeId, deviceId, at);
  }

  /** The devices that gave this message back. */
  declinedBy(scopeKey: string, initiativeId: string): ReadonlySet<string> {
    const rows = this.database.prepare(`
      SELECT device_id FROM reach_out_declines WHERE scope_key = ? AND initiative_id = ?
    `).all(scopeKey, initiativeId) as unknown as Array<{ device_id: string }>;
    return new Set(rows.map(row => row.device_id));
  }

  /** The holder spoke the message: from here the claim is never given back. Returns whether this was the first time. */
  markSpoken(scopeKey: string, initiativeId: string, deviceId: string, at: string): boolean {
    return Number(this.database.prepare(`
      UPDATE reach_out_claims SET spoken_at = ? WHERE scope_key = ? AND initiative_id = ? AND device_id = ? AND spoken_at IS NULL
    `).run(at, scopeKey, initiativeId, deviceId).changes) > 0;
  }

  holder(scopeKey: string, initiativeId: string): ReachOutClaim | null {
    const row = this.database.prepare(`
      SELECT device_id, surface, claimed_at, spoken_at FROM reach_out_claims WHERE scope_key = ? AND initiative_id = ?
    `).get(scopeKey, initiativeId) as unknown as ClaimRow | undefined;
    return row ? claimOf(row) : null;
  }

  /** Her own messages the owner has not read, newest first, each with who holds it. At most twenty, as her body is told. */
  unread(scopeKey: string): readonly UnreadReachOut[] {
    if (!this.tableExists('initiative_messages')) return [];
    const rows = this.database.prepare(`
      SELECT m.initiative_id, m.created_at, c.device_id, c.surface, c.claimed_at, c.spoken_at
      FROM initiative_messages m LEFT JOIN reach_out_claims c ON c.scope_key = m.scope_key AND c.initiative_id = m.initiative_id
      WHERE m.scope_key = ? AND m.read_at IS NULL AND m.source_item_id LIKE ?
      ORDER BY m.created_at DESC LIMIT 20
    `).all(scopeKey, `${REACH_OUT_SOURCE_PREFIX}%`) as unknown as Array<{ initiative_id: string; created_at: string; device_id: string | null; surface: string | null; claimed_at: string | null; spoken_at: string | null }>;
    return rows.map(row => ({
      id: row.initiative_id, createdAt: row.created_at,
      claim: row.device_id && row.surface && row.claimed_at ? claimOf({ device_id: row.device_id, surface: row.surface, claimed_at: row.claimed_at, spoken_at: row.spoken_at }) : null,
    }));
  }

  /** One of her own messages with its words, for the device that claimed it; null for anything else, or once it was read. */
  message(scopeKey: string, initiativeId: string): (ClaimedReachOut & { read: boolean }) | null {
    if (!this.tableExists('initiative_messages')) return null;
    const row = this.database.prepare(`
      SELECT initiative_id, thread_id, content, expression, source_item_id, created_at, read_at
      FROM initiative_messages WHERE scope_key = ? AND initiative_id = ? AND source_item_id LIKE ?
    `).get(scopeKey, initiativeId, `${REACH_OUT_SOURCE_PREFIX}%`) as unknown as {
      initiative_id: string; thread_id: string; content: string; expression: string; source_item_id: string; created_at: string; read_at: string | null;
    } | undefined;
    const known = reachOutOfSource(row?.source_item_id);
    if (!row || !known) return null;
    return { id: row.initiative_id, threadId: row.thread_id, content: row.content, expression: row.expression, reason: known.reason, createdAt: row.created_at, read: row.read_at !== null };
  }

  /** Whether the owner wrote or spoke in any Talk after the instant. A yes or no from timestamps; no content is read. */
  ownerActiveAfter(scopeKey: string, after: string): boolean {
    if (!this.tableExists('conversation_messages')) return false;
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM conversation_messages WHERE scope_key = ? AND role = 'user' AND observed_at > ? LIMIT 1
    `).get(scopeKey, after));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }
}

interface ClaimRow { device_id: string; surface: string; claimed_at: string; spoken_at: string | null }

function claimOf(row: ClaimRow): ReachOutClaim | null {
  const surface = REACH_OUT_SURFACES.find(value => value === row.surface);
  return surface ? { deviceId: row.device_id, surface, claimedAt: row.claimed_at, spokenAt: row.spoken_at ?? null } : null;
}
