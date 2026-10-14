import type { DatabaseSync } from 'node:sqlite';
import { isFeelingAudience, isFeelingChannel, isFeelingEventKind, isFeelingIdentity, type FeelingEvent } from '@shannon/cognition';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { FEELING_DAYS_STEPS } from '../../../infra/sqlite/migrations/emotionSteps.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';

/**
 * Her closed days (Syzygy ADR-0013 stage 3; table `shannon_feeling_days`, schema step `emotion/006_feeling_days`, applied only when a
 * stage-3 switch opens this store). Core: emotion. One row per day, person, audience and scene: the day's closed events as JSON (closed
 * values and source ids, never words). Read back whole; the forgetting filter is applied by the reader.
 */
export interface ClosedDayRow { dayKey: string; personKey: string; audience: FeelingEvent['audience']; sceneId: string | null; events: readonly FeelingEvent[] }

type Row = Record<string, unknown>;

function validEvent(event: FeelingEvent): event is FeelingEvent {
  return Boolean(event) && isFeelingEventKind(event.kind) && isFeelingIdentity(event.identity) && isFeelingAudience(event.audience)
    && isFeelingChannel(event.channel) && typeof event.occurredAt === 'string';
}

function eventsOf(value: unknown): FeelingEvent[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter(validEvent) : [];
  } catch { return []; }
}

export class SQLiteFeelingDayStore {
  private readonly database: DatabaseSync;
  private readonly owned: boolean;

  constructor(source: string | DatabaseSync) {
    this.owned = typeof source === 'string';
    this.database = typeof source === 'string' ? openDatabase(source, 'innerNotes') : source;
    applySchemaSteps(this.database, FEELING_DAYS_STEPS);
    if (typeof source === 'string') secureDatabaseFiles(source);
  }

  write(scopeKey: string, row: ClosedDayRow, closedAt: string): void {
    this.database.prepare(`INSERT OR REPLACE INTO shannon_feeling_days (scope_key, day_key, person_key, audience, scene_id, events_json, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scopeKey, row.dayKey, row.personKey, row.audience, row.sceneId ?? '', JSON.stringify(row.events), closedAt);
  }

  /** The closed days of one person (every audience and scene of theirs), oldest first. */
  person(scopeKey: string, personKey: string, sinceDayKey: string): ClosedDayRow[] {
    return (this.database.prepare(`SELECT * FROM shannon_feeling_days WHERE scope_key = ? AND person_key = ? AND day_key >= ?
      ORDER BY day_key ASC LIMIT 2000`).all(scopeKey, personKey, sinceDayKey) as Row[]).map(rowOf);
  }

  /** The newest day closed for a scope, or null. */
  lastDayKey(scopeKey: string): string | null {
    const row = this.database.prepare('SELECT MAX(day_key) AS day FROM shannon_feeling_days WHERE scope_key = ?')
      .get(scopeKey) as { day: string | null } | undefined;
    return row?.day ?? null;
  }

  prune(scopeKey: string, beforeDayKey: string): number {
    return Number(this.database.prepare('DELETE FROM shannon_feeling_days WHERE scope_key = ? AND day_key < ?').run(scopeKey, beforeDayKey).changes);
  }

  close(): void {
    if (this.owned && this.database.isOpen) this.database.close();
  }
}

function rowOf(row: Row): ClosedDayRow {
  const audience = isFeelingAudience(row.audience) ? row.audience : 'owner_alone';
  const scene = typeof row.scene_id === 'string' && row.scene_id ? row.scene_id : null;
  return { dayKey: String(row.day_key), personKey: String(row.person_key), audience, sceneId: scene, events: eventsOf(row.events_json) };
}
