import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BODY_REACH_OUT_DELIVERY_OUTCOMES, type BodyReachOutDeliveryOutcome } from './bodyContract.js';

/**
 * What a step of her own activity led to, kept as facts she can think about (owner decision
 * 2026-10-02: act, observe, think again).
 *
 * A row is a closed vocabulary, numbers, timestamps and one identifier. There is no column
 * and no field for words: not hers, not the owner's. Whether he answered is a yes or no and
 * a number of seconds, derived from timestamps by the caller. A row is read back through the
 * same closed sets, so nothing else can leave this table for a prompt.
 */
/** What her body says it did with a message of hers: the closed vocabulary of the body contract. */
export const REACH_OUT_DELIVERY_OUTCOMES = BODY_REACH_OUT_DELIVERY_OUTCOMES;
export type ReachOutDeliveryOutcome = BodyReachOutDeliveryOutcome;
/** One of the owner's apps that said her message through his earphones, instead of her body. */
export const REACH_OUT_APP_SURFACES = ['mac', 'iphone'] as const;
export type ReachOutAppSurface = typeof REACH_OUT_APP_SURFACES[number];

/** What became of the call the server placed with a message of hers (`incomingCalls.ts`): the owner's iPhone rang. */
export const REACH_OUT_CALL_OUTCOMES = ['answered', 'declined', 'unanswered', 'failed'] as const;
export type ReachOutCallOutcome = typeof REACH_OUT_CALL_OUTCOMES[number];

export const OBSERVED_REACH_OUT_REASONS = ['share', 'wonder', 'upcoming', 'saw', 'follow_up'] as const;
export type ObservedReachOutReason = typeof OBSERVED_REACH_OUT_REASONS[number];

export const OBSERVED_STEP_KINDS = ['think', 'read', 'notion', 'note', 'draft', 'revise', 'show', 'put_away', 'copy', 'look', 'reach_out', 'jot', 'rest', 'tool'] as const;
export type ObservedStepKind = typeof OBSERVED_STEP_KINDS[number];

/** What followed one message of hers. */
export interface ReachOutFacts {
  /** The initiative id of the message: an identifier, never its words. */
  id: string;
  reason: ObservedReachOutReason;
  sentAt: string;
  waitedSeconds: number;
  /** The owner wrote or spoke in any Talk after the message. Never what he said. */
  replied: boolean;
  repliedAfterSeconds?: number;
  /** What her body reported about this message; `unknown` when no body reported in time. */
  delivery: ReachOutDeliveryOutcome | 'unknown';
  /** Set when `delivery` came from one of the owner's apps, which spoke it through his earphones; absent for her body. */
  surface?: ReachOutAppSurface;
  /** Set when the server rang his iPhone with this message: what became of that call. Absent when nothing was rung, or it still rings. */
  call?: ReachOutCallOutcome;
  /** A body read presence in the last half minute, so her window was showing. */
  windowVisible: boolean;
  /** The newest of the body's away and returned events of the last hour. */
  owner: 'away' | 'returned' | 'unknown';
  /** Someone other than the owner could see or hear her body. */
  others: boolean;
  /** The step stopped before she could watch what followed: whether he answered is not known. */
  unwatched?: true;
}

export interface StepObservation {
  id: string;
  cycleId: string;
  /** The step's place in its cycle. */
  ordinal: number;
  step: ObservedStepKind;
  /** `refused`: the gate did not allow it. */
  outcome: 'done' | 'failed' | 'refused';
  /** Why, as a code from the step's own closed set. */
  code?: string;
  /** A look she chose after a message of hers got no answer. */
  chain?: boolean;
  reachOut?: ReachOutFacts;
  observedAt: string;
}

export type StepObservationDraft = Omit<StepObservation, 'id' | 'observedAt'>;

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
