import type { DatabaseSync } from 'node:sqlite';

/**
 * The record of what she expected and what happened (Syzygy ADR-0006 §1 「置き場所」, stage 1). Core: emotion.
 *
 * Two additive tables in the same SQLite, created when absent and never altered:
 * - `shannon_prediction_outcomes`: one row per outcome. Symbols and numbers only: a domain, a key and a context from
 *   closed vocabularies, the outcome as a number, named numeric features, the kind and id of the source record, the
 *   instant, and what she expected at that moment (expectation, uncertainty, error, learning rate, cause). There is
 *   no column for words. Every derived column can be recomputed from the rows in `seq` order (`PredictionShadow.recompute`).
 * - `shannon_prediction_shadow`: the comparison of the current dynamics with the new ones at an instant, as numbers.
 *
 * A value that is not a symbol, an identifier or a finite number is refused here, so a caller cannot store a word by
 * mistake. Forgetting deletes the rows of a source and the caller recomputes; retention follows the source record.
 */
export const PREDICTION_OUTCOMES_TABLE = 'shannon_prediction_outcomes';
export const PREDICTION_SHADOW_TABLE = 'shannon_prediction_shadow';

/** Closed vocabulary values: ASCII letters, digits and `_.:-`, starting with a letter. */
export const PREDICTION_SYMBOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u;
/** Identifiers of source records. */
export const PREDICTION_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u;

export interface PredictionOutcomeDraft {
  /** A domain of `SHANNON_PREDICTION_DOMAINS`, or `awake` for an instant she was awake with no outcome. */
  domain: string;
  key: string;
  /** Null for `awake`. */
  outcome: number | null;
  context: string;
  features: Readonly<Record<string, number>>;
  /** Where the outcome came from: `touch`, `reach_out`, `reply_feeling`, `state`. Retention and forgetting follow it. */
  sourceKind: string;
  /** The source record's id (a touch burst, a message of hers), or null when the source has none. */
  sourceId: string | null;
  observedAt: string;
}

export interface PredictionDerived {
  expectation: number | null;
  uncertainty: number | null;
  error: number | null;
  learningRate: number | null;
  cause: number | null;
}

export interface StoredPredictionOutcome extends PredictionOutcomeDraft, PredictionDerived { seq: number }

export interface ShadowComparison {
  at: string;
  /** Which tap wrote it: `touch`, `reach_out`, `reply_feeling`, `mood`. */
  tap: string;
  old: { valence: number; arousal: number; openness: number; present: number };
  next: { valence: number; arousal: number; openness: number; present: number; mood: number; awakeMs: number; boundaryMs: number };
}

interface OutcomeRow {
  seq: number; domain: string; key: string; outcome: number | null; context: string; features_json: string;
  source_kind: string; source_id: string | null; observed_at: string;
  expectation: number | null; uncertainty: number | null; error: number | null; learning_rate: number | null; cause: number | null;
}

