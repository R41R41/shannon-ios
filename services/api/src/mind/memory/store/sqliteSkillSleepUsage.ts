import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The skill sleep's own spend and calls (review M4; `docs/skill-and-routing-contract.md`, 「スキルの眠りの予算」). Core: memory.
 *
 * Skill sleep has its own monthly budget (`SHANNON_SKILL_MONTHLY_BUDGET_USD`) and never spends the shared background budget
 * (`SHANNON_BACKGROUND_LLM_MONTHLY_BUDGET_USD`, which embeddings and summaries live on): its models' usage is written here, not to
 * `llm_usage_events`. Each model call is written before it is made (`call`), so the proposer's nightly limit survives a restart.
 * Ids, closed kinds, model names, numbers and instants only. Created with the skill tables (`ensureSkillSchema`).
 */
export function ensureSkillSleepUsageSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_skill_sleep_usage (
      usage_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('maintainer_call', 'proposer_call', 'cost')),
      night TEXT NOT NULL,
      model TEXT NOT NULL,
      estimated_cost_usd REAL NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shannon_skill_sleep_usage_night ON shannon_skill_sleep_usage (scope_key, night, kind);
    CREATE INDEX IF NOT EXISTS shannon_skill_sleep_usage_month ON shannon_skill_sleep_usage (occurred_at);
  `);
}

export class SQLiteSkillSleepUsage {
  constructor(private readonly database: DatabaseSync) {}

  /** One model call about to be made (counted before it is made). */
  call(scopeKey: string, role: 'maintainer' | 'proposer', night: string, model: string, at: string): void {
    this.database.prepare('INSERT INTO shannon_skill_sleep_usage (usage_id, scope_key, kind, night, model, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), scopeKey, `${role}_call`, night, model.slice(0, 120), at);
  }

  /** What a call cost, as its model reported it. */
  cost(scopeKey: string, night: string, model: string, usd: number, at: string): void {
    this.database.prepare('INSERT INTO shannon_skill_sleep_usage (usage_id, scope_key, kind, night, model, estimated_cost_usd, occurred_at) VALUES (?, ?, \'cost\', ?, ?, ?, ?)')
      .run(randomUUID(), scopeKey, night, model.slice(0, 120), Number.isFinite(usd) && usd > 0 ? usd : 0, at);
  }

  calls(scopeKey: string, role: 'maintainer' | 'proposer', night: string): number {
    return Number((this.database.prepare('SELECT COUNT(*) AS n FROM shannon_skill_sleep_usage WHERE scope_key = ? AND night = ? AND kind = ?').get(scopeKey, night, `${role}_call`) as { n: number }).n);
  }

  /** The month's spend of skill sleep, every scope (`YYYY-MM`, UTC). */
  monthCostUsd(monthKey: string): number {
    return Number((this.database.prepare("SELECT COALESCE(SUM(estimated_cost_usd), 0) AS usd FROM shannon_skill_sleep_usage WHERE kind = 'cost' AND substr(occurred_at, 1, 7) = ?").get(monthKey) as { usd: number }).usd);
  }
}

/**
 * Review R2: the skill sleep's line of the usage summary, month to date (UTC month, every scope) against its own budget; null
 * while the table does not exist (the skills never ran) or nothing was called or spent this month. Read-only.
 */
export function skillSleepUsageRow(database: DatabaseSync, monthKey: string, budgetUsd: number) {
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shannon_skill_sleep_usage'").get()) return null;
    const row = database.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'cost' THEN estimated_cost_usd ELSE 0 END), 0) AS usd,
      COALESCE(SUM(CASE WHEN kind != 'cost' THEN 1 ELSE 0 END), 0) AS calls FROM shannon_skill_sleep_usage WHERE substr(occurred_at, 1, 7) = ?`).get(monthKey) as { usd: number; calls: number };
    const usd = Math.round(Number(row.usd) * 1e9) / 1e9;
    if (!Number(row.calls) && !usd) return null;
    return Object.freeze({
      lane: 'skill_sleep' as const, calls: Number(row.calls), inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
      estimatedCostUsd: usd, budgetUsd, remainingUsd: Math.max(0, Math.round((budgetUsd - usd) * 1e9) / 1e9),
    });
  } catch { return null; }
}
