/** What she did on her own, read from the database (Syzygy ADR-0008 stage 3, S2: the SQLite part of `ownOutreach.ts`, moved unchanged into the surface's store folder). */
import type { OwnBodyCallFact, OwnOutreachFacts, OwnOutreachReader } from '../ownOutreach.js';
import { DatabaseSync } from 'node:sqlite';

/** Source references of `initiative_messages` that are not her own initiative: an answer to a look in a conversation. */
const NOT_HER_INITIATIVE = ['body-look:'] as const;

/**
 * Reads the tables through its own connection. A table that does not exist yet holds nothing: no call can be
 * placed and no message sent without it. Any other failure reads as "cannot tell" (null).
 */
export class SQLiteOwnOutreach implements OwnOutreachReader {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 2000;');
  }

  recent(scopeKey: string, since: string, limit: number): OwnOutreachFacts | null {
    try {
      const tables = new Set((this.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('initiative_messages', 'incoming_calls', 'body_events', 'body_capabilities')`).all() as unknown as Array<{ name: string }>).map(row => row.name));
      const calls = tables.has('incoming_calls') ? (this.database.prepare(`
        SELECT created_at, state FROM incoming_calls WHERE scope_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 4
      `).all(scopeKey, since) as unknown as Array<{ created_at: string; state: string }>)
        .filter(row => Number.isFinite(Date.parse(row.created_at))).slice(0, 1).map(row => ({ createdAt: row.created_at, state: row.state })) : [];
      // A message she phoned with is the call's and is told as the call, unless the call could not ring and gave it back.
      const called = tables.has('incoming_calls')
        ? `AND initiative_id NOT IN (SELECT initiative_id FROM incoming_calls WHERE scope_key = ? AND state <> 'failed')` : '';
      const notHers = NOT_HER_INITIATIVE.map(() => 'AND source_item_id NOT LIKE ?').join(' ');
      const messages = tables.has('initiative_messages') ? (this.database.prepare(`
        SELECT content, created_at, read_at FROM initiative_messages WHERE scope_key = ? AND created_at >= ? ${called} ${notHers}
        ORDER BY created_at DESC LIMIT ?
      `).all(...[scopeKey, since, ...(called ? [scopeKey] : []), ...NOT_HER_INITIATIVE.map(prefix => `${prefix}%`)], Math.max(1, Math.trunc(limit)) + 4) as unknown as Array<{ content: string; created_at: string; read_at: string | null }>)
        .filter(row => Number.isFinite(Date.parse(row.created_at))).slice(0, Math.max(1, Math.trunc(limit)))
        .map(row => ({ createdAt: row.created_at, content: String(row.content), read: row.read_at !== null })) : [];
      return { messages, calls, bodyCalls: tables.has('body_events') && tables.has('body_capabilities') ? this.bodyCalls(scopeKey, since) : [] };
    } catch { return null; }
  }

  /** The latest voice call a full body (not one that only feels touch) started in the window, with its end when reported. */
  private bodyCalls(scopeKey: string, since: string): OwnBodyCallFact[] {
    const bodies = new Map((this.database.prepare('SELECT device_id, flags_json, surface FROM body_capabilities WHERE scope_key = ?')
      .all(scopeKey) as unknown as Array<{ device_id: string; flags_json: string; surface: string | null }>)
      .filter(row => { try { return (JSON.parse(row.flags_json) as Record<string, unknown>).touchOnly !== true; } catch { return false; } })
      .map(row => [row.device_id, row.surface] as const));
    if (!bodies.size) return [];
    const devices = [...bodies.keys()];
    const started = this.database.prepare(`
      SELECT device_id, occurred_at FROM body_events WHERE scope_key = ? AND event_type = 'callStarted' AND occurred_at >= ?
        AND device_id IN (${devices.map(() => '?').join(', ')}) ORDER BY occurred_at DESC LIMIT 1
    `).get(scopeKey, since, ...devices) as unknown as { device_id: string; occurred_at: string } | undefined;
    if (!started || !Number.isFinite(Date.parse(started.occurred_at))) return [];
    const ended = this.database.prepare(`
      SELECT occurred_at FROM body_events WHERE scope_key = ? AND device_id = ? AND event_type = 'callEnded' AND occurred_at >= ?
      ORDER BY occurred_at ASC LIMIT 1
    `).get(scopeKey, started.device_id, started.occurred_at) as unknown as { occurred_at: string } | undefined;
    const surface = bodies.get(started.device_id);
    return [{ startedAt: started.occurred_at, ...(ended ? { endedAt: ended.occurred_at } : {}), ...(surface === 'windows' || surface === 'mac' ? { surface } : {}) }];
  }

  close(): void { this.database.close(); }
}
