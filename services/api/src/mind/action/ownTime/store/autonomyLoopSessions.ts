import type { DatabaseSync } from 'node:sqlite';

/**
 * Sessions of her own activity (owner decision 2026-10-02, Syzygy ADR-0003: she paces her own day).
 *
 * A session is one row beside its cycle in `autonomy_loop_cycles`: when it began, how long it stood
 * still for the owner, and, once it is over, why it ended, when she comes back, and the reason she
 * gave in her own words. What a session spent is not kept here: it is the sum of the spend rows of
 * the steps it journalled, so a restart cannot count a step twice or lose one.
 */
export const SESSION_END_CODES = ['rest', 'session_budget', 'session_time', 'session_steps', 'budget', 'no_plan', 'idle', 'action_unknown'] as const;
/**
 * `rest`: she chose to. Every other code is a bound that stopped her. `idle` is a `no_plan` end of a session that did
 * nothing but think: it is not counted among the sessions of its day, and a second one in a row is followed by the long rest.
 * `action_unknown`: the session's own action stayed unknown past the release deadline; it ends without replaying anything.
 */
export type SessionEndCode = typeof SESSION_END_CODES[number];
export const AUTONOMY_REST_REASON_MAXIMUM_CHARACTERS = 120;

export interface AutonomySession {
  cycleId: string;
  scopeKey: string;
  dayKey: string;
  startedAt: string;
  /** Since when it stands still: the owner is talking, or has paused her. */
  heldAt?: string;
  /** How long it has stood still in all, not counting a hold that is still open. */
  heldMilliseconds: number;
  endedAt?: string;
  endCode?: SessionEndCode;
  /** When the next session may begin. */
  resumeAt?: string;
  /** Why she rests, in her own words. */
  restReason?: string;
}

interface SessionRow {
  cycle_id: string; scope_key: string; day_key: string; started_at: string; held_at: string | null; held_ms: number;
  ended_at: string | null; end_code: string | null; resume_at: string | null; rest_reason: string | null;
}

export class AutonomyLoopSessions {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_loop_sessions (
        cycle_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        held_at TEXT,
        held_ms INTEGER NOT NULL DEFAULT 0,
        ended_at TEXT,
        end_code TEXT,
        resume_at TEXT,
        rest_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS autonomy_loop_sessions_scope ON autonomy_loop_sessions (scope_key, started_at DESC);
    `);
  }

  open(cycle: { id: string; scopeKey: string; dayKey: string; startedAt: string }): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO autonomy_loop_sessions (cycle_id, scope_key, day_key, started_at) VALUES (?, ?, ?, ?)
    `).run(cycle.id, cycle.scopeKey, cycle.dayKey, cycle.startedAt);
  }

  get(cycleId: string): AutonomySession | null {
    const row = this.database.prepare('SELECT * FROM autonomy_loop_sessions WHERE cycle_id = ?').get(cycleId) as unknown as SessionRow | undefined;
    return row ? session(row) : null;
  }

  /** The session stands still from now on; a hold that is already open keeps its start. */
  hold(cycleId: string, at: string): void {
    this.database.prepare(`
      UPDATE autonomy_loop_sessions SET held_at = ? WHERE cycle_id = ? AND held_at IS NULL AND ended_at IS NULL
    `).run(at, cycleId);
  }

  /** The session goes on: the time it stood still is added up and no longer counts against its clock. */
  release(cycleId: string, at: string): void {
    const row = this.get(cycleId);
    if (!row?.heldAt) return;
    const stood = Math.max(0, Date.parse(at) - Date.parse(row.heldAt));
    this.database.prepare(`
      UPDATE autonomy_loop_sessions SET held_at = NULL, held_ms = held_ms + ? WHERE cycle_id = ? AND held_at IS NOT NULL
    `).run(Number.isFinite(stood) ? Math.trunc(stood) : 0, cycleId);
  }

  /** Closes a session once. Returns false when it was already closed. */
  close(cycleId: string, input: { at: string; code: SessionEndCode; resumeAt: string; reason?: string }): boolean {
    const reason = input.reason?.replace(/\s+/gu, ' ').trim().slice(0, AUTONOMY_REST_REASON_MAXIMUM_CHARACTERS);
    const result = this.database.prepare(`
      UPDATE autonomy_loop_sessions SET ended_at = ?, end_code = ?, resume_at = ?, rest_reason = ?, held_at = NULL
      WHERE cycle_id = ? AND ended_at IS NULL
    `).run(input.at, input.code, input.resumeAt, reason || null, cycleId);
    return Number(result.changes) > 0;
  }

  /** The session that ended last. */
  latestClosed(scopeKey: string): AutonomySession | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_loop_sessions WHERE scope_key = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1
    `).get(scopeKey) as unknown as SessionRow | undefined;
    return row ? session(row) : null;
  }

  /** Sessions begun on the owner-local day, not counting those that ended without doing anything but think. */
  startedOn(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM autonomy_loop_sessions WHERE scope_key = ? AND day_key = ? AND COALESCE(end_code, '') <> 'idle'
    `).get(scopeKey, dayKey) as unknown as { count: number };
    return Number(row.count);
  }

  /** What the steps of one session have been charged so far, in yen: recorded actuals, and estimates for steps a stopped process left open. */
  spentYen(cycleId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(spend.cost_yen), 0) AS cost FROM autonomy_spend AS spend
      WHERE spend.activity_id IN (SELECT decision_id FROM autonomy_loop_steps WHERE cycle_id = ? AND decision_id IS NOT NULL)
    `).get(cycleId) as unknown as { cost: number };
    return Math.round(Number(row.cost) * 100) / 100;
  }

  /** What a step of each tool has cost on average since an instant, from the spend she was actually charged. */
  typicalCosts(scopeKey: string, since: string): ReadonlyMap<string, { yen: number; count: number }> {
    const rows = this.database.prepare(`
      SELECT decision.tool AS tool, AVG(spend.cost_yen) AS yen, COUNT(*) AS count
      FROM autonomy_spend AS spend JOIN autonomy_activity AS decision ON decision.activity_id = spend.activity_id
      WHERE spend.scope_key = ? AND spend.occurred_at >= ? AND decision.tool IS NOT NULL GROUP BY decision.tool
    `).all(scopeKey, since) as unknown as Array<{ tool: string; yen: number; count: number }>;
    return new Map(rows.map(row => [row.tool, { yen: Number(row.yen), count: Number(row.count) }]));
  }
}

function session(row: SessionRow): AutonomySession {
  const code = SESSION_END_CODES.find(item => item === row.end_code);
  return Object.freeze({
    cycleId: row.cycle_id, scopeKey: row.scope_key, dayKey: row.day_key, startedAt: row.started_at,
    ...(row.held_at ? { heldAt: row.held_at } : {}), heldMilliseconds: Math.max(0, Number(row.held_ms) || 0),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}), ...(code ? { endCode: code } : {}),
    ...(row.resume_at ? { resumeAt: row.resume_at } : {}), ...(row.rest_reason ? { restReason: row.rest_reason } : {}),
  });
}

/** How long a session has been running, not counting the time it stood still. */
export function sessionElapsedMilliseconds(row: Pick<AutonomySession, 'startedAt' | 'heldAt' | 'heldMilliseconds'>, at: string): number {
  const open = row.heldAt ? Math.max(0, Date.parse(at) - Date.parse(row.heldAt)) : 0;
  return Math.max(0, Date.parse(at) - Date.parse(row.startedAt) - row.heldMilliseconds - open);
}
