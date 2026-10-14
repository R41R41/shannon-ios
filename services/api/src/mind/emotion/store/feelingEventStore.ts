import type { DatabaseSync } from 'node:sqlite';
import {
  FULL_COMPOSURE, isFeelingAudience, isFeelingChannel, isFeelingEventKind, isFeelingIdentity, isFeelingRegister,
  type FeelingEvent, type FeelingEventFacts,
} from '@shannon/cognition';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { FEELING_STEPS } from '../../../infra/sqlite/migrations/emotionSteps.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';

/**
 * Her feeling events (Syzygy ADR-0013 stage 1; table `shannon_feeling_events`, schema step `emotion/004_feeling_events`). Core:
 * emotion. Closed values only. A touch is one event per touch id: the first report keeps its row, a later one with her stance fills
 * the stance in (a reaction answered after the touch was already reported as an event, or the other way round). Opened with the
 * profile of her inner notes (WAL; written beside a turn, never inside its model call).
 */
type Row = Record<string, unknown>;

const COLUMNS = 'event_id, kind, person_key, identity, audience, channel, scene_id, source_id, facts_json, composure, register, occurred_at';

function factsOf(value: unknown): FeelingEventFacts {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : null;
    return parsed && typeof parsed === 'object' ? parsed as FeelingEventFacts : {};
  } catch { return {}; }
}

function eventOf(row: Row): FeelingEvent | null {
  const { kind, identity, audience, channel } = row;
  if (!isFeelingEventKind(kind) || !isFeelingIdentity(identity) || !isFeelingAudience(audience) || !isFeelingChannel(channel)) return null;
  const facts = factsOf(row.facts_json);
  const register = isFeelingRegister(row.register) ? row.register : 'normal';
  return {
    id: String(row.event_id), kind, personKey: String(row.person_key), identity, audience, channel,
    sceneId: typeof row.scene_id === 'string' ? row.scene_id : null, sourceId: typeof row.source_id === 'string' ? row.source_id : null,
    facts: register === 'normal' ? facts : { ...facts, register }, occurredAt: String(row.occurred_at),
  };
}

export class SQLiteFeelingEventStore {
  private readonly database: DatabaseSync;
  private readonly owned: boolean;

  constructor(source: string | DatabaseSync) {
    this.owned = typeof source === 'string';
    this.database = typeof source === 'string' ? openDatabase(source, 'innerNotes') : source;
    applySchemaSteps(this.database, FEELING_STEPS);
    if (typeof source === 'string') secureDatabaseFiles(source);
  }

  /** Records one event; a known id only takes a stance it did not have. True when a row was written or completed. */
  record(scopeKey: string, event: FeelingEvent, recordedAt: string): boolean {
    const result = this.database.prepare(`INSERT INTO shannon_feeling_events (scope_key, ${COLUMNS}, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, event_id) DO UPDATE SET facts_json = excluded.facts_json
      WHERE json_extract(excluded.facts_json, '$.stance') IS NOT NULL AND json_extract(shannon_feeling_events.facts_json, '$.stance') IS NULL`)
      .run(scopeKey, event.id, event.kind, event.personKey, event.identity, event.audience, event.channel, event.sceneId, event.sourceId,
        JSON.stringify(event.facts), FULL_COMPOSURE, event.facts.register ?? 'normal', event.occurredAt, recordedAt);
    return Number(result.changes) > 0;
  }

  /** The events of a scope in a span of time, oldest first (bounded). */
  between(scopeKey: string, since: string, until: string, limit = 2_000): FeelingEvent[] {
    // The newest `limit` of the span (a long day keeps its latest rows), returned oldest first.
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_feeling_events WHERE scope_key = ? AND occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at DESC LIMIT ?`).all(scopeKey, since, until, limit) as Row[]).reverse().flatMap(row => eventOf(row) ?? []);
  }

  /** Her newest own replies of one audience (for the repetition watch), newest first. */
  ownReplies(scopeKey: string, audience: string, limit: number): FeelingEvent[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_feeling_events WHERE scope_key = ? AND kind = 'own_reply' AND audience = ?
      ORDER BY occurred_at DESC LIMIT ?`).all(scopeKey, audience, limit) as Row[]).flatMap(row => eventOf(row) ?? []);
  }

  /** A voice utterance's events take the stored turn's id (`utterance:<id>` → the experience id). */
  bindSource(scopeKey: string, from: string, to: string): number {
    return Number(this.database.prepare('UPDATE shannon_feeling_events SET source_id = ? WHERE scope_key = ? AND source_id = ?')
      .run(to, scopeKey, from).changes);
  }

  /** Rows older than an instant are deleted (the body's retention). */
  prune(scopeKey: string, before: string): number {
    return Number(this.database.prepare('DELETE FROM shannon_feeling_events WHERE scope_key = ? AND occurred_at < ?').run(scopeKey, before).changes);
  }

  close(): void {
    if (this.owned && this.database.isOpen) this.database.close();
  }
}