export class SQLitePredictionStore {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensurePredictionSchema(database);
  }

  /** Whether the tables exist: a process that does not create them (the activity loop) writes nothing until the API has. */
  ready(): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = '${PREDICTION_OUTCOMES_TABLE}'`).get());
  }

  insert(scopeKey: string, draft: PredictionOutcomeDraft, derived: PredictionDerived): number {
    const row = checkedDraft(draft);
    const result = this.database.prepare(`
      INSERT INTO shannon_prediction_outcomes
        (scope_key, domain, key, outcome, context, features_json, source_kind, source_id, observed_at, expectation, uncertainty, error, learning_rate, cause)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, row.domain, row.key, row.outcome, row.context, JSON.stringify(row.features), row.sourceKind, row.sourceId, row.observedAt,
      ...numbers(derived));
    return Number(result.lastInsertRowid);
  }

  /** Rows after `afterSeq`, in `seq` order: the order every fold uses. */
  rows(scopeKey: string, afterSeq = 0): StoredPredictionOutcome[] {
    const rows = this.database.prepare(`
      SELECT seq, domain, key, outcome, context, features_json, source_kind, source_id, observed_at, expectation, uncertainty, error, learning_rate, cause
      FROM shannon_prediction_outcomes WHERE scope_key = ? AND seq > ? ORDER BY seq
    `).all(scopeKey, afterSeq) as unknown as OutcomeRow[];
    return rows.map(row => ({
      seq: Number(row.seq), domain: row.domain, key: row.key, outcome: row.outcome === null ? null : Number(row.outcome), context: row.context,
      features: parsedFeatures(row.features_json), sourceKind: row.source_kind, sourceId: row.source_id, observedAt: row.observed_at,
      expectation: nullable(row.expectation), uncertainty: nullable(row.uncertainty), error: nullable(row.error),
      learningRate: nullable(row.learning_rate), cause: nullable(row.cause),
    }));
  }

  /** Stage 2: the newest outcome of a key, and when it was observed; null when the key has none. */
  latest(scopeKey: string, domain: string, key: string): { outcome: number; observedAt: string } | null {
    const row = this.database.prepare(`
      SELECT outcome, observed_at FROM shannon_prediction_outcomes WHERE scope_key = ? AND domain = ? AND key = ? AND outcome IS NOT NULL
      ORDER BY seq DESC LIMIT 1
    `).get(scopeKey, domain, key) as unknown as { outcome: number; observed_at: string } | undefined;
    return row ? { outcome: Number(row.outcome), observedAt: row.observed_at } : null;
  }

  /** How many rows a scope has and its newest `seq`: enough to see whether another process wrote or deleted. */
  shape(scopeKey: string): { count: number; maxSeq: number } {
    const row = this.database.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(seq), 0) AS max_seq FROM shannon_prediction_outcomes WHERE scope_key = ?')
      .get(scopeKey) as unknown as { count: number; max_seq: number };
    return { count: Number(row.count), maxSeq: Number(row.max_seq) };
  }

  /** The newest instant of any row of the scope, or null. */
  latestAt(scopeKey: string): string | null {
    const row = this.database.prepare('SELECT MAX(observed_at) AS at FROM shannon_prediction_outcomes WHERE scope_key = ?').get(scopeKey) as unknown as { at: string | null };
    return row.at ?? null;
  }

  updateDerived(seq: number, derived: PredictionDerived): void {
    this.database.prepare('UPDATE shannon_prediction_outcomes SET expectation = ?, uncertainty = ?, error = ?, learning_rate = ?, cause = ? WHERE seq = ?')
      .run(...numbers(derived), seq);
  }

  /** The source ids a scope's rows point at. */
  sourceIds(scopeKey: string): string[] {
    return (this.database.prepare('SELECT DISTINCT source_id FROM shannon_prediction_outcomes WHERE scope_key = ? AND source_id IS NOT NULL')
      .all(scopeKey) as unknown as Array<{ source_id: string }>).map(row => row.source_id);
  }

  /** Deletes the rows of these sources. Returns how many went and the earliest instant among them. */
  deleteSources(scopeKey: string, sourceIds: readonly string[]): { deleted: number; earliest: string | null } {
    let deleted = 0;
    let earliest: string | null = null;
    for (const id of sourceIds) {
      const first = this.database.prepare('SELECT MIN(observed_at) AS at FROM shannon_prediction_outcomes WHERE scope_key = ? AND source_id = ?').get(scopeKey, id) as unknown as { at: string | null };
      const result = this.database.prepare('DELETE FROM shannon_prediction_outcomes WHERE scope_key = ? AND source_id = ?').run(scopeKey, id);
      deleted += Number(result.changes);
      if (first.at && (!earliest || first.at < earliest)) earliest = first.at;
    }
    return { deleted, earliest };
  }

  /** Deletes the rows of a source kind older than an instant (retention follows the source record). */
  prune(scopeKey: string, sourceKind: string, before: string): { deleted: number; earliest: string | null } {
    const first = this.database.prepare('SELECT MIN(observed_at) AS at FROM shannon_prediction_outcomes WHERE scope_key = ? AND source_kind = ? AND observed_at < ?')
      .get(scopeKey, sourceKind, before) as unknown as { at: string | null };
    const result = this.database.prepare('DELETE FROM shannon_prediction_outcomes WHERE scope_key = ? AND source_kind = ? AND observed_at < ?').run(scopeKey, sourceKind, before);
    return { deleted: Number(result.changes), earliest: first.at ?? null };
  }

  addComparison(scopeKey: string, comparison: ShadowComparison): void {
    if (!PREDICTION_SYMBOL.test(comparison.tap) || !Number.isFinite(Date.parse(comparison.at))) throw new Error('PREDICTION_COMPARISON_INVALID');
    const { old, next } = comparison;
    this.database.prepare(`
      INSERT INTO shannon_prediction_shadow
        (scope_key, recorded_at, tap, old_valence, old_arousal, old_openness, old_present, new_valence, new_arousal, new_openness, new_present, new_mood, new_awake_ms, new_boundary_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, comparison.at, comparison.tap, ...[old.valence, old.arousal, old.openness, old.present, next.valence, next.arousal, next.openness,
      next.present, next.mood, next.awakeMs, next.boundaryMs].map(value => rounded(value)));
  }

  comparisons(scopeKey: string, since = ''): ShadowComparison[] {
    const rows = this.database.prepare(`
      SELECT * FROM shannon_prediction_shadow WHERE scope_key = ? AND recorded_at >= ? ORDER BY recorded_at, comparison_id
    `).all(scopeKey, since) as unknown as Array<Record<string, number | string>>;
    return rows.map(row => ({
      at: String(row.recorded_at), tap: String(row.tap),
      old: { valence: Number(row.old_valence), arousal: Number(row.old_arousal), openness: Number(row.old_openness), present: Number(row.old_present) },
      next: {
        valence: Number(row.new_valence), arousal: Number(row.new_arousal), openness: Number(row.new_openness), present: Number(row.new_present),
        mood: Number(row.new_mood), awakeMs: Number(row.new_awake_ms), boundaryMs: Number(row.new_boundary_ms),
      },
    }));
  }

  latestComparison(scopeKey: string, tap: string): ShadowComparison | null {
    const latest = this.database.prepare('SELECT MAX(recorded_at) AS at FROM shannon_prediction_shadow WHERE scope_key = ? AND tap = ?').get(scopeKey, tap) as unknown as { at: string | null };
    return latest.at ? this.comparisons(scopeKey, latest.at).filter(item => item.tap === tap).at(-1) ?? null : null;
  }

  /** Comparisons from an instant on were computed with rows that are gone. */
  deleteComparisonsFrom(scopeKey: string, at: string): void {
    this.database.prepare('DELETE FROM shannon_prediction_shadow WHERE scope_key = ? AND recorded_at >= ?').run(scopeKey, at);
  }

  pruneComparisons(before: string): void {
    this.database.prepare('DELETE FROM shannon_prediction_shadow WHERE recorded_at < ?').run(before);
  }
}

export function ensurePredictionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_prediction_outcomes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      outcome REAL,
      context TEXT NOT NULL,
      features_json TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT,
      observed_at TEXT NOT NULL,
      expectation REAL,
      uncertainty REAL,
      error REAL,
      learning_rate REAL,
      cause INTEGER
    );
    CREATE INDEX IF NOT EXISTS shannon_prediction_outcomes_scope ON shannon_prediction_outcomes (scope_key, seq);
    CREATE INDEX IF NOT EXISTS shannon_prediction_outcomes_source ON shannon_prediction_outcomes (scope_key, source_id);
    CREATE INDEX IF NOT EXISTS shannon_prediction_outcomes_key ON shannon_prediction_outcomes (scope_key, domain, key, seq);
    CREATE TABLE IF NOT EXISTS shannon_prediction_shadow (
      comparison_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      tap TEXT NOT NULL,
      old_valence REAL NOT NULL, old_arousal REAL NOT NULL, old_openness REAL NOT NULL, old_present REAL NOT NULL,
      new_valence REAL NOT NULL, new_arousal REAL NOT NULL, new_openness REAL NOT NULL, new_present REAL NOT NULL,
      new_mood REAL NOT NULL, new_awake_ms REAL NOT NULL, new_boundary_ms REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shannon_prediction_shadow_scope_time ON shannon_prediction_shadow (scope_key, recorded_at);
  `);
}

