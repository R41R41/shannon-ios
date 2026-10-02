import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AutonomyLoopObservations, type ObservedReachOutReason } from './autonomyLoopObservations.js';

/**
 * Durable state of the activity loop (Syzygy ADR-0002 step 3): the single-runner
 * lease, the current cycle and its remaining plan, a journal of steps, the public
 * pages she has read but not yet written a note about, and the cadence.
 *
 * The journal is what makes the loop restart-safe. A step is written as `planned`
 * before the gate is asked, `authorized` once the gate allowed it, and `reported` in
 * the same transaction that writes its activity-record entry and its cost. A step a
 * crash left `planned` or `authorized` is closed as `abandoned` and never run again.
 */
export type AutonomyStepKind = 'think' | 'read' | 'notion' | 'note' | 'draft' | 'revise' | 'show' | 'put_away' | 'copy' | 'look' | 'reach_out' | 'jot';
export type AutonomyStepStatus = 'planned' | 'authorized' | 'reported' | 'refused' | 'abandoned';
/** What the loop process last said about itself; the API reads it to describe the loop to the owner. */
export type AutonomyLoopReadiness = 'ready' | 'disabled' | 'no_credential';

export interface AutonomyPlannedStep {
  kind: AutonomyStepKind;
  url?: string;
  readingId?: string;
  pursuitId?: string;
  pieceId?: string;
  /** What she means to write or change, in her words; for `jot`, the short note itself. */
  intent?: string;
  /** For `notion`: what she is looking for in the shared pages. */
  query?: string;
  /** For `reach_out`: why she speaks up, from the closed set. `follow_up` is the one second call after a message got no answer. */
  reason?: ObservedReachOutReason;
  /** For `reach_out` with `follow_up`: the initiative id of the message that got no answer. */
  originId?: string;
  /** For `think`: a thinking step after something happened in this cycle, with what happened in front of her. */
  again?: true;
  /** For `look`: chosen after a message of hers got no answer; she thinks once more with what she saw. */
  chain?: true;
}

export interface AutonomyLoopCycle {
  id: string;
  scopeKey: string;
  dayKey: string;
  /** `activity` counts against the cycles of a day; `show` only tells the owner about a ready piece. */
  kind: 'activity' | 'show';
  startedAt: string;
  plan: readonly AutonomyPlannedStep[];
  stepsTaken: number;
  thought: boolean;
}

export interface AutonomyLoopStep {
  id: string;
  cycleId: string;
  ordinal: number;
  step: AutonomyPlannedStep;
  status: AutonomyStepStatus;
  decisionId?: string;
  /** The tokens the gate was asked to make room for; charged if the step is abandoned after it was allowed. */
  estimate?: { inputTokens: number; outputTokens: number };
}

export interface AutonomyReading {
  id: string;
  url: string;
  title: string;
  text: string;
  links: readonly { title: string; url: string }[];
  pursuitId?: string;
  fetchedAt: string;
  notedAt?: string;
}

export interface AutonomyLoopHeartbeat {
  ownerId: string;
  heartbeatAt: string;
  leaseUntil: string;
  readiness: AutonomyLoopReadiness;
}

const LEASE_NAME = 'activity-loop';

export class AutonomyLoopState {
  /** What her steps led to, as facts (`autonomyLoopObservations.ts`). */
  readonly observations: AutonomyLoopObservations;

