import type { DatabaseSync } from 'node:sqlite';
import { TRACE_IDENTIFIER, checkedTrace, type DecisionTraceDraft, type StoredDecisionTrace, type TraceAnswer } from '../../../contracts/decisionTraceContract.js';

export type { DecisionTraceDraft, StoredDecisionTrace } from '../../../contracts/decisionTraceContract.js';

/**
 * The table of decision traces (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`). Additive, created when absent
 * by the API's processes only, outside the numbered migrations. Symbols, identifiers, numbers and instants only: a value that
 * is none of these is refused (`checkedTrace`, `decisionTraceContract.ts`), so a word cannot be stored by mistake.
 */
export const DECISION_TRACES_TABLE = 'shannon_decision_traces';

export function ensureDecisionTraceSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_decision_traces (
      trace_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      at TEXT NOT NULL,
      surface TEXT NOT NULL,
      decision TEXT NOT NULL,
      decider TEXT NOT NULL,
      model TEXT NOT NULL,
      questions INTEGER,
      context_chars INTEGER,
      latency_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      fallback_decider TEXT,
      answers_json TEXT NOT NULL,
      cost_usd REAL,
      related_id TEXT
    );
    CREATE INDEX IF NOT EXISTS shannon_decision_traces_scope_time ON shannon_decision_traces (scope_key, at);
    CREATE INDEX IF NOT EXISTS shannon_decision_traces_decider_time ON shannon_decision_traces (decider, at);
  `);
}

export class SQLiteDecisionTraces {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureDecisionTraceSchema(database);
  }

  insert(traceId: string, scopeKey: string, draft: DecisionTraceDraft): void {
    const row = checkedTrace(draft);
    if (!TRACE_IDENTIFIER.test(traceId)) throw new Error('DECISION_TRACE_IDENTIFIER');
    this.database.prepare(`
      INSERT OR IGNORE INTO shannon_decision_traces
        (trace_id, scope_key, at, surface, decision, decider, model, questions, context_chars, latency_ms, outcome, fallback_decider, answers_json, cost_usd, related_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(traceId, scopeKey, row.at, row.surface, row.decision, row.decider, row.model, row.questions, row.contextChars, row.latencyMs,
      row.outcome, row.fallbackDecider, JSON.stringify(row.answers), row.costUsd, row.relatedId);
  }

  list(scopeKey: string, since = ''): StoredDecisionTrace[] {
    const rows = this.database.prepare('SELECT * FROM shannon_decision_traces WHERE scope_key = ? AND at >= ? ORDER BY at, trace_id')
      .all(scopeKey, since) as unknown as Array<Record<string, unknown>>;
    return rows.map(row => ({
      traceId: String(row.trace_id), scopeKey: String(row.scope_key), at: String(row.at),
      surface: String(row.surface) as DecisionTraceDraft['surface'], decision: String(row.decision) as DecisionTraceDraft['decision'],
      decider: String(row.decider) as DecisionTraceDraft['decider'], model: String(row.model),
      questions: row.questions === null ? null : Number(row.questions), contextChars: row.context_chars === null ? null : Number(row.context_chars),
      latencyMs: Number(row.latency_ms), outcome: String(row.outcome) as DecisionTraceDraft['outcome'],
      fallbackDecider: row.fallback_decider === null ? null : String(row.fallback_decider) as DecisionTraceDraft['decider'],
      answers: JSON.parse(String(row.answers_json)) as Record<string, TraceAnswer>,
      costUsd: row.cost_usd === null ? null : Number(row.cost_usd), relatedId: row.related_id === null ? null : String(row.related_id),
    }));
  }

  /** Jev's calls in a scope's month: how many, the sum of the known costs, and how many have no price. */
  jevMonth(scopeKey: string, monthKey: string): { calls: number; knownCostUsd: number; unpriced: number } {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
      FROM shannon_decision_traces WHERE scope_key = ? AND decider = 'jev' AND substr(at, 1, 7) = ?
    `).get(scopeKey, monthKey) as unknown as { calls: number; cost: number; unpriced: number };
    return { calls: Number(row.calls), knownCostUsd: Number(row.cost), unpriced: Number(row.unpriced) };
  }

  prune(before: string): number {
    return Number(this.database.prepare('DELETE FROM shannon_decision_traces WHERE at < ?').run(before).changes);
  }
}