/** The draft as it will be stored (validated, features rounded, instant normalised): what a fold must use. */
export function checkedDraft(draft: PredictionOutcomeDraft): PredictionOutcomeDraft {
  const symbols = [draft.domain, draft.key, draft.sourceKind, ...(draft.context ? [draft.context] : [])];
  if (!symbols.every(value => PREDICTION_SYMBOL.test(value))) throw new Error('PREDICTION_SYMBOL_INVALID');
  if (draft.sourceId !== null && !PREDICTION_SOURCE_ID.test(draft.sourceId)) throw new Error('PREDICTION_SOURCE_INVALID');
  if (draft.outcome !== null && !Number.isFinite(draft.outcome)) throw new Error('PREDICTION_OUTCOME_INVALID');
  if (!Number.isFinite(Date.parse(draft.observedAt))) throw new Error('PREDICTION_TIME_INVALID');
  const features: Record<string, number> = {};
  for (const [name, value] of Object.entries(draft.features)) {
    if (!PREDICTION_SYMBOL.test(name) || !Number.isFinite(value)) throw new Error('PREDICTION_FEATURE_INVALID');
    features[name] = rounded(value);
  }
  return { ...draft, features, observedAt: new Date(Date.parse(draft.observedAt)).toISOString() };
}

function parsedFeatures(text: string): Record<string, number> {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([name, item]) => PREDICTION_SYMBOL.test(name) && typeof item === 'number' && Number.isFinite(item)));
  } catch { return {}; }
}

function numbers(derived: PredictionDerived): Array<number | null> {
  return [derived.expectation, derived.uncertainty, derived.error, derived.learningRate, derived.cause]
    .map(value => (value === null || !Number.isFinite(value) ? null : rounded(value)));
}

function nullable(value: number | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Six decimals: the stored value is what a recompute produces, also after a round trip through SQLite. */
function rounded(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
}