  constructor(private readonly database: DatabaseSync) {
    this.observations = new AutonomyLoopObservations(database);
    database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_loop_lease (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        readiness TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS autonomy_loop_cycles (
        cycle_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('activity', 'show')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        plan_json TEXT NOT NULL DEFAULT '[]',
        steps_taken INTEGER NOT NULL DEFAULT 0,
        thought INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS autonomy_loop_one_open_cycle ON autonomy_loop_cycles (scope_key) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS autonomy_loop_steps (
        step_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        step_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned', 'authorized', 'reported', 'refused', 'abandoned')),
        decision_id TEXT,
        estimate_json TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (cycle_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS autonomy_loop_schedule (
        scope_key TEXT PRIMARY KEY,
        next_cycle_at TEXT NOT NULL,
        budget_blocked_day TEXT,
        budget_blocked_cap_yen REAL
      );
      CREATE TABLE IF NOT EXISTS autonomy_loop_readings (
        reading_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        links_json TEXT NOT NULL DEFAULT '[]',
        pursuit_id TEXT,
        fetched_at TEXT NOT NULL,
        noted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS autonomy_loop_readings_scope ON autonomy_loop_readings (scope_key, fetched_at DESC);
    `);
  }

  // MARK: Lease

  /**
   * Takes or renews the one lease of the loop. Only the holder, or anyone once the lease
   * has run out, gets it; everybody else is told no and must not run a step.
   */
  acquireLease(ownerId: string, at: string, leaseUntil: string, readiness: AutonomyLoopReadiness): boolean {
    this.database.prepare(`
      INSERT OR IGNORE INTO autonomy_loop_lease (name, owner_id, lease_until, heartbeat_at, readiness) VALUES (?, ?, ?, ?, ?)
    `).run(LEASE_NAME, ownerId, leaseUntil, at, readiness);
    const result = this.database.prepare(`
      UPDATE autonomy_loop_lease SET owner_id = ?, lease_until = ?, heartbeat_at = ?, readiness = ?
      WHERE name = ? AND (owner_id = ? OR lease_until <= ?)
    `).run(ownerId, leaseUntil, at, readiness, LEASE_NAME, ownerId, at);
    return Number(result.changes) > 0;
  }

  holdsLease(ownerId: string, at: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM autonomy_loop_lease WHERE name = ? AND owner_id = ? AND lease_until > ?
    `).get(LEASE_NAME, ownerId, at));
  }

  releaseLease(ownerId: string, at: string): void {
    this.database.prepare(`
      UPDATE autonomy_loop_lease SET lease_until = ? WHERE name = ? AND owner_id = ?
    `).run(at, LEASE_NAME, ownerId);
  }

  heartbeat(): AutonomyLoopHeartbeat | null {
    const row = this.database.prepare(`
      SELECT owner_id, lease_until, heartbeat_at, readiness FROM autonomy_loop_lease WHERE name = ?
    `).get(LEASE_NAME) as unknown as { owner_id: string; lease_until: string; heartbeat_at: string; readiness: string } | undefined;
    return row ? Object.freeze({
      ownerId: row.owner_id, heartbeatAt: row.heartbeat_at, leaseUntil: row.lease_until,
      readiness: (['ready', 'disabled', 'no_credential'].includes(row.readiness) ? row.readiness : 'disabled') as AutonomyLoopReadiness,
    }) : null;
  }

  // MARK: Cycles

  openCycle(scopeKey: string): AutonomyLoopCycle | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_loop_cycles WHERE scope_key = ? AND ended_at IS NULL
    `).get(scopeKey) as unknown as CycleRow | undefined;
    return row ? cycle(row) : null;
  }

  startCycle(scopeKey: string, dayKey: string, kind: AutonomyLoopCycle['kind'], plan: readonly AutonomyPlannedStep[], at: string): AutonomyLoopCycle {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO autonomy_loop_cycles (cycle_id, scope_key, day_key, kind, started_at, plan_json) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, scopeKey, dayKey, kind, at, JSON.stringify(plan));
    return this.openCycle(scopeKey)!;
  }

  setPlan(cycleId: string, plan: readonly AutonomyPlannedStep[], thought: boolean): void {
    this.database.prepare(`
      UPDATE autonomy_loop_cycles SET plan_json = ?, thought = MAX(thought, ?) WHERE cycle_id = ? AND ended_at IS NULL
    `).run(JSON.stringify(plan), thought ? 1 : 0, cycleId);
  }

  endCycle(cycleId: string, reason: string, at: string): void {
    this.database.prepare(`
      UPDATE autonomy_loop_cycles SET ended_at = ?, end_reason = ? WHERE cycle_id = ? AND ended_at IS NULL
    `).run(at, reason.slice(0, 60), cycleId);
  }

  activityCyclesOn(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM autonomy_loop_cycles WHERE scope_key = ? AND day_key = ? AND kind = 'activity'
    `).get(scopeKey, dayKey) as unknown as { count: number };
    return Number(row.count);
  }

  nextCycleAt(scopeKey: string): string | null {
    const row = this.database.prepare(`
      SELECT next_cycle_at FROM autonomy_loop_schedule WHERE scope_key = ?
    `).get(scopeKey) as unknown as { next_cycle_at: string } | undefined;
    return row?.next_cycle_at ?? null;
  }

  setNextCycleAt(scopeKey: string, at: string): void {
    this.database.prepare(`
      INSERT INTO autonomy_loop_schedule (scope_key, next_cycle_at) VALUES (?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET next_cycle_at = excluded.next_cycle_at
    `).run(scopeKey, at);
  }

  /** The day's cap stopped a paid step. Remembered with the cap, so a raise by the owner lifts it. */
  noteBudgetBlocked(scopeKey: string, dayKey: string, capYen: number, at: string): void {
    this.database.prepare(`
      INSERT INTO autonomy_loop_schedule (scope_key, next_cycle_at, budget_blocked_day, budget_blocked_cap_yen) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET budget_blocked_day = excluded.budget_blocked_day, budget_blocked_cap_yen = excluded.budget_blocked_cap_yen
    `).run(scopeKey, at, dayKey, capYen);
  }

  budgetBlocked(scopeKey: string, dayKey: string, capYen: number): boolean {
    const row = this.database.prepare(`
      SELECT budget_blocked_day, budget_blocked_cap_yen FROM autonomy_loop_schedule WHERE scope_key = ?
    `).get(scopeKey) as unknown as { budget_blocked_day: string | null; budget_blocked_cap_yen: number | null } | undefined;
    return row?.budget_blocked_day === dayKey && Number(row.budget_blocked_cap_yen) >= capYen;
  }

  // MARK: Steps

  /** Writes the next step of a cycle. The ordinal is unique, so two runners can never both begin it. */
  beginStep(cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, remainingPlan: readonly AutonomyPlannedStep[], at: string): AutonomyLoopStep {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO autonomy_loop_steps (step_id, scope_key, cycle_id, ordinal, step_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'planned', ?)
    `).run(id, cycle.scopeKey, cycle.id, cycle.stepsTaken, JSON.stringify(step), at);
    this.database.prepare(`
      UPDATE autonomy_loop_cycles SET steps_taken = steps_taken + 1, plan_json = ?, thought = MAX(thought, ?) WHERE cycle_id = ?
    `).run(JSON.stringify(remainingPlan), step.kind === 'think' ? 1 : 0, cycle.id);
    return Object.freeze({ id, cycleId: cycle.id, ordinal: cycle.stepsTaken, step, status: 'planned' as const });
  }

  markAuthorized(stepId: string, decisionId: string, estimate: AutonomyLoopStep['estimate']): void {
    this.database.prepare(`
      UPDATE autonomy_loop_steps SET status = 'authorized', decision_id = ?, estimate_json = ? WHERE step_id = ? AND status = 'planned'
    `).run(decisionId, estimate ? JSON.stringify(estimate) : null, stepId);
  }

  /** Closes a step. Returns false when it was already closed, so nothing is reported twice. */
  finishStep(stepId: string, status: 'reported' | 'refused' | 'abandoned', at: string, decisionId?: string): boolean {
    const result = this.database.prepare(`
      UPDATE autonomy_loop_steps SET status = ?, finished_at = ?, decision_id = COALESCE(decision_id, ?)
      WHERE step_id = ? AND status IN ('planned', 'authorized')
    `).run(status, at, decisionId ?? null, stepId);
    return Number(result.changes) > 0;
  }

  /** Steps a stopped process left open. */
  unfinishedSteps(scopeKey: string): readonly AutonomyLoopStep[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_loop_steps WHERE scope_key = ? AND status IN ('planned', 'authorized') ORDER BY created_at
    `).all(scopeKey) as unknown as StepRow[];
    return Object.freeze(rows.map(step));
  }

