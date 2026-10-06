import type { DatabaseSync } from 'node:sqlite';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL } from '../../../contracts/cognitionLedgerContract.js';

/**
 * The table of her choices (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`, *Choice ledger*). Core: emotion.
 *
 * Additive, created when absent by the API's processes only. Closed symbols, ids, numbers and instants only
 * (`checkedChoice`). A choice is recorded when the gate allowed it (never one it refused, paused or held for the budget),
 * with the value she held then and its version; it is settled once, with its reward parts, r, δ and u.
 */
export const CHOICES_TABLE = 'shannon_choices';
export const CHOICE_SURFACES = ['autonomy', 'text', 'voice'] as const;
export const CHOICE_STATUSES = ['pending', 'settled', 'void'] as const;
export type ChoiceStatus = typeof CHOICE_STATUSES[number];

export interface ChoiceDraft {
  surface: typeof CHOICE_SURFACES[number];
  /** Closed: `reach_out.wonder`, `call.upcoming`, `draft`, `show`, `tool.study.search`, … */
  choice: string;
  /** `<band>.<presence>`: the owner-local quarter of the day and who was around (alone, others, away, unknown). */
  context: string;
  sourceKind: 'step' | 'tool_call';
  sourceId: string;
}

export interface StoredChoice extends ChoiceDraft {
  choiceId: string;
  scopeKey: string;
  chosenAt: string;
  valueVersion: string;
  expected: number;
  expectedSd: number;
  expectedNoise: number;
  expectedLevel: string;
  /** How many settled choices the cell that answered V had learned from (0 for the root before any version). */
  expectedN: number;
  status: ChoiceStatus;
  /** The step's own success: 1 done, 0 failed; null until it is reported. */
  success: number | null;
  /** What the choice was about (`study_piece`), for delayed credit; null when nothing. */
  subjectKind: string | null;
  subjectId: string | null;
  world: number | null;
  serve: number | null;
  growth: number | null;
  costYen: number;
  reward: number | null;
  delta: number | null;
  unexpected: number | null;
  /** How it was settled: `reported`, `reply`, `call`, `story`, `inherited`, `superseded`, `stale`, `void`, `lost`. */
  settleCode: string | null;
  settledAt: string | null;
  /** Step 7 (reward mood): when, and with which closed code, it moved her mood; null until then. */
  moodClaimedAt: string | null;
  moodCode: string | null;
  /** How far its appraisal moved valence, when it was applied. */
  moodStep?: number | null;
}

