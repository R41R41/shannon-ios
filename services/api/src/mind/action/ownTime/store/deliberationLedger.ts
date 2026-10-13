import type { DatabaseSync } from 'node:sqlite';
import { ensureDeliberationSchema } from './executiveMigration.js';

/**
 * The Executive's deliberations (Syzygy ADR-0009 stage 2, E5; `executive_deliberations`). Rows are never deleted; the owner's
 * "forget" clears the words (reason and intent) and keeps the numbers. Only the outcome and the words change after a row is written.
 */
export type DeliberationDispatch = 'procedure' | 'fca' | 'none';
export type DeliberationOutcome = 'pending' | 'running' | 'done' | 'failed' | 'unknown' | 'cancelled' | 'none';
export const DELIBERATION_TRIGGERS = ['interval', 'review', 'task_ended', 'attention', 'first'] as const;
export type DeliberationTrigger = typeof DELIBERATION_TRIGGERS[number];

export interface DeliberationRecord {
  readonly id: string;
  readonly scopeKey: string;
  readonly at: string;
  readonly trigger: DeliberationTrigger;
  readonly capability: string;
  readonly goalId: string | null;
  readonly reason: string | null;
  readonly intent: string | null;
  readonly valueRank: number | null;
  readonly topByValue: boolean;
  readonly offCandidates: boolean;
  /** Each candidate as `{ capability, goalId?, rank, mean?, n? }`: closed values and numbers. */
  readonly candidates: readonly Record<string, string | number | null>[];
  /** Numbers and closed values of the material (budget, slots, band, presence, mood, counts). */
  readonly material: Readonly<Record<string, string | number | boolean | null>>;
  readonly dispatch: DeliberationDispatch;
  readonly cycleId: string | null;
  readonly taskId: string | null;
  readonly outcome: DeliberationOutcome;
  readonly outcomeAt: string | null;
  readonly nextThinkAt: string;
  readonly choiceId: string | null;
}

interface Row {
  deliberation_id: string; scope_key: string; at: string; trigger: string; capability: string; goal_id: string | null; reason: string | null;
  intent: string | null; value_rank: number | null; top_by_value: number; off_candidates: number; candidates_json: string; material_json: string;
  dispatch: string; cycle_id: string | null; task_id: string | null; outcome: string; outcome_at: string | null; next_think_at: string;
  choice_id: string | null;
}

export class DeliberationLedger {
  private ready = false;

  constructor(private readonly database: DatabaseSync) {}

  private schema(): DatabaseSync {
    if (!this.ready) {
      ensureDeliberationSchema(this.database);
      this.ready = true;
    }
    return this.database;
  }

