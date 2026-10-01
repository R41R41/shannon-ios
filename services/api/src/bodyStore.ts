import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BodyAudience, BodyCapabilities, BodyEvent, BodyEventType } from './bodyContract.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

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
  duration_ms: number | null; strength: number | null; minutes_away: number | null; content_hash: string;
}

const contentHash = (event: BodyEvent) => createHash('sha256').update(JSON.stringify([
  event.type, event.audience, event.occurredAt, event.durationMs ?? null, event.strength ?? null, event.minutesAway ?? null,
])).digest('hex').slice(0, 32);

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
    `);
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
        duration_ms, strength, minutes_away, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, event.id, deviceId, event.type, event.audience, event.occurredAt, receivedAt, dayKey,
      event.durationMs ?? null, event.strength ?? null, event.minutesAway ?? null, hash);
    if (Number(result.changes) > 0) return 'stored';
    return this.seen(scopeKey, event);
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
    }));
  }

  /** Drops events received before the retention boundary. */
  prune(scopeKey: string, receivedBefore: string): number {
    return Number(this.database.prepare('DELETE FROM body_events WHERE scope_key = ? AND received_at < ?').run(scopeKey, receivedBefore).changes);
  }

  saveCapabilities(scopeKey: string, deviceId: string, capabilities: BodyCapabilities, at: string): StoredBodyCapabilities {
    this.database.prepare(`
      INSERT INTO body_capabilities (scope_key, device_id, expressions_json, gestures_json, flags_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET
        expressions_json = excluded.expressions_json, gestures_json = excluded.gestures_json,
        flags_json = excluded.flags_json, updated_at = excluded.updated_at
    `).run(scopeKey, deviceId, JSON.stringify(capabilities.expressions), JSON.stringify(capabilities.gestures), JSON.stringify(capabilities.flags), at);
    return { ...capabilities, updatedAt: at };
  }

  capabilities(scopeKey: string, deviceId: string): StoredBodyCapabilities | null {
    const row = this.database.prepare(`
      SELECT expressions_json, gestures_json, flags_json, updated_at FROM body_capabilities WHERE scope_key = ? AND device_id = ?
    `).get(scopeKey, deviceId) as unknown as { expressions_json: string; gestures_json: string; flags_json: string; updated_at: string } | undefined;
    if (!row) return null;
    return {
      expressions: JSON.parse(row.expressions_json) as string[], gestures: JSON.parse(row.gestures_json) as string[],
      flags: JSON.parse(row.flags_json) as Record<string, boolean>, updatedAt: row.updated_at,
    };
  }

  close(): void {
    this.database.close();
  }

  private seen(scopeKey: string, event: BodyEvent): BodyEventOutcome {
    return this.known(scopeKey, event) ?? 'conflict';
  }
}