export function ensureChoiceLedgerSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_choices (
      choice_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      surface TEXT NOT NULL,
      choice TEXT NOT NULL,
      context TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chosen_at TEXT NOT NULL,
      value_version TEXT NOT NULL,
      expected REAL NOT NULL,
      expected_sd REAL NOT NULL,
      expected_noise REAL NOT NULL,
      expected_level TEXT NOT NULL,
      expected_n INTEGER,
      status TEXT NOT NULL,
      success REAL,
      subject_kind TEXT,
      subject_id TEXT,
      world REAL,
      serve REAL,
      growth REAL,
      cost_yen REAL NOT NULL,
      reward REAL,
      delta REAL,
      unexpected REAL,
      settle_code TEXT,
      settled_at TEXT,
      settle_seq INTEGER,
      mood_claimed_at TEXT,
      mood_code TEXT,
      mood_step REAL
    );
    CREATE INDEX IF NOT EXISTS shannon_choices_scope ON shannon_choices (scope_key, chosen_at);
    CREATE INDEX IF NOT EXISTS shannon_choices_status ON shannon_choices (scope_key, status);
    CREATE INDEX IF NOT EXISTS shannon_choices_subject ON shannon_choices (scope_key, subject_kind, subject_id);
    CREATE INDEX IF NOT EXISTS shannon_choices_settled ON shannon_choices (scope_key, settle_seq);
    CREATE TABLE IF NOT EXISTS shannon_choice_ledger_seq (scope_key TEXT PRIMARY KEY, last_seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS shannon_choices_mood ON shannon_choices (scope_key, mood_claimed_at);
  `);
  // Added with step 7b: how far a choice's appraisal moved valence (the rate safeguard sums it).
  const columns = (database.prepare("PRAGMA table_info('shannon_choices')").all() as Array<{ name: string }>).map(column => column.name);
  if (!columns.includes('mood_step')) database.exec('ALTER TABLE shannon_choices ADD COLUMN mood_step REAL');
  // Added with the warm-up: how many settled choices the cell that answered V had learned from.
  if (!columns.includes('expected_n')) database.exec('ALTER TABLE shannon_choices ADD COLUMN expected_n INTEGER');
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function checkedChoice(row: StoredChoice): StoredChoice {
  if (!(CHOICE_SURFACES as readonly string[]).includes(row.surface) || !['step', 'tool_call'].includes(row.sourceKind)) throw new Error('CHOICE_VOCABULARY');
  if (![row.choice, row.context, row.expectedLevel].every(value => PREDICTION_SYMBOL.test(value))) throw new Error('CHOICE_SYMBOL');
  if (![row.choiceId, row.sourceId, row.valueVersion].every(value => PREDICTION_SOURCE_ID.test(value))) throw new Error('CHOICE_IDENTIFIER');
  if (!Number.isFinite(Date.parse(row.chosenAt))) throw new Error('CHOICE_TIME');
  if (![row.expected, row.expectedSd, row.expectedNoise, row.costYen, row.expectedN].every(Number.isFinite)) throw new Error('CHOICE_NUMBER');
  return { ...row, expected: round(row.expected), expectedSd: round(row.expectedSd), expectedNoise: round(row.expectedNoise), costYen: round(row.costYen), chosenAt: new Date(Date.parse(row.chosenAt)).toISOString() };
}

export class SQLiteChoiceLedger {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureChoiceLedgerSchema(database);
  }

  insert(row: StoredChoice): void {
    const value = checkedChoice(row);
    this.database.prepare(`
      INSERT OR IGNORE INTO shannon_choices (choice_id, scope_key, surface, choice, context, source_kind, source_id, chosen_at, value_version, expected,
        expected_sd, expected_noise, expected_level, expected_n, status, cost_yen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(value.choiceId, value.scopeKey, value.surface, value.choice, value.context, value.sourceKind, value.sourceId, value.chosenAt, value.valueVersion,
      value.expected, value.expectedSd, value.expectedNoise, value.expectedLevel, Math.max(0, Math.round(value.expectedN)), value.costYen);
  }

  /** The step's own outcome, its cost and what it was about; only while it is pending and not yet reported. */
  report(scopeKey: string, choiceId: string, report: { success: 0 | 1; costYen: number; subject?: { kind: string; id: string } }): boolean {
    if (!Number.isFinite(report.costYen)) throw new Error('CHOICE_NUMBER');
    if (report.subject && (!PREDICTION_SYMBOL.test(report.subject.kind) || !PREDICTION_SOURCE_ID.test(report.subject.id))) throw new Error('CHOICE_IDENTIFIER');
    const result = this.database.prepare(`
      UPDATE shannon_choices SET success = ?, cost_yen = ?, subject_kind = ?, subject_id = ? WHERE scope_key = ? AND choice_id = ? AND status = 'pending' AND success IS NULL
    `).run(report.success, round(report.costYen), report.subject?.kind ?? null, report.subject?.id ?? null, scopeKey, choiceId);
    return Number(result.changes) > 0;
  }

  /** Settles a pending choice once; with parts it is scored and takes the next place in the order of settling. */
  settle(scopeKey: string, choiceId: string, settlement: { world: number; serve: number; growth: number; reward: number; delta: number; unexpected: number } | null, code: string, at: string): boolean {
    if (!PREDICTION_SYMBOL.test(code)) throw new Error('CHOICE_SYMBOL');
    const seq = settlement ? this.lastSeq(scopeKey) + 1 : null;
    const values = settlement ? [settlement.world, settlement.serve, settlement.growth, settlement.reward, settlement.delta, settlement.unexpected].map(round) : [null, null, null, null, null, null];
    const result = this.database.prepare(`
      UPDATE shannon_choices SET status = ?, world = ?, serve = ?, growth = ?, reward = ?, delta = ?, unexpected = ?, settle_code = ?, settled_at = ?, settle_seq = ?
      WHERE scope_key = ? AND choice_id = ? AND status = 'pending'
    `).run(settlement ? 'settled' : 'void', ...values, code, new Date(Date.parse(at)).toISOString(), seq, scopeKey, choiceId);
    const changed = Number(result.changes) > 0;
    if (changed && seq !== null) {
      this.database.prepare('INSERT INTO shannon_choice_ledger_seq (scope_key, last_seq) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET last_seq = excluded.last_seq').run(scopeKey, seq);
    }
    return changed;
  }

  get(scopeKey: string, choiceId: string): StoredChoice | null {
    const row = this.database.prepare('SELECT * FROM shannon_choices WHERE scope_key = ? AND choice_id = ?').get(scopeKey, choiceId) as Record<string, unknown> | undefined;
    return row ? parsed(row) : null;
  }

  pending(scopeKey: string): StoredChoice[] {
    return (this.database.prepare("SELECT * FROM shannon_choices WHERE scope_key = ? AND status = 'pending' ORDER BY chosen_at, choice_id").all(scopeKey) as Array<Record<string, unknown>>).map(parsed);
  }

  /** Choices about one subject, oldest first. */
  forSubject(scopeKey: string, kind: string, id: string): StoredChoice[] {
    return (this.database.prepare('SELECT * FROM shannon_choices WHERE scope_key = ? AND subject_kind = ? AND subject_id = ? ORDER BY chosen_at, choice_id').all(scopeKey, kind, id) as Array<Record<string, unknown>>).map(parsed);
  }

  all(scopeKey: string): StoredChoice[] {
    return (this.database.prepare('SELECT * FROM shannon_choices WHERE scope_key = ? ORDER BY chosen_at, choice_id').all(scopeKey) as Array<Record<string, unknown>>).map(parsed);
  }

  /** Settled, scored choices in the order they were settled: what the value table folds. */
  settledInOrder(scopeKey: string, upTo = Number.MAX_SAFE_INTEGER): Array<StoredChoice & { settleSeq: number }> {
    return (this.database.prepare("SELECT * FROM shannon_choices WHERE scope_key = ? AND status = 'settled' AND settle_seq <= ? ORDER BY settle_seq").all(scopeKey, upTo) as Array<Record<string, unknown>>)
      .map(row => ({ ...parsed(row), settleSeq: Number(row.settle_seq) }));
  }

  lastSeq(scopeKey: string): number {
    const row = this.database.prepare('SELECT last_seq FROM shannon_choice_ledger_seq WHERE scope_key = ?').get(scopeKey) as { last_seq: number } | undefined;
    const table = this.database.prepare('SELECT COALESCE(MAX(settle_seq), 0) AS seq FROM shannon_choices WHERE scope_key = ?').get(scopeKey) as { seq: number };
    return Math.max(row ? Number(row.last_seq) : 0, Number(table.seq));
  }

  pruneBefore(scopeKey: string, before: string): number {
    return Number(this.database.prepare('DELETE FROM shannon_choices WHERE scope_key = ? AND chosen_at < ?').run(scopeKey, before).changes);
  }

  /**
   * Step 7b: settled choices of her own time whose mood was not yet claimed, in the order they were settled. A tool call in a
   * conversation (surface text or voice) is the owner's request, not her choice: it is data only and never claimed.
   */
  unclaimed(scopeKey: string, limit = 50): StoredChoice[] {
    return (this.database.prepare("SELECT * FROM shannon_choices WHERE scope_key = ? AND surface = 'autonomy' AND status = 'settled' AND mood_claimed_at IS NULL ORDER BY settle_seq LIMIT ?")
      .all(scopeKey, limit) as Array<Record<string, unknown>>).map(parsed);
  }

  /** Scopes with settled choices whose mood was not yet claimed. */
  unclaimedScopes(): string[] {
    return (this.database.prepare("SELECT DISTINCT scope_key FROM shannon_choices WHERE surface = 'autonomy' AND status = 'settled' AND mood_claimed_at IS NULL").all() as Array<{ scope_key: string }>).map(row => row.scope_key);
  }

  /**
   * Claims a choice's mood once (any connection): true for the one claim that changed the row. An applied claim carries the
   * step it moves valence by, in the same statement, so the rate safeguard of another connection sees it at once.
   */
  claimMood(scopeKey: string, choiceId: string, code: string, at: string, step: number | null): boolean {
    if (!PREDICTION_SYMBOL.test(code)) throw new Error('CHOICE_SYMBOL');
    return Number(this.database.prepare('UPDATE shannon_choices SET mood_claimed_at = ?, mood_code = ?, mood_step = ? WHERE scope_key = ? AND choice_id = ? AND mood_claimed_at IS NULL')
      .run(new Date(Date.parse(at)).toISOString(), code, step === null ? null : round(Math.abs(step)), scopeKey, choiceId).changes) > 0;
  }

  /** The summed steps of appraisals applied since an instant (the rate safeguard). */
  moodStepsSince(scopeKey: string, since: string): number {
    const row = this.database.prepare("SELECT COALESCE(SUM(mood_step), 0) AS total FROM shannon_choices WHERE scope_key = ? AND mood_code IN ('applied', 'applied_capped') AND mood_claimed_at >= ?")
      .get(scopeKey, since) as { total: number };
    return Number(row.total);
  }

  /** The valence change an applied appraisal actually made (replaces the step expected at the claim). */
  recordMoodStep(scopeKey: string, choiceId: string, step: number): void {
    this.database.prepare('UPDATE shannon_choices SET mood_step = ? WHERE scope_key = ? AND choice_id = ?').run(round(Math.abs(step)), scopeKey, choiceId);
  }

  /** How many choices of a scope are pending, settled and void. */
  counts(scopeKey: string): Record<string, number> {
    const counts: Record<string, number> = { pending: 0, settled: 0, void: 0 };
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS n FROM shannon_choices WHERE scope_key = ? GROUP BY status').all(scopeKey) as Array<{ status: string; n: number }>) counts[row.status] = Number(row.n);
    return counts;
  }

  scopes(): string[] {
    return (this.database.prepare('SELECT DISTINCT scope_key FROM shannon_choices').all() as Array<{ scope_key: string }>).map(row => row.scope_key);
  }
}

function parsed(row: Record<string, unknown>): StoredChoice {
  const nullable = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    choiceId: String(row.choice_id), scopeKey: String(row.scope_key), surface: String(row.surface) as StoredChoice['surface'], choice: String(row.choice),
    context: String(row.context), sourceKind: String(row.source_kind) as StoredChoice['sourceKind'], sourceId: String(row.source_id), chosenAt: String(row.chosen_at),
    valueVersion: String(row.value_version), expected: Number(row.expected), expectedSd: Number(row.expected_sd), expectedNoise: Number(row.expected_noise),
    expectedLevel: String(row.expected_level), expectedN: Number(row.expected_n ?? 0), status: String(row.status) as ChoiceStatus, success: nullable(row.success),
    subjectKind: text(row.subject_kind), subjectId: text(row.subject_id), world: nullable(row.world), serve: nullable(row.serve), growth: nullable(row.growth),
    costYen: Number(row.cost_yen), reward: nullable(row.reward), delta: nullable(row.delta), unexpected: nullable(row.unexpected),
    settleCode: text(row.settle_code), settledAt: text(row.settled_at), moodClaimedAt: text(row.mood_claimed_at), moodCode: text(row.mood_code), moodStep: nullable(row.mood_step),
  };
}