  steps(cycleId: string): readonly AutonomyLoopStep[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_loop_steps WHERE cycle_id = ? ORDER BY ordinal
    `).all(cycleId) as unknown as StepRow[];
    return Object.freeze(rows.map(step));
  }

  // MARK: Readings

  addReading(scopeKey: string, reading: Omit<AutonomyReading, 'id' | 'fetchedAt' | 'notedAt'>, at: string): AutonomyReading {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO autonomy_loop_readings (reading_id, scope_key, url, title, text, links_json, pursuit_id, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, scopeKey, reading.url.slice(0, 2_000), reading.title.slice(0, 200), reading.text,
      JSON.stringify(reading.links.slice(0, 12)), reading.pursuitId ?? null, at);
    return this.reading(scopeKey, id)!;
  }

  reading(scopeKey: string, id: string): AutonomyReading | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_loop_readings WHERE scope_key = ? AND reading_id = ?
    `).get(scopeKey, id) as unknown as ReadingRow | undefined;
    return row ? reading(row) : null;
  }

  /** Pages read but not yet written up, newest first. */
  unnotedReadings(scopeKey: string): readonly AutonomyReading[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_loop_readings WHERE scope_key = ? AND noted_at IS NULL ORDER BY fetched_at DESC, rowid DESC LIMIT 6
    `).all(scopeKey) as unknown as ReadingRow[];
    return Object.freeze(rows.map(reading));
  }

  /** Links found on recently read pages: places she could read next. */
  readingLeads(scopeKey: string, limit = 8): readonly { title: string; url: string }[] {
    const rows = this.database.prepare(`
      SELECT links_json FROM autonomy_loop_readings WHERE scope_key = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 4
    `).all(scopeKey) as unknown as Array<{ links_json: string }>;
    const seen = new Set<string>();
    const leads: { title: string; url: string }[] = [];
    for (const row of rows) for (const link of links(row.links_json)) {
      if (seen.has(link.url) || this.wasRead(scopeKey, link.url)) continue;
      seen.add(link.url);
      leads.push(link);
    }
    return Object.freeze(leads.slice(0, limit));
  }

  wasRead(scopeKey: string, url: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM autonomy_loop_readings WHERE scope_key = ? AND url = ? LIMIT 1
    `).get(scopeKey, url));
  }

  /** Once the note is written the page text is dropped: her note is what is kept, not a copy of the page. */
  markReadingNoted(scopeKey: string, id: string, at: string): void {
    this.database.prepare(`
      UPDATE autonomy_loop_readings SET noted_at = ?, text = '' WHERE scope_key = ? AND reading_id = ?
    `).run(at, scopeKey, id);
  }
}

