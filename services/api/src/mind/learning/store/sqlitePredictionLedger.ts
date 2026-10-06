import type { DatabaseSync } from 'node:sqlite';
import { isLedgerDomain, roundedDerived, type LedgerDerived, type LedgerDomain, type LedgerRow, type LedgerStatus } from '@shannon/learning';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL } from '../../../predictionStore.js';

/**
 * The table of the prediction ledger (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`). Core: emotion.
 *
 * Additive, created when absent by the API's processes only, outside the numbered migrations. Closed symbols, record
 * identifiers, numbers and instants only: `checkedPrediction` refuses anything else, so a word cannot be stored by mistake.
 * `shannon_prediction_ledger_seq` keeps the last place given in the order of settling per scope, so no place is reused.
 */
export const PREDICTIONS_TABLE = 'shannon_predictions';

export const LEDGER_SOURCE_KINDS = ['reach_out', 'call', 'study_piece', 'reading', 'touch', 'choice'] as const;
export type LedgerSourceKind = typeof LEDGER_SOURCE_KINDS[number];

export interface StoredPrediction extends LedgerRow, LedgerDerived {
  scopeKey: string;
  expiresAt: string;
  sourceKind: LedgerSourceKind;
  sourceId: string;
  choiceId: string | null;
  status: LedgerStatus;
}

export function ensurePredictionLedgerSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_predictions (
      prediction_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      context TEXT NOT NULL,
      expectation REAL NOT NULL,
      uncertainty REAL NOT NULL,
      noise REAL NOT NULL,
      interval_low REAL NOT NULL,
      interval_high REAL NOT NULL,
      prior REAL NOT NULL,
      basis_seq INTEGER NOT NULL,
      made_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      choice_id TEXT,
      status TEXT NOT NULL,
      outcome REAL,
      outcome_seq INTEGER,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS shannon_predictions_source ON shannon_predictions (scope_key, source_kind, source_id, domain);
    CREATE INDEX IF NOT EXISTS shannon_predictions_open ON shannon_predictions (scope_key, status, expires_at);
    CREATE INDEX IF NOT EXISTS shannon_predictions_settled ON shannon_predictions (scope_key, outcome_seq);
    CREATE INDEX IF NOT EXISTS shannon_predictions_made ON shannon_predictions (scope_key, made_at);
    CREATE INDEX IF NOT EXISTS shannon_predictions_choice ON shannon_predictions (scope_key, choice_id);
    CREATE TABLE IF NOT EXISTS shannon_prediction_ledger_seq (
      scope_key TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);
}

export function checkedPrediction(row: StoredPrediction): StoredPrediction {
  if (!isLedgerDomain(row.domain) || !(LEDGER_SOURCE_KINDS as readonly string[]).includes(row.sourceKind)) throw new Error('PREDICTION_LEDGER_VOCABULARY');
  if (!PREDICTION_SYMBOL.test(row.key) || (row.context !== '' && !PREDICTION_SYMBOL.test(row.context))) throw new Error('PREDICTION_LEDGER_SYMBOL');
  if (![row.predictionId, row.sourceId, ...(row.choiceId ? [row.choiceId] : [])].every(id => PREDICTION_SOURCE_ID.test(id))) throw new Error('PREDICTION_LEDGER_IDENTIFIER');
  if (![row.madeAt, row.expiresAt].every(value => Number.isFinite(Date.parse(value)))) throw new Error('PREDICTION_LEDGER_TIME');
  if (![row.expectation, row.uncertainty, row.noise, row.intervalLow, row.intervalHigh, row.prior, row.basisSeq].every(Number.isFinite)) throw new Error('PREDICTION_LEDGER_NUMBER');
  return { ...row, ...roundedDerived(row), madeAt: new Date(Date.parse(row.madeAt)).toISOString(), expiresAt: new Date(Date.parse(row.expiresAt)).toISOString() };
}

const COLUMNS = `prediction_id, scope_key, domain, key, context, expectation, uncertainty, noise, interval_low, interval_high, prior, basis_seq,
  made_at, expires_at, source_kind, source_id, choice_id, status, outcome, outcome_seq, settled_at`;