  /** Whether the table exists, without making it (a reader on a database the Executive never ran in). */
  private exists(): boolean {
    if (this.ready) return true;
    return Boolean(this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'executive_deliberations'`).get());
  }

  record(row: Omit<DeliberationRecord, 'outcomeAt'>): void {
    this.schema().prepare(`
      INSERT INTO executive_deliberations (deliberation_id, scope_key, at, trigger, capability, goal_id, reason, intent, value_rank, top_by_value,
        off_candidates, candidates_json, material_json, dispatch, cycle_id, task_id, outcome, next_think_at, choice_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.scopeKey, row.at, row.trigger, row.capability, row.goalId, row.reason, row.intent, row.valueRank, row.topByValue ? 1 : 0,
      row.offCandidates ? 1 : 0, JSON.stringify(row.candidates), JSON.stringify(row.material), row.dispatch, row.cycleId, row.taskId, row.outcome,
      row.nextThinkAt, row.choiceId);
  }

  last(scopeKey: string): DeliberationRecord | null {
    if (!this.exists()) return null;
    const row = this.database.prepare('SELECT * FROM executive_deliberations WHERE scope_key = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(scopeKey);
    return row ? recordOf(row as unknown as Row) : null;
  }

  /** Newest first, since an instant, at most `limit`. */
  since(scopeKey: string, since: string, limit = 200): readonly DeliberationRecord[] {
    if (!this.exists()) return [];
    const rows = this.database.prepare('SELECT * FROM executive_deliberations WHERE scope_key = ? AND at >= ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(scopeKey, since, Math.max(1, Math.min(2000, Math.trunc(limit))));
    return rows.map(row => recordOf(row as unknown as Row));
  }

  /** Deliberations whose outcome is still open (pending or running), oldest first. */
  open(scopeKey: string): readonly DeliberationRecord[] {
    if (!this.exists()) return [];
    return this.database.prepare(`SELECT * FROM executive_deliberations WHERE scope_key = ? AND outcome IN ('pending', 'running') ORDER BY at LIMIT 50`)
      .all(scopeKey).map(row => recordOf(row as unknown as Row));
  }

  /** The newest outcomes of a capability, newest first. */
  outcomes(scopeKey: string, capability: string, limit = 3): readonly DeliberationOutcome[] {
    if (!this.exists()) return [];
    return this.database.prepare(`
      SELECT outcome FROM executive_deliberations WHERE scope_key = ? AND capability = ? AND outcome NOT IN ('pending', 'running')
      ORDER BY at DESC LIMIT ?
    `).all(scopeKey, capability, limit).map(row => String(row.outcome) as DeliberationOutcome);
  }

  /** Whether any outcome closed after an instant (an own task ended: a trigger). */
  closedSince(scopeKey: string, since: string): boolean {
    if (!this.exists()) return false;
    return Boolean(this.database.prepare(`SELECT 1 FROM executive_deliberations WHERE scope_key = ? AND outcome_at > ? LIMIT 1`).get(scopeKey, since));
  }

  settle(id: string, outcome: DeliberationOutcome, at: string): void {
    this.schema().prepare(`UPDATE executive_deliberations SET outcome = ?, outcome_at = ? WHERE deliberation_id = ? AND outcome IN ('pending', 'running')`)
      .run(outcome, outcome === 'running' ? null : at, id);
  }

  /** The owner's "forget": her words of these deliberations go; the numbers stay. */
  forgetWords(scopeKey: string, at: string, ids?: readonly string[]): number {
    if (!this.exists()) return 0;
    const all = this.database.prepare(`UPDATE executive_deliberations SET reason = NULL, intent = NULL, forgotten_at = ?
      WHERE scope_key = ? AND forgotten_at IS NULL AND (? IS NULL OR deliberation_id IN (SELECT value FROM json_each(?)))`)
      .run(at, scopeKey, ids ? 1 : null, JSON.stringify(ids ?? []));
    return Number(all.changes);
  }

  /** The owner's reactions to her pieces since an instant, by reaction (`study_feedback`): numbers only. */
  ownerReactionsSince(scopeKey: string, since: string): Readonly<Record<string, number>> {
    if (!this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'study_feedback'`).get()) return {};
    const rows = this.database.prepare('SELECT reaction, COUNT(*) AS n FROM study_feedback WHERE scope_key = ? AND created_at > ? GROUP BY reaction')
      .all(scopeKey, since);
    return Object.fromEntries(rows.map(row => [String(row.reaction), Number(row.n)]));
  }
}

function parsed<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function recordOf(row: Row): DeliberationRecord {
  return Object.freeze({
    id: row.deliberation_id, scopeKey: row.scope_key, at: row.at, trigger: row.trigger as DeliberationTrigger, capability: row.capability,
    goalId: row.goal_id, reason: row.reason, intent: row.intent, valueRank: row.value_rank, topByValue: row.top_by_value === 1,
    offCandidates: row.off_candidates === 1, candidates: parsed(row.candidates_json, []), material: parsed(row.material_json, {}),
    dispatch: row.dispatch as DeliberationDispatch, cycleId: row.cycle_id, taskId: row.task_id, outcome: row.outcome as DeliberationOutcome,
    outcomeAt: row.outcome_at, nextThinkAt: row.next_think_at, choiceId: row.choice_id,
  });
}
