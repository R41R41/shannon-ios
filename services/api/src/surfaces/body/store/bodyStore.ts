import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { touchDetailDigest, type BodyAudience, type BodyCapabilities, type BodyEvent, type BodyEventType } from '../../../contracts/bodyContract.js';
import { BODY_TOUCH_ONLY_FLAG } from '../bodyTouchOnly.js';
import { isBodySurface, isBodyTouchRegion, type BodySurface } from '../bodyTouchWords.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';

/**
 * What the body reported and what it says it can express. Both tables are additive
 * and hold closed vocabulary, numbers and identifiers only: no text from the body.
 */
export interface StoredBodyEvent extends BodyEvent {
  deviceId: string;
  receivedAt: string;
}

export interface StoredBodyCapabilities extends BodyCapabilities {
  updatedAt: string;
}

export type BodyEventOutcome = 'stored' | 'duplicate' | 'conflict';

interface EventRow {
  event_key: string; device_id: string; event_type: string; audience: string; occurred_at: string; received_at: string;
  duration_ms: number | null; strength: number | null; minutes_away: number | null; content_hash: string; region: string | null;
  cause: string | null;
}

// The part is in the hash only when it was sent, so an event stored before parts existed still answers `duplicate`.
const contentHash = (event: BodyEvent) => createHash('sha256').update(JSON.stringify([
  event.type, event.audience, event.occurredAt, event.durationMs ?? null, event.strength ?? null, event.minutesAway ?? null,
  ...(event.region !== undefined ? [event.region] : []),
  // Touch vocabulary 2: only the fields that were sent, tagged, so an event in the old shape hashes as it always did.
  ...touchDetailDigest(event),
  // Only game events have a cause: every other event hashes as it always did.
  ...(event.cause !== undefined ? [`cause:${event.cause}`] : []),
])).digest('hex').slice(0, 32);

/**
 * Adds a column that may already be there. The API process and her activity worker open the same database and
 * may both arrive here at once: the one that comes second finds the column added and carries on.
 */
export function addColumnOnce(database: DatabaseSync, table: string, column: string, type: string): void {
  const has = () => (database.prepare(`PRAGMA table_info('${table}')`).all() as unknown as Array<{ name: string }>).some(item => item.name === column);
  if (has()) return;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (error) {
    if (!has()) throw error;
  }
}

