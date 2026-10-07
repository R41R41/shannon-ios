/**
 * What a step of her own activity led to, kept as facts she can think about (owner decision
 * 2026-10-02: act, observe, think again).
 *
 * A row is a closed vocabulary, numbers, timestamps and one identifier. There is no column
 * and no field for words: not hers, not the owner's. Whether he answered is a yes or no and
 * a number of seconds, derived from timestamps by the caller. A row is read back through the
 * same closed sets, so nothing else can leave this table for a prompt.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { REACH_OUT_DELIVERY_OUTCOMES, REACH_OUT_APP_SURFACES, REACH_OUT_CALL_OUTCOMES, OBSERVED_REACH_OUT_REASONS, OBSERVED_STEP_KINDS, type ReachOutFacts, type StepObservation, type StepObservationDraft } from '../../../../contracts/autonomyObservationContract.js';
export { REACH_OUT_DELIVERY_OUTCOMES, type ReachOutDeliveryOutcome, REACH_OUT_APP_SURFACES, type ReachOutAppSurface, REACH_OUT_CALL_OUTCOMES, type ReachOutCallOutcome, OBSERVATION_RETENTION_DAYS, OBSERVED_REACH_OUT_REASONS, type ObservedReachOutReason, OBSERVED_STEP_KINDS, type ObservedStepKind, type ReachOutFacts, type AutonomyPredictionTap, type StepObservation, type StepObservationDraft } from '../../../../contracts/autonomyObservationContract.js';

interface ObservationRow { observation_id: string; cycle_id: string; ordinal: number; step_kind: string; facts_json: string; observed_at: string }

const CODE = /^[a-z][a-z0-9_]{0,39}$/u;
const IDENTIFIER = /^[A-Za-z0-9-]{1,80}$/u;

export class AutonomyLoopObservations {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_loop_observations (
        observation_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        step_kind TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (cycle_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS autonomy_loop_observations_scope ON autonomy_loop_observations (scope_key, observed_at DESC);
    `);
  }

  /** One observation per step; a second for the same step is ignored. */
  add(scopeKey: string, draft: StepObservationDraft, at: string): void {
    const facts = {
      outcome: draft.outcome, ...(draft.code && CODE.test(draft.code) ? { code: draft.code } : {}),
      ...(draft.chain ? { chain: true } : {}), ...(draft.reachOut ? { reachOut: draft.reachOut } : {}),
    };
    this.database.prepare(`
      INSERT OR IGNORE INTO autonomy_loop_observations (observation_id, scope_key, cycle_id, ordinal, step_kind, facts_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scopeKey, draft.cycleId, draft.ordinal, draft.step, JSON.stringify(facts), at);
  }

  /** The observations of one cycle, in the order of its steps. */
  ofCycle(cycleId: string): readonly StepObservation[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_loop_observations WHERE cycle_id = ? ORDER BY ordinal
    `).all(cycleId) as unknown as ObservationRow[];
    return Object.freeze(rows.flatMap(observation));
  }

  /** Observations since an instant, oldest first, at most two hundred. */
  since(scopeKey: string, since: string): readonly StepObservation[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_loop_observations WHERE scope_key = ? AND observed_at >= ? ORDER BY observed_at DESC, ordinal DESC LIMIT 200
    `).all(scopeKey, since) as unknown as ObservationRow[];
    return Object.freeze(rows.flatMap(observation).reverse());
  }

  /** Drops observations older than the boundary; what they said has by then been her day's record for long. */
  prune(scopeKey: string, before: string): void {
    this.database.prepare('DELETE FROM autonomy_loop_observations WHERE scope_key = ? AND observed_at < ?').run(scopeKey, before);
  }
}

function observation(row: ObservationRow): StepObservation[] {
  let facts: Record<string, unknown>;
  try { facts = JSON.parse(row.facts_json) as Record<string, unknown>; } catch { return []; }
  const step = OBSERVED_STEP_KINDS.find(kind => kind === row.step_kind);
  const outcome = facts?.outcome === 'done' || facts?.outcome === 'failed' || facts?.outcome === 'refused' ? facts.outcome : null;
  if (!step || !outcome) return [];
  const reachOut = reachOutFacts(facts.reachOut);
  return [Object.freeze({
    id: row.observation_id, cycleId: row.cycle_id, ordinal: Number(row.ordinal), step, outcome,
    ...(typeof facts.code === 'string' && CODE.test(facts.code) ? { code: facts.code } : {}),
    ...(facts.chain === true ? { chain: true } : {}), ...(reachOut ? { reachOut } : {}), observedAt: row.observed_at,
  })];
}

/** The facts of a message as closed values; anything else in the stored object is dropped. */
function reachOutFacts(value: unknown): ReachOutFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reason = OBSERVED_REACH_OUT_REASONS.find(item => item === raw.reason);
  if (!reason || typeof raw.id !== 'string' || !IDENTIFIER.test(raw.id) || typeof raw.sentAt !== 'string' || !Number.isFinite(Date.parse(raw.sentAt))) return null;
  const seconds = (item: unknown) => (typeof item === 'number' && Number.isFinite(item) ? Math.max(0, Math.min(86_400, Math.round(item))) : 0);
  const delivery = REACH_OUT_DELIVERY_OUTCOMES.find(item => item === raw.delivery) ?? 'unknown';
  const surface = REACH_OUT_APP_SURFACES.find(item => item === raw.surface);
  const call = REACH_OUT_CALL_OUTCOMES.find(item => item === raw.call);
  return Object.freeze({
    id: raw.id, reason, sentAt: new Date(Date.parse(raw.sentAt)).toISOString(), waitedSeconds: seconds(raw.waitedSeconds),
    replied: raw.replied === true, ...(raw.replied === true ? { repliedAfterSeconds: seconds(raw.repliedAfterSeconds) } : {}),
    delivery, ...(surface && delivery !== 'unknown' ? { surface } : {}), ...(call ? { call } : {}), windowVisible: raw.windowVisible === true,
    owner: raw.owner === 'away' || raw.owner === 'returned' ? raw.owner : 'unknown', others: raw.others === true,
    ...(raw.unwatched === true ? { unwatched: true as const } : {}),
  });
}