interface CycleRow {
  cycle_id: string; scope_key: string; day_key: string; kind: string; started_at: string; plan_json: string; steps_taken: number; thought: number;
}
interface StepRow {
  step_id: string; cycle_id: string; ordinal: number; step_json: string; status: string; decision_id: string | null; estimate_json: string | null;
}
interface ReadingRow {
  reading_id: string; url: string; title: string; text: string; links_json: string; pursuit_id: string | null; fetched_at: string; noted_at: string | null;
}

function cycle(row: CycleRow): AutonomyLoopCycle {
  return Object.freeze({
    id: row.cycle_id, scopeKey: row.scope_key, dayKey: row.day_key, kind: row.kind === 'show' ? 'show' as const : 'activity' as const,
    startedAt: row.started_at, plan: Object.freeze(parsed<AutonomyPlannedStep[]>(row.plan_json, [])),
    stepsTaken: Number(row.steps_taken), thought: Number(row.thought) === 1,
  });
}

function step(row: StepRow): AutonomyLoopStep {
  const estimate = row.estimate_json ? parsed<AutonomyLoopStep['estimate'] | null>(row.estimate_json, null) : null;
  return Object.freeze({
    id: row.step_id, cycleId: row.cycle_id, ordinal: Number(row.ordinal),
    step: parsed<AutonomyPlannedStep>(row.step_json, { kind: 'think' }), status: row.status as AutonomyStepStatus,
    ...(row.decision_id ? { decisionId: row.decision_id } : {}), ...(estimate ? { estimate } : {}),
  });
}

function reading(row: ReadingRow): AutonomyReading {
  return Object.freeze({
    id: row.reading_id, url: row.url, title: row.title, text: row.text, links: Object.freeze(links(row.links_json)),
    ...(row.pursuit_id ? { pursuitId: row.pursuit_id } : {}), fetchedAt: row.fetched_at, ...(row.noted_at ? { notedAt: row.noted_at } : {}),
  });
}

function links(raw: string): { title: string; url: string }[] {
  return parsed<unknown[]>(raw, []).flatMap(item => {
    const link = item as { title?: unknown; url?: unknown };
    return typeof link?.title === 'string' && typeof link?.url === 'string' ? [{ title: link.title, url: link.url }] : [];
  });
}

function parsed<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
