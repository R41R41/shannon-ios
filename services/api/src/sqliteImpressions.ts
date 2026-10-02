import type { DatabaseSync } from 'node:sqlite';
import { normalizeDisclosure } from '@shannon/cognition';
import {
  IMPRESSION_KINDS, type ImpressionPerson, type ImpressionStore, type PersonImpression,
} from './impressions.js';

/** Receipts older than this are removed when a new one is written. */
const RECEIPT_DAYS = 60;
/** Rows read for one scope. The rules keep far fewer per person. */
const MAXIMUM_ROWS = 600;

/**
 * Additive and outside the numbered migrations, like the people tables: an older API binary
 * opens the database and ignores both tables.
 */
export function ensureImpressionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS person_impressions (
      scope_key TEXT NOT NULL,
      impression_id TEXT NOT NULL,
      person_key TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY (scope_key, impression_id)
    );
    CREATE INDEX IF NOT EXISTS person_impressions_person ON person_impressions(scope_key, person_key, last_seen_at);
    CREATE TABLE IF NOT EXISTS person_impression_turns (
      scope_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      person_key TEXT NOT NULL,
      day_key TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, source_id, person_key)
    );
    CREATE INDEX IF NOT EXISTS person_impression_turns_day ON person_impression_turns(scope_key, day_key);
  `);
}

export class SQLiteImpressionStore implements ImpressionStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
  ) {
    ensureImpressionSchema(database);
  }

  impressions(scopeKey: string): readonly PersonImpression[] {
    const rows = this.database.prepare(`
      SELECT person_key, data_json FROM person_impressions WHERE scope_key = ? ORDER BY last_seen_at DESC, impression_id LIMIT ${MAXIMUM_ROWS}
    `).all(scopeKey) as unknown as Array<{ person_key: string; data_json: string }>;
    // The column says whose impression it is: merging two people moves it there.
    return Object.freeze(rows.flatMap(row => {
      const value = parsed(row.data_json);
      return value ? [Object.freeze({ ...value, personKey: row.person_key })] : [];
    }));
  }

  /** The `people` table belongs to the people store and the identity registry; absent, nobody is known. */
  people(scopeKey: string): readonly ImpressionPerson[] {
    try {
      const rows = this.database.prepare(`
        SELECT person_id, display_name, aliases_json, forgotten_at FROM people
        WHERE scope_key = ? AND lifecycle_status = 'active' LIMIT 500
      `).all(scopeKey) as unknown as Array<{ person_id: string; display_name: string; aliases_json: string | null; forgotten_at: string | null }>;
      return Object.freeze(rows.map(row => Object.freeze({
        id: row.person_id, displayName: row.display_name, aliases: Object.freeze(strings(row.aliases_json)), forgotten: Boolean(row.forgotten_at),
      })));
    } catch { return []; }
  }

  saveImpressions(scopeKey: string, upserts: readonly PersonImpression[], deleteIds: readonly string[]): void {
    if (!upserts.length && !deleteIds.length) return;
    this.transaction(() => {
      const remove = this.database.prepare('DELETE FROM person_impressions WHERE scope_key = ? AND impression_id = ?');
      for (const id of deleteIds) remove.run(scopeKey, id);
      const write = this.database.prepare(`
        INSERT INTO person_impressions (scope_key, impression_id, person_key, status, last_seen_at, updated_at, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, impression_id) DO UPDATE SET person_key = excluded.person_key, status = excluded.status,
          last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at, data_json = excluded.data_json
      `);
      for (const row of upserts) write.run(scopeKey, row.id, row.personKey, row.status, row.lastSeenAt, row.updatedAt, JSON.stringify(row));
    });
  }

  turnProcessed(scopeKey: string, sourceId: string, personKey: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 AS found FROM person_impression_turns WHERE scope_key = ? AND source_id = ? AND person_key = ?')
      .get(scopeKey, sourceId, personKey));
  }

  recordTurn(scopeKey: string, sourceId: string, personKey: string, dayKey: string, at: string): void {
    this.transaction(() => {
      this.database.prepare(`INSERT OR IGNORE INTO person_impression_turns (scope_key, source_id, person_key, day_key, processed_at)
        VALUES (?, ?, ?, ?, ?)`).run(scopeKey, sourceId, personKey, dayKey, at);
      this.database.prepare('DELETE FROM person_impression_turns WHERE scope_key = ? AND processed_at < ?')
        .run(scopeKey, new Date(Date.parse(at) - RECEIPT_DAYS * 86_400_000).toISOString());
    });
  }

  modelCallsOn(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare('SELECT COUNT(*) AS calls FROM person_impression_turns WHERE scope_key = ? AND day_key = ?')
      .get(scopeKey, dayKey) as unknown as { calls: number };
    return Number(row.calls);
  }
}

/** For tests and for stores without SQLite. */
export class InMemoryImpressionStore implements ImpressionStore {
  private readonly rows = new Map<string, Map<string, PersonImpression>>();
  private readonly turns = new Map<string, string>();
  constructor(public known: readonly ImpressionPerson[] = []) {}
  impressions(scopeKey: string) { return [...(this.rows.get(scopeKey)?.values() ?? [])].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)); }
  people() { return this.known; }
  saveImpressions(scopeKey: string, upserts: readonly PersonImpression[], deleteIds: readonly string[]) {
    const rows = this.rows.get(scopeKey) ?? new Map<string, PersonImpression>();
    this.rows.set(scopeKey, rows);
    for (const id of deleteIds) rows.delete(id);
    for (const row of upserts) rows.set(row.id, row);
  }
  turnProcessed(scopeKey: string, sourceId: string, personKey: string) { return this.turns.has(`${scopeKey}\u0000${sourceId}\u0000${personKey}`); }
  recordTurn(scopeKey: string, sourceId: string, personKey: string, dayKey: string) { this.turns.set(`${scopeKey}\u0000${sourceId}\u0000${personKey}`, `${scopeKey}\u0000${dayKey}`); }
  modelCallsOn(scopeKey: string, dayKey: string) { return [...this.turns.values()].filter(value => value === `${scopeKey}\u0000${dayKey}`).length; }
}

function strings(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

/** A row that cannot be read is no impression. Its label is restored by the same rule as every other label. */
function parsed(raw: string): PersonImpression | null {
  try {
    const row = JSON.parse(raw) as PersonImpression;
    if (typeof row?.id !== 'string' || typeof row.personKey !== 'string' || typeof row.pattern !== 'string'
      || !(IMPRESSION_KINDS as readonly string[]).includes(row.kind) || !Array.isArray(row.evidence) || !Array.isArray(row.keyTerms)) return null;
    return Object.freeze({ ...row, feelingHistory: Array.isArray(row.feelingHistory) ? row.feelingHistory : [], disclosure: normalizeDisclosure(row.disclosure) ?? {} });
  } catch { return null; }
}
