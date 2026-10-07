import type { DatabaseSync } from 'node:sqlite';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL } from '../../../contracts/cognitionLedgerContract.js';

/**
 * The outcomes of her tiers (Syzygy ADR-0008 stage 2, step 4; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * One row per conversation turn the difficulty policy routed: the tier that served it, Jev's task kind, the surface, the Talk,
 * G (`conversationGrowth`), whether a turn asked to run or change something was done (`doing`: `done`, or `described_not_done`
 * when no `acts` tool result worked, ADR-0008 §14; then G is 0), and once known its closed outcome (`tierOutcome`, from G and the owner's next turn). The competence
 * of a (tier, kind) is a fold of the settled rows (Beta(1, 1) posterior, `competenceMean`), read by the policy for routing only:
 * it never touches reward, mood or the value table (owner answer I-3 keeps it apart). Closed symbols, ids and numbers only.
 * Additive, created by the API's processes only, outside the numbered migrations. Kept 90 days.
 */
export const TIER_OUTCOMES_TABLE = 'shannon_tier_outcomes';

export function ensureTierOutcomeSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_tier_outcomes (
      outcome_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      talk_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      tier TEXT NOT NULL,
      task_kind TEXT NOT NULL,
      growth REAL NOT NULL,
      doing TEXT CHECK (doing IS NULL OR doing IN ('done', 'described_not_done')),
      chosen_at TEXT NOT NULL,
      outcome INTEGER,
      settle_code TEXT,
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS shannon_tier_outcomes_talk ON shannon_tier_outcomes (scope_key, talk_id, outcome);
    CREATE INDEX IF NOT EXISTS shannon_tier_outcomes_kind ON shannon_tier_outcomes (scope_key, tier, task_kind, outcome);
  `);
}

export interface TierOutcomeRow {
  outcomeId: string; scopeKey: string; talkId: string; surface: 'text' | 'voice'; tier: string; taskKind: string; growth: number; chosenAt: string;
  outcome: 0 | 1 | null; settleCode: string | null;
  /** ADR-0008 §14: null when the turn was not asked to run or change anything. */
  doing: 'done' | 'described_not_done' | null;
}

export class SQLiteTierOutcomes {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureTierOutcomeSchema(database);
  }

  insert(row: Omit<TierOutcomeRow, 'outcome' | 'settleCode' | 'doing'> & { doing?: TierOutcomeRow['doing'] }): void {
    if (![row.tier, row.taskKind].every(value => PREDICTION_SYMBOL.test(value)) || !['text', 'voice'].includes(row.surface)) throw new Error('TIER_OUTCOME_SYMBOL');
    if (![row.outcomeId, row.talkId].every(value => PREDICTION_SOURCE_ID.test(value))) throw new Error('TIER_OUTCOME_IDENTIFIER');
    if (!(row.growth >= 0 && row.growth <= 1) || !Number.isFinite(Date.parse(row.chosenAt))) throw new Error('TIER_OUTCOME_NUMBER');
    if (row.doing !== undefined && row.doing !== null && !['done', 'described_not_done'].includes(row.doing)) throw new Error('TIER_OUTCOME_SYMBOL');
    this.database.prepare(`INSERT OR IGNORE INTO shannon_tier_outcomes (outcome_id, scope_key, talk_id, surface, tier, task_kind, growth, doing, chosen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.outcomeId, row.scopeKey, row.talkId, row.surface, row.tier, row.taskKind, Math.round(row.growth * 1e6) / 1e6,
      row.doing ?? null, new Date(Date.parse(row.chosenAt)).toISOString());
  }

  pendingInTalk(scopeKey: string, talkId: string): TierOutcomeRow[] {
    return (this.database.prepare('SELECT * FROM shannon_tier_outcomes WHERE scope_key = ? AND talk_id = ? AND outcome IS NULL ORDER BY chosen_at').all(scopeKey, talkId) as Array<Record<string, unknown>>).map(parsed);
  }

  pendingBefore(scopeKey: string, before: string): TierOutcomeRow[] {
    return (this.database.prepare('SELECT * FROM shannon_tier_outcomes WHERE scope_key = ? AND outcome IS NULL AND chosen_at < ? ORDER BY chosen_at').all(scopeKey, before) as Array<Record<string, unknown>>).map(parsed);
  }

  settle(scopeKey: string, outcomeId: string, outcome: 0 | 1, code: string, at: string): boolean {
    if (!PREDICTION_SYMBOL.test(code)) throw new Error('TIER_OUTCOME_SYMBOL');
    return Number(this.database.prepare('UPDATE shannon_tier_outcomes SET outcome = ?, settle_code = ?, settled_at = ? WHERE scope_key = ? AND outcome_id = ? AND outcome IS NULL')
      .run(outcome, code, new Date(Date.parse(at)).toISOString(), scopeKey, outcomeId).changes) > 0;
  }

  /** Settled outcomes of a (tier, kind): successes and failures. */
  competence(scopeKey: string, tier: string, taskKind: string): { successes: number; failures: number } {
    const row = this.database.prepare('SELECT COALESCE(SUM(outcome), 0) AS s, COUNT(*) AS n FROM shannon_tier_outcomes WHERE scope_key = ? AND tier = ? AND task_kind = ? AND outcome IS NOT NULL')
      .get(scopeKey, tier, taskKind) as { s: number; n: number };
    return { successes: Number(row.s), failures: Number(row.n) - Number(row.s) };
  }

  all(scopeKey: string): TierOutcomeRow[] {
    return (this.database.prepare('SELECT * FROM shannon_tier_outcomes WHERE scope_key = ? ORDER BY chosen_at').all(scopeKey) as Array<Record<string, unknown>>).map(parsed);
  }

  pruneBefore(before: string): number {
    return Number(this.database.prepare('DELETE FROM shannon_tier_outcomes WHERE chosen_at < ?').run(before).changes);
  }
}

function parsed(row: Record<string, unknown>): TierOutcomeRow {
  return {
    outcomeId: String(row.outcome_id), scopeKey: String(row.scope_key), talkId: String(row.talk_id), surface: String(row.surface) as 'text' | 'voice',
    tier: String(row.tier), taskKind: String(row.task_kind), growth: Number(row.growth), chosenAt: String(row.chosen_at),
    outcome: row.outcome === null || row.outcome === undefined ? null : (Number(row.outcome) ? 1 : 0), settleCode: row.settle_code === null ? null : String(row.settle_code),
    doing: row.doing === 'done' || row.doing === 'described_not_done' ? row.doing : null,
  };
}
