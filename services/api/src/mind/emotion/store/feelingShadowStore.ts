import type { DatabaseSync } from 'node:sqlite';
import type { FeelingPoint } from '@shannon/cognition';
import { applySchemaSteps } from '../../../infra/sqlite/migrations/schemaSteps.js';
import { FEELING_SHADOW_STEPS } from '../../../infra/sqlite/migrations/emotionSteps.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';

/**
 * The shadow rows of her fast layer (Syzygy ADR-0013 stage 2; table `shannon_feeling_shadow`, schema step `emotion/005_feeling_shadow`).
 * Core: emotion. Closed numbers and labels; written beside a turn, never read into her state.
 */
export interface FeelingShadowRow {
  eventId: string;
  personKey: string;
  audience: string;
  sceneId: string | null;
  sourceId: string | null;
  point: FeelingPoint;
  current: { valence: number; arousal: number } | null;
}

type Row = Record<string, unknown>;
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value));

export class SQLiteFeelingShadowStore {
  private readonly database: DatabaseSync;
  private readonly owned: boolean;

  constructor(source: string | DatabaseSync) {
    this.owned = typeof source === 'string';
    this.database = typeof source === 'string' ? openDatabase(source, 'innerNotes') : source;
    applySchemaSteps(this.database, FEELING_SHADOW_STEPS);
    if (typeof source === 'string') secureDatabaseFiles(source);
  }

  write(scopeKey: string, row: FeelingShadowRow, recordedAt: string): void {
    const { point } = row;
    this.database.prepare(`INSERT OR REPLACE INTO shannon_feeling_shadow (scope_key, event_id, person_key, audience, scene_id, source_id, kind, valence,
      arousal, dominance, mood, blame, composure, level, register, label, slip, cover_up, current_valence, current_arousal, occurred_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scopeKey, row.eventId, row.personKey, row.audience, row.sceneId,
      row.sourceId, point.kind, point.valence, point.arousal, point.dominance, point.mood, point.blame, point.composure, point.level, point.register,
      point.label, point.slip ? 1 : 0, point.coverUp ? 1 : 0, row.current?.valence ?? null, row.current?.arousal ?? null, point.at, recordedAt);
  }

  /** The series of one key since an instant, oldest first (the Observer's graph). */
  series(scopeKey: string, personKey: string, audience: string, since: string, limit = 500): (FeelingPoint & { sourceId: string | null })[] {
    return (this.database.prepare(`SELECT * FROM shannon_feeling_shadow WHERE scope_key = ? AND person_key = ? AND audience = ? AND occurred_at >= ?
      ORDER BY occurred_at ASC LIMIT ?`).all(scopeKey, personKey, audience, since, limit) as Row[]).map(row => ({
      at: String(row.occurred_at), kind: String(row.kind) as FeelingPoint['kind'], valence: num(row.valence), arousal: num(row.arousal),
      dominance: num(row.dominance), mood: num(row.mood), blame: num(row.blame), composure: num(row.composure), level: num(row.level),
      register: String(row.register) as FeelingPoint['register'], label: String(row.label) as FeelingPoint['label'], slip: num(row.slip) === 1,
      coverUp: num(row.cover_up) === 1, sourceId: typeof row.source_id === 'string' ? row.source_id : null,
    }));
  }

  prune(scopeKey: string, before: string): number {
    return Number(this.database.prepare('DELETE FROM shannon_feeling_shadow WHERE scope_key = ? AND occurred_at < ?').run(scopeKey, before).changes);
  }

  close(): void {
    if (this.owned && this.database.isOpen) this.database.close();
  }
}
