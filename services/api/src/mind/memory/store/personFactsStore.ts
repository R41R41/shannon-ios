import type { DatabaseSync } from 'node:sqlite';
import { backfilledFact, type TemporalFact } from '@shannon/mind';
import { ensureColumns } from '../../../infra/sqlite/schemaColumns.js';
import { closedPersonItemIds } from './closedFacts.js';

/**
 * People facts with the time they were true (Syzygy ADR-0008 stage 3, step F6, `docs/mind-workspace-contract.md`; after Graphiti).
 * Everything here is additive and made only while its switch is on:
 * - `SHANNON_TEMPORAL_FACTS`: `person_memory_items` gains `valid_at`, `invalid_at`, `expired_at`, `episode_ids_json` and
 *   `fact_revision` (`ensureColumns`), backfilled for the rows already there (valid since they were observed, open, no episodes,
 *   revision 0); her impressions gain `validAt`, `invalidAt`, `expiredAt` and `episodeIds` in `data_json` the same way.
 * - `SHANNON_IDENTITY_TIERS`: `person_identity_candidates` (what tiers 3 and 4 suggested; only the owner merges) and
 *   `turn_speakers` (who spoke a stored turn, by which tier, verified or not).
 * The people tables themselves belong to `peopleMemoryStore.ts`; this store opens none of its own rows' text.
 */
export function ensurePersonFactSchema(database: DatabaseSync): { items: number; impressions: number } {
  ensureColumns(database, 'person_memory_items', {
    valid_at: 'TEXT', invalid_at: 'TEXT', expired_at: 'TEXT', episode_ids_json: 'TEXT', fact_revision: 'INTEGER NOT NULL DEFAULT 0',
  });
  const items = Number(database.prepare(`UPDATE person_memory_items SET valid_at = observed_at, episode_ids_json = COALESCE(episode_ids_json, '[]')
    WHERE valid_at IS NULL`).run().changes);
  return { items, impressions: backfillImpressions(database) };
}

/** Impressions written before stage 3: `validAt` its first sight, retired ones expired when they were last changed, episodes its evidence. */
function backfillImpressions(database: DatabaseSync): number {
  let rows: Array<{ scope_key: string; impression_id: string; data_json: string }>;
  try {
    rows = database.prepare(`SELECT scope_key, impression_id, data_json FROM person_impressions WHERE json_extract(data_json, '$.validAt') IS NULL`)
      .all() as unknown as typeof rows;
  } catch { return 0; } // no impressions table in this database
  const update = database.prepare('UPDATE person_impressions SET data_json = ? WHERE scope_key = ? AND impression_id = ?');
  let changed = 0;
  for (const row of rows) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(row.data_json) as Record<string, unknown>; } catch { continue; }
    update.run(JSON.stringify({ ...value, ...impressionTemporal(value) }), row.scope_key, row.impression_id);
    changed += 1;
  }
  return changed;
}

/** The temporal fields of an impression as its row stands (its first sight, retirement as expiry, evidence as episodes). */
export function impressionTemporal(row: Record<string, unknown>): { validAt: string | null; invalidAt: null; expiredAt: string | null; episodeIds: string[] } {
  const evidence = Array.isArray(row.evidence) ? row.evidence.flatMap(item => (item && typeof (item as { id?: unknown }).id === 'string' ? [(item as { id: string }).id] : [])) : [];
  return {
    validAt: typeof row.firstSeenAt === 'string' ? row.firstSeenAt : typeof row.createdAt === 'string' ? row.createdAt : null,
    invalidAt: null,
    expiredAt: row.status === 'retired' && typeof row.updatedAt === 'string' ? row.updatedAt : null,
    episodeIds: [...new Set(evidence)].slice(-32),
  };
}