export class SQLiteBodyStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS body_events (
        scope_key TEXT NOT NULL,
        event_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('owner', 'others')),
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        day_key TEXT NOT NULL,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        strength REAL CHECK (strength IS NULL OR (strength >= 0 AND strength <= 1)),
        minutes_away INTEGER CHECK (minutes_away IS NULL OR minutes_away >= 0),
        content_hash TEXT NOT NULL,
        PRIMARY KEY (scope_key, event_key)
      );
      CREATE INDEX IF NOT EXISTS body_events_scope_audience_time ON body_events (scope_key, audience, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS body_events_scope_day ON body_events (scope_key, day_key);
      CREATE TABLE IF NOT EXISTS body_capabilities (
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        expressions_json TEXT NOT NULL,
        gestures_json TEXT NOT NULL,
        flags_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, device_id)
      );
      CREATE TABLE IF NOT EXISTS body_audience (
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('owner', 'others')),
        reported_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, device_id)
      );
    `);
    // Added 2026-10-03: the touched part of an event, and where a registered body is.
    addColumnOnce(this.database, 'body_events', 'region', 'TEXT');
    addColumnOnce(this.database, 'body_capabilities', 'surface', 'TEXT');
    // Added 2026-10-05: what killed her Minecraft body (`game.died`).
    addColumnOnce(this.database, 'body_events', 'cause', 'TEXT');
    secureDatabaseFiles(path);
  }

  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Stores one event once. The same key with the same content is a duplicate; with other content, a conflict. */
  record(scopeKey: string, deviceId: string, event: BodyEvent, receivedAt: string, dayKey: string): BodyEventOutcome {
    const hash = contentHash(event);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO body_events (
        scope_key, event_key, device_id, event_type, audience, occurred_at, received_at, day_key,
        duration_ms, strength, minutes_away, content_hash, region, cause
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, event.id, deviceId, event.type, event.audience, event.occurredAt, receivedAt, dayKey,
      event.durationMs ?? null, event.strength ?? null, event.minutesAway ?? null, hash, event.region ?? null, event.cause ?? null);
    return Number(result.changes) > 0 ? 'stored' : this.known(scopeKey, event) ?? 'conflict';
  }

  /** How a key that may already be stored relates to this event; null when the key is new. */
  known(scopeKey: string, event: BodyEvent): Exclude<BodyEventOutcome, 'stored'> | null {
    const row = this.database.prepare('SELECT content_hash FROM body_events WHERE scope_key = ? AND event_key = ?')
      .get(scopeKey, event.id) as unknown as { content_hash: string } | undefined;
    return row ? (row.content_hash === contentHash(event) ? 'duplicate' : 'conflict') : null;
  }

  countForDay(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM body_events WHERE scope_key = ? AND day_key = ?')
      .get(scopeKey, dayKey) as unknown as { count: number };
    return Number(row.count);
  }

  /** Newest first. The audience is part of the query so that a caller cannot forget to filter. */
  recent(scopeKey: string, audience: BodyAudience, sinceOccurredAt: string, limit: number): readonly StoredBodyEvent[] {
    const rows = this.database.prepare(`
      SELECT * FROM body_events WHERE scope_key = ? AND audience = ? AND occurred_at >= ?
      ORDER BY occurred_at DESC, received_at DESC LIMIT ?
    `).all(scopeKey, audience, sinceOccurredAt, Math.max(1, Math.min(200, Math.trunc(limit)))) as unknown as EventRow[];
    return rows.map(row => ({
      id: row.event_key, type: row.event_type as BodyEventType, audience: row.audience as BodyAudience,
      occurredAt: row.occurred_at, deviceId: row.device_id, receivedAt: row.received_at,
      ...(row.duration_ms !== null ? { durationMs: Number(row.duration_ms) } : {}),
      ...(row.strength !== null ? { strength: Number(row.strength) } : {}),
      ...(row.minutes_away !== null ? { minutesAway: Number(row.minutes_away) } : {}),
      ...(isBodyTouchRegion(row.region) ? { region: row.region } : {}),
      ...(row.cause ? { cause: row.cause } : {}),
    }));
  }

  /** The newest event of the given types in `[since, until]`, whoever was around: a type and a time, for the activity loop. */
  latestOfTypes(scopeKey: string, types: readonly string[], since: string, until: string): { type: string; occurredAt: string } | null {
    if (!types.length) return null;
    const row = this.database.prepare(`
      SELECT event_type, occurred_at FROM body_events
      WHERE scope_key = ? AND occurred_at >= ? AND occurred_at <= ? AND event_type IN (${types.map(() => '?').join(', ')})
      ORDER BY occurred_at DESC, received_at DESC LIMIT 1
    `).get(scopeKey, since, until, ...types) as unknown as { event_type: string; occurred_at: string } | undefined;
    return row ? { type: row.event_type, occurredAt: row.occurred_at } : null;
  }

  /** The newest `ownerReturned` in `[since, until]`, whoever was around: its key, its time and how long he was away (`proactiveMoments.ts`). */
  latestReturn(scopeKey: string, since: string, until: string): { id: string; occurredAt: string; minutesAway: number } | null {
    const row = this.database.prepare(`
      SELECT event_key, occurred_at, minutes_away FROM body_events
      WHERE scope_key = ? AND occurred_at >= ? AND occurred_at <= ? AND event_type = 'ownerReturned'
      ORDER BY occurred_at DESC, received_at DESC LIMIT 1
    `).get(scopeKey, since, until) as unknown as { event_key: string; occurred_at: string; minutes_away: number | null } | undefined;
    return row ? { id: row.event_key, occurredAt: row.occurred_at, minutesAway: Number(row.minutes_away ?? 0) } : null;
  }

  /** `callStarted` / `callEnded` of the scope in `[since, until]`, any audience: a device, a type and a time (`ownerCallElsewhere.ts`). */
  callEvents(scopeKey: string, since: string, until: string): Array<{ deviceId: string; type: 'callStarted' | 'callEnded'; occurredAt: string; receivedAt: string }> {
    const rows = this.database.prepare(`
      SELECT device_id, event_type, occurred_at, received_at FROM body_events
      WHERE scope_key = ? AND audience IN ('owner', 'others') AND occurred_at >= ? AND occurred_at <= ? AND event_type IN ('callStarted', 'callEnded')
      ORDER BY occurred_at DESC LIMIT 200
    `).all(scopeKey, since, until) as unknown as Array<{ device_id: string; event_type: string; occurred_at: string; received_at: string }>;
    return rows.map(row => ({ deviceId: row.device_id, type: row.event_type === 'callEnded' ? 'callEnded' : 'callStarted', occurredAt: row.occurred_at, receivedAt: row.received_at }));
  }

  /** Who can see or hear the body, as it said on a presence read. One row per device. */
  noteAudience(scopeKey: string, deviceId: string, audience: BodyAudience, at: string): void {
    this.database.prepare(`
      INSERT INTO body_audience (scope_key, device_id, audience, reported_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET audience = excluded.audience, reported_at = excluded.reported_at
    `).run(scopeKey, deviceId, audience, at);
  }

  /**
   * True while someone other than the owner can see or hear the body, as far as it told the server:
   * a presence read in the last `freshMilliseconds` said so, or, when no body reported lately,
   * the newest event of the last `eventWindowMilliseconds` carried `others`.
   */
  othersPresent(scopeKey: string, at: string, freshMilliseconds: number, eventWindowMilliseconds: number): boolean {
    const time = Date.parse(at);
    const reports = this.database.prepare('SELECT audience FROM body_audience WHERE scope_key = ? AND reported_at >= ? AND reported_at <= ?')
      .all(scopeKey, new Date(time - freshMilliseconds).toISOString(), at) as unknown as Array<{ audience: string }>;
    if (reports.length) return reports.some(report => report.audience === 'others');
    // Only her full bodies stand in: a touch-only body (the phone) or an unregistered app says who was around it, not who can
    // see her window. Call events stand in for nothing: the phone reports its calls whatever its registration (2026-10-05).
    // Nor do the events of her Minecraft body: who is in the game is not who is at the PC.
    const touchOnly = new Set(this.devicesWithFlag(scopeKey, BODY_TOUCH_ONLY_FLAG));
    const bodies = this.devices(scopeKey).filter(device => !touchOnly.has(device));
    if (!bodies.length) return false;
    const latest = this.database.prepare(`
      SELECT audience FROM body_events WHERE scope_key = ? AND occurred_at >= ? AND occurred_at <= ?
        AND device_id IN (${bodies.map(() => '?').join(', ')}) AND event_type NOT IN ('callStarted', 'callEnded') AND event_type NOT LIKE 'game.%'
      ORDER BY occurred_at DESC, received_at DESC LIMIT 1
    `).get(scopeKey, new Date(time - eventWindowMilliseconds).toISOString(), at, ...bodies) as unknown as { audience: string } | undefined;
    return latest?.audience === 'others';
  }

  /** Drops events received before the retention boundary. */
  prune(scopeKey: string, receivedBefore: string): number {
    return Number(this.database.prepare('DELETE FROM body_events WHERE scope_key = ? AND received_at < ?').run(scopeKey, receivedBefore).changes);
  }

  saveCapabilities(scopeKey: string, deviceId: string, capabilities: BodyCapabilities, at: string): StoredBodyCapabilities {
    this.database.prepare(`
      INSERT INTO body_capabilities (scope_key, device_id, expressions_json, gestures_json, flags_json, updated_at, surface)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET
        expressions_json = excluded.expressions_json, gestures_json = excluded.gestures_json,
        flags_json = excluded.flags_json, updated_at = excluded.updated_at, surface = excluded.surface
    `).run(scopeKey, deviceId, JSON.stringify(capabilities.expressions), JSON.stringify(capabilities.gestures), JSON.stringify(capabilities.flags), at,
      capabilities.surface ?? null);
    return { ...capabilities, updatedAt: at };
  }

  capabilities(scopeKey: string, deviceId: string): StoredBodyCapabilities | null {
    const row = this.database.prepare(`
      SELECT expressions_json, gestures_json, flags_json, updated_at, surface FROM body_capabilities WHERE scope_key = ? AND device_id = ?
    `).get(scopeKey, deviceId) as unknown as { expressions_json: string; gestures_json: string; flags_json: string; updated_at: string; surface: string | null } | undefined;
    if (!row) return null;
    return {
      expressions: JSON.parse(row.expressions_json) as string[], gestures: JSON.parse(row.gestures_json) as string[],
      flags: JSON.parse(row.flags_json) as Record<string, boolean>, ...(isBodySurface(row.surface) ? { surface: row.surface } : {}), updatedAt: row.updated_at,
    };
  }

  /** Where a registered body is, as it said; undefined for a device that did not say or did not register. */
  surface(scopeKey: string, deviceId: string): BodySurface | undefined {
    const row = this.database.prepare('SELECT surface FROM body_capabilities WHERE scope_key = ? AND device_id = ?')
      .get(scopeKey, deviceId) as unknown as { surface: string | null } | undefined;
    return isBodySurface(row?.surface) ? row.surface : undefined;
  }

  /** Devices of the scope whose registration has the flag set to true, such as `camera`. */
  devicesWithFlag(scopeKey: string, flag: string): readonly string[] {
    const rows = this.database.prepare('SELECT device_id, flags_json FROM body_capabilities WHERE scope_key = ?')
      .all(scopeKey) as unknown as Array<{ device_id: string; flags_json: string }>;
    // No flag of a touch-only body counts, except the one that says what it is: its camera is never her body's camera.
    return rows.map(row => ({ deviceId: row.device_id, flags: JSON.parse(row.flags_json) as Record<string, boolean> }))
      .filter(row => row.flags[flag] === true && (flag === BODY_TOUCH_ONLY_FLAG || row.flags[BODY_TOUCH_ONLY_FLAG] !== true))
      .map(row => row.deviceId);
  }

  /** Every device of the scope that registered as her body. */
  devices(scopeKey: string): readonly string[] {
    return (this.database.prepare('SELECT device_id FROM body_capabilities WHERE scope_key = ?').all(scopeKey) as unknown as Array<{ device_id: string }>)
      .map(row => row.device_id);
  }

  close(): void {
    this.database.close();
  }
}