export class SQLitePredictionLedger {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensurePredictionLedgerSchema(database);
  }

  insert(row: StoredPrediction): void {
    const checked = checkedPrediction(row);
    this.database.prepare(`INSERT OR IGNORE INTO shannon_predictions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      checked.predictionId, checked.scopeKey, checked.domain, checked.key, checked.context, checked.expectation, checked.uncertainty, checked.noise,
      checked.intervalLow, checked.intervalHigh, checked.prior, checked.basisSeq, checked.madeAt, checked.expiresAt, checked.sourceKind, checked.sourceId,
      checked.choiceId, 'open', null, null, null,
    );
  }

  get(scopeKey: string, predictionId: string): StoredPrediction | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM shannon_predictions WHERE scope_key = ? AND prediction_id = ?`).get(scopeKey, predictionId) as Record<string, unknown> | undefined;
    return row ? parsed(row) : null;
  }

  /** The open predictions about one record in one domain. */
  openForSource(scopeKey: string, sourceKind: LedgerSourceKind, sourceId: string, domain: LedgerDomain): StoredPrediction[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_predictions WHERE scope_key = ? AND source_kind = ? AND source_id = ? AND domain = ? AND status = 'open' ORDER BY made_at, prediction_id`)
      .all(scopeKey, sourceKind, sourceId, domain) as Array<Record<string, unknown>>).map(parsed);
  }

  /** The predictions opened for one choice (Syzygy ADR-0008: what its reward is scored from). */
  forChoice(scopeKey: string, choiceId: string): StoredPrediction[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_predictions WHERE scope_key = ? AND choice_id = ? ORDER BY made_at, prediction_id`)
      .all(scopeKey, choiceId) as Array<Record<string, unknown>>).map(parsed);
  }

  /** Open predictions whose time ran out at `at`. */
  due(scopeKey: string, at: string): StoredPrediction[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_predictions WHERE scope_key = ? AND status = 'open' AND expires_at <= ? ORDER BY expires_at, prediction_id`)
      .all(scopeKey, at) as Array<Record<string, unknown>>).map(parsed);
  }

  all(scopeKey: string): StoredPrediction[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_predictions WHERE scope_key = ? ORDER BY made_at, prediction_id`).all(scopeKey) as Array<Record<string, unknown>>).map(parsed);
  }

  /** Settled rows with an outcome after `seq`, in the order they are folded. */
  settledAfter(scopeKey: string, seq: number): StoredPrediction[] {
    return (this.database.prepare(`SELECT ${COLUMNS} FROM shannon_predictions WHERE scope_key = ? AND outcome_seq > ? ORDER BY outcome_seq`).all(scopeKey, seq) as Array<Record<string, unknown>>).map(parsed);
  }

  /** How many settled rows have an outcome, and the highest place among them: enough to see whether another writer settled or deleted. */
  settledShape(scopeKey: string, upTo = Number.MAX_SAFE_INTEGER): { count: number; maxSeq: number } {
    const row = this.database.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(outcome_seq), 0) AS max_seq FROM shannon_predictions WHERE scope_key = ? AND outcome_seq IS NOT NULL AND outcome_seq <= ?')
      .get(scopeKey, upTo) as unknown as { count: number; max_seq: number };
    return { count: Number(row.count), maxSeq: Number(row.max_seq) };
  }

  /** Settles an open row: with an outcome it takes the next place in the order of settling; without one it is void or expired unscored. */
  settle(scopeKey: string, predictionId: string, status: Exclude<LedgerStatus, 'open'>, outcome: number | null, at: string): boolean {
    if (outcome !== null && !Number.isFinite(outcome)) throw new Error('PREDICTION_LEDGER_NUMBER');
    const settledAt = new Date(Date.parse(at)).toISOString();
    // A place is never given twice, also after the row that had it was deleted: a cached fold can then tell what changed.
    const seq = outcome === null ? null : Math.max(this.lastSeq(scopeKey), this.settledShape(scopeKey).maxSeq) + 1;
    const result = this.database.prepare("UPDATE shannon_predictions SET status = ?, outcome = ?, outcome_seq = ?, settled_at = ? WHERE scope_key = ? AND prediction_id = ? AND status = 'open'")
      .run(status, outcome === null ? null : Math.round(outcome * 1e6) / 1e6, seq, settledAt, scopeKey, predictionId);
    const changed = Number(result.changes) > 0;
    if (changed && seq !== null) {
      this.database.prepare('INSERT INTO shannon_prediction_ledger_seq (scope_key, last_seq) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET last_seq = excluded.last_seq')
        .run(scopeKey, seq);
    }
    return changed;
  }

  private lastSeq(scopeKey: string): number {
    const row = this.database.prepare('SELECT last_seq FROM shannon_prediction_ledger_seq WHERE scope_key = ?').get(scopeKey) as { last_seq: number } | undefined;
    return row ? Number(row.last_seq) : 0;
  }

  updateDerived(scopeKey: string, predictionId: string, derived: LedgerDerived): void {
    const value = roundedDerived(derived);
    this.database.prepare('UPDATE shannon_predictions SET expectation = ?, uncertainty = ?, noise = ?, interval_low = ?, interval_high = ?, prior = ? WHERE scope_key = ? AND prediction_id = ?')
      .run(value.expectation, value.uncertainty, value.noise, value.intervalLow, value.intervalHigh, value.prior, scopeKey, predictionId);
  }

  sourceIds(scopeKey: string): string[] {
    return (this.database.prepare('SELECT DISTINCT source_id FROM shannon_predictions WHERE scope_key = ?').all(scopeKey) as Array<{ source_id: string }>).map(row => row.source_id);
  }

  /** Deletes the rows about these records; returns how many went and how many of them had an outcome. */
  deleteSources(scopeKey: string, sourceIds: readonly string[]): { deleted: number; settled: number } {
    let deleted = 0;
    let settled = 0;
    for (const id of sourceIds) {
      settled += Number((this.database.prepare('SELECT COUNT(*) AS n FROM shannon_predictions WHERE scope_key = ? AND source_id = ? AND outcome_seq IS NOT NULL').get(scopeKey, id) as { n: number }).n);
      deleted += Number(this.database.prepare('DELETE FROM shannon_predictions WHERE scope_key = ? AND source_id = ?').run(scopeKey, id).changes);
    }
    return { deleted, settled };
  }

  /** Deletes the rows opened before an instant (retention); returns the same counts. */
  pruneBefore(scopeKey: string, before: string): { deleted: number; settled: number } {
    const settled = Number((this.database.prepare('SELECT COUNT(*) AS n FROM shannon_predictions WHERE scope_key = ? AND made_at < ? AND outcome_seq IS NOT NULL').get(scopeKey, before) as { n: number }).n);
    const deleted = Number(this.database.prepare('DELETE FROM shannon_predictions WHERE scope_key = ? AND made_at < ?').run(scopeKey, before).changes);
    return { deleted, settled };
  }

  counts(scopeKey: string): Record<LedgerStatus, number> {
    const counts: Record<LedgerStatus, number> = { open: 0, matched: 0, expired: 0, void: 0 };
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS n FROM shannon_predictions WHERE scope_key = ? GROUP BY status').all(scopeKey) as Array<{ status: LedgerStatus; n: number }>) {
      if (row.status in counts) counts[row.status] = Number(row.n);
    }
    return counts;
  }
}

function parsed(row: Record<string, unknown>): StoredPrediction {
  const number = (value: unknown) => Number(value);
  const nullable = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    predictionId: String(row.prediction_id), scopeKey: String(row.scope_key), domain: String(row.domain) as LedgerDomain, key: String(row.key),
    context: String(row.context), expectation: number(row.expectation), uncertainty: number(row.uncertainty), noise: number(row.noise),
    intervalLow: number(row.interval_low), intervalHigh: number(row.interval_high), prior: number(row.prior), basisSeq: number(row.basis_seq),
    madeAt: String(row.made_at), expiresAt: String(row.expires_at), sourceKind: String(row.source_kind) as LedgerSourceKind, sourceId: String(row.source_id),
    choiceId: row.choice_id === null ? null : String(row.choice_id), status: String(row.status) as LedgerStatus,
    outcome: nullable(row.outcome), outcomeSeq: nullable(row.outcome_seq), settledAt: row.settled_at === null ? null : String(row.settled_at),
  };
}