export function ensureIdentitySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS person_identity_candidates (
      scope_key TEXT NOT NULL,
      person_id TEXT NOT NULL,
      candidate_person_id TEXT NOT NULL,
      tier INTEGER NOT NULL CHECK (tier IN (3, 4)),
      score REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'merged', 'dismissed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, person_id, candidate_person_id)
    );
    CREATE TABLE IF NOT EXISTS turn_speakers (
      scope_key TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('owner', 'person', 'unknown')),
      person_id TEXT,
      tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 4),
      verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, turn_id)
    );
  `);
}

/** One fact row as the temporal rules see it, with its text and whom it is about. */
export interface PersonFactRow extends TemporalFact { text: string; personId: string | null; callId: string; observedAt: string }

export interface IdentityCandidate { personId: string; candidatePersonId: string; tier: 3 | 4; score: number; status: 'open' | 'merged' | 'dismissed'; createdAt: string }

export interface TurnSpeaker { turnId: string; speakerKind: 'owner' | 'person' | 'unknown'; personId: string | null; tier: number; verified: boolean; recordedAt: string }

interface FactRow { item_id: string; call_id: string; person_id: string | null; text: string; observed_at: string; valid_at: string | null;
  invalid_at: string | null; expired_at: string | null; episode_ids_json: string | null; fact_revision: number }

const ids = (raw: string | null): string[] => {
  try { const value: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
};

/** The temporal side of people facts, the identity suggestions and the turns' speakers, on one connection. */
export class SQLitePersonFacts {
  constructor(private readonly database: DatabaseSync, readonly parts: { temporal: boolean; identity: boolean }) {
    if (parts.temporal) ensurePersonFactSchema(database);
    if (parts.identity) ensureIdentitySchema(database);
  }

  /** A person's fact rows, newest first (current ones only unless `all`), at most `limit`. */
  facts(scopeKey: string, personId: string, options: { limit?: number; all?: boolean } = {}): readonly PersonFactRow[] {
    if (!this.parts.temporal) return [];
    const rows = this.database.prepare(`SELECT item_id, call_id, person_id, text, observed_at, valid_at, invalid_at, expired_at, episode_ids_json, fact_revision
      FROM person_memory_items WHERE scope_key = ? AND person_id = ? AND kind = 'fact' ${options.all ? '' : 'AND expired_at IS NULL'}
      ORDER BY observed_at DESC, item_id LIMIT ?`).all(scopeKey, personId, Math.max(1, options.limit ?? 30)) as unknown as FactRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      id: row.item_id, callId: row.call_id, personId: row.person_id, text: row.text, observedAt: row.observed_at,
      validAt: row.valid_at ?? backfilledFact(row.item_id, row.observed_at).validAt, invalidAt: row.invalid_at, expiredAt: row.expired_at,
      episodeIds: Object.freeze(ids(row.episode_ids_json)), revision: Number(row.fact_revision ?? 0),
    })));
  }

  /** The items recall leaves out at `at`: expired by then, not yet valid, or no longer valid. */
  closedItemIds(scopeKey: string, at: string): ReadonlySet<string> {
    if (!this.parts.temporal) return new Set();
    return closedPersonItemIds(this.database, scopeKey, at);
  }

  /**
   * The owner reopens a fact the rules closed (stage 3 review M5): its `invalid_at` and `expired_at` cleared, its revision raised.
   * False when there is no such fact.
   */
  reopenFact(scopeKey: string, itemId: string): boolean {
    return Number(this.database.prepare(`UPDATE person_memory_items SET invalid_at = NULL, expired_at = NULL, fact_revision = fact_revision + 1
      WHERE scope_key = ? AND item_id = ? AND kind = 'fact' AND (invalid_at IS NOT NULL OR expired_at IS NOT NULL)`).run(scopeKey, itemId).changes) === 1;
  }

  /** The temporal fields of a row just written (its own, never another's). */
  setTemporal(scopeKey: string, itemId: string, fact: Pick<TemporalFact, 'validAt' | 'invalidAt' | 'expiredAt' | 'episodeIds'>): void {
    this.database.prepare(`UPDATE person_memory_items SET valid_at = ?, invalid_at = ?, expired_at = ?, episode_ids_json = ?
      WHERE scope_key = ? AND item_id = ?`).run(fact.validAt, fact.invalidAt, fact.expiredAt, JSON.stringify(fact.episodeIds), scopeKey, itemId);
  }

  /** A row changed by the rules (closed, or given an episode), compare-and-set on its revision. False when it changed meanwhile. */
  updateFact(scopeKey: string, fact: TemporalFact, expectedRevision: number): boolean {
    return Number(this.database.prepare(`UPDATE person_memory_items SET valid_at = ?, invalid_at = ?, expired_at = ?, episode_ids_json = ?, fact_revision = ?
      WHERE scope_key = ? AND item_id = ? AND fact_revision = ?`).run(fact.validAt, fact.invalidAt, fact.expiredAt, JSON.stringify(fact.episodeIds),
      fact.revision, scopeKey, fact.id, expectedRevision).changes) === 1;
  }

  recordCandidate(scopeKey: string, candidate: Omit<IdentityCandidate, 'status' | 'createdAt'>, at: string): void {
    if (!this.parts.identity || candidate.personId === candidate.candidatePersonId) return;
    this.database.prepare(`INSERT INTO person_identity_candidates (scope_key, person_id, candidate_person_id, tier, score, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(scope_key, person_id, candidate_person_id) DO UPDATE SET tier = excluded.tier, score = excluded.score, updated_at = excluded.updated_at
        WHERE person_identity_candidates.status = 'open'`)
      .run(scopeKey, candidate.personId, candidate.candidatePersonId, candidate.tier, candidate.score, at, at);
  }

  /** The open suggestions (either side may be asked about). */
  candidates(scopeKey: string): readonly IdentityCandidate[] {
    if (!this.parts.identity) return [];
    return Object.freeze((this.database.prepare(`SELECT person_id, candidate_person_id, tier, score, status, created_at FROM person_identity_candidates
      WHERE scope_key = ? AND status = 'open' ORDER BY created_at, person_id LIMIT 500`).all(scopeKey) as Array<{ person_id: string; candidate_person_id: string;
        tier: number; score: number; status: IdentityCandidate['status']; created_at: string }>).map(row => Object.freeze({
      personId: row.person_id, candidatePersonId: row.candidate_person_id, tier: row.tier as 3 | 4, score: Number(row.score), status: row.status, createdAt: row.created_at,
    })));
  }

  /** The owner merged (or set apart) two people: their suggestion is closed. */
  settleCandidates(scopeKey: string, personIds: readonly string[], status: 'merged' | 'dismissed', at: string): void {
    if (!this.parts.identity || !personIds.length) return;
    const marks = personIds.map(() => '?').join(',');
    this.database.prepare(`UPDATE person_identity_candidates SET status = ?, updated_at = ? WHERE scope_key = ? AND status = 'open'
      AND (person_id IN (${marks}) OR candidate_person_id IN (${marks}))`).run(status, at, scopeKey, ...personIds, ...personIds);
  }

  recordSpeaker(scopeKey: string, speaker: TurnSpeaker): void {
    if (!this.parts.identity) return;
    this.database.prepare(`INSERT OR IGNORE INTO turn_speakers (scope_key, turn_id, speaker_kind, person_id, tier, verified, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(scopeKey, speaker.turnId, speaker.speakerKind, speaker.personId, speaker.tier, speaker.verified ? 1 : 0, speaker.recordedAt);
  }

  speaker(scopeKey: string, turnId: string): TurnSpeaker | null {
    if (!this.parts.identity) return null;
    const row = this.database.prepare('SELECT turn_id, speaker_kind, person_id, tier, verified, recorded_at FROM turn_speakers WHERE scope_key = ? AND turn_id = ?')
      .get(scopeKey, turnId) as { turn_id: string; speaker_kind: TurnSpeaker['speakerKind']; person_id: string | null; tier: number; verified: number; recorded_at: string } | undefined;
    return row ? { turnId: row.turn_id, speakerKind: row.speaker_kind, personId: row.person_id, tier: Number(row.tier), verified: row.verified === 1, recordedAt: row.recorded_at } : null;
  }
}
