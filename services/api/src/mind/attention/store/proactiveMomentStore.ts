import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infra/sqlite/sqliteOpen.js';
import { ensureProactiveMomentsSchema } from './proactiveMomentMigrations.js';
import { momentFresh, type ProactiveMoment, type ProactiveMomentKind } from '../proactiveMoments.js';

/**
 * `proactive_moments` (owner decision 2026-10-14, `proactiveMoments.ts`): each moment she perceived, once per key, and what became
 * of it: still `perceived`, `wanted` (she would say something, or, decided by `writer`, she decides herself when she writes; her
 * own time's reach-out writes it or stays quiet), `quiet` (she would rather stay
 * quiet), `taken` (her reach-out step took it), `skipped` (a cap) or `expired`. Closed values only, never a word. Additive; created
 * by her own time's worker, which alone reads and writes it. Kept 30 days.
 */
export const PROACTIVE_MOMENTS_KEEP_DAYS = 30;

export type ProactiveMomentStatus = 'perceived' | 'wanted' | 'quiet' | 'taken' | 'skipped' | 'expired';

export interface StoredProactiveMoment extends ProactiveMoment {
  scopeKey: string;
  audience: 'owner' | 'others';
  perceivedAt: string;
  status: ProactiveMomentStatus;
  decider: 'jev' | 'writer' | null;
  reason: string | null;
}

export interface ProactiveMomentDecision {
  status: 'wanted' | 'quiet' | 'skipped';
  decider?: 'jev' | 'writer';
  reason?: string;
  costUsd?: number;
}

interface Row {
  scope_key: string; moment_key: string; kind: string; minutes: number | null; audience: string; perceived_at: string;
  status: string; decider: string | null; reason: string | null;
}

const DAY = 24 * 60 * 60_000;

function stored(row: Row): StoredProactiveMoment {
  return {
    scopeKey: row.scope_key, key: row.moment_key, kind: row.kind as ProactiveMomentKind, minutes: row.minutes === null ? null : Number(row.minutes),
    audience: row.audience === 'others' ? 'others' : 'owner', perceivedAt: row.perceived_at, status: row.status as ProactiveMomentStatus,
    decider: row.decider === 'jev' || row.decider === 'writer' ? row.decider : null, reason: row.reason,
  };
}

export class SQLiteProactiveMoments {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = openDatabase(path, 'outreach');
    ensureProactiveMomentsSchema(this.database);
  }

  /** Notes a moment once; true when it is new. */
  note(scopeKey: string, moment: ProactiveMoment, audience: 'owner' | 'others', at: string): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO proactive_moments (scope_key, moment_key, kind, minutes, audience, perceived_at, status) VALUES (?, ?, ?, ?, ?, ?, 'perceived')
    `).run(scopeKey, moment.key, moment.kind, moment.minutes, audience, at);
    return Number(result.changes) > 0;
  }

  /** The newest moment still waiting for a decision and still worth a word; older ones that are not are marked expired. */
  undecided(scopeKey: string, at: string): StoredProactiveMoment | null {
    this.expire(scopeKey, at);
    const row = this.database.prepare(`
      SELECT * FROM proactive_moments WHERE scope_key = ? AND status = 'perceived' ORDER BY perceived_at DESC, rowid DESC LIMIT 1
    `).get(scopeKey) as unknown as Row | undefined;
    return row ? stored(row) : null;
  }

  /** Records the decision on a moment that is still undecided; false when another runner decided first. */
  decide(scopeKey: string, key: string, input: ProactiveMomentDecision, at: string): boolean {
    const result = this.database.prepare(`
      UPDATE proactive_moments SET status = ?, decider = ?, reason = ?, cost_usd = cost_usd + ?, decided_at = ?
      WHERE scope_key = ? AND moment_key = ? AND status = 'perceived'
    `).run(input.status, input.decider ?? null, input.reason ?? null, input.costUsd ?? 0, at, scopeKey, key);
    return Number(result.changes) > 0;
  }

  /** Why a moment could not be decided yet (a closed code), kept on it while it waits. */
  waiting(scopeKey: string, key: string, reason: string): void {
    this.database.prepare(`UPDATE proactive_moments SET reason = ? WHERE scope_key = ? AND moment_key = ? AND status = 'perceived'`).run(reason, scopeKey, key);
  }

  /** Takes the newest moment she wanted to speak of, while it is still fresh; once. */
  take(scopeKey: string, at: string): StoredProactiveMoment | null {
    this.expire(scopeKey, at);
    const row = this.database.prepare(`
      SELECT * FROM proactive_moments WHERE scope_key = ? AND status = 'wanted' ORDER BY perceived_at DESC, rowid DESC LIMIT 1
    `).get(scopeKey) as unknown as Row | undefined;
    if (!row) return null;
    const taken = this.database.prepare(`
      UPDATE proactive_moments SET status = 'taken', decided_at = ? WHERE scope_key = ? AND moment_key = ? AND status = 'wanted'
    `).run(at, scopeKey, row.moment_key);
    return Number(taken.changes) > 0 ? { ...stored(row), status: 'taken' } : null;
  }

  /** One moment by its key. */
  get(scopeKey: string, key: string): StoredProactiveMoment | null {
    const row = this.database.prepare('SELECT * FROM proactive_moments WHERE scope_key = ? AND moment_key = ?')
      .get(scopeKey, key) as unknown as Row | undefined;
    return row ? stored(row) : null;
  }

  /** How many decisions were asked and how many moments were taken since `since`, and what the decisions cost. */
  usage(scopeKey: string, since: string): { decisions: number; taken: number; costUsd: number } {
    const row = this.database.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN decider IN ('jev', 'writer') THEN 1 ELSE 0 END), 0) AS decisions,
        COALESCE(SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END), 0) AS taken,
        COALESCE(SUM(cost_usd), 0) AS cost
      FROM proactive_moments WHERE scope_key = ? AND perceived_at >= ?
    `).get(scopeKey, since) as unknown as { decisions: number; taken: number; cost: number };
    return { decisions: Number(row.decisions), taken: Number(row.taken), costUsd: Number(row.cost) };
  }

  /** How many moments of this kind her loop took since `since` (spoken of or left in silence). */
  takenOfKindSince(scopeKey: string, kind: ProactiveMomentKind, since: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS taken FROM proactive_moments WHERE scope_key = ? AND kind = ? AND status = 'taken' AND perceived_at >= ?
    `).get(scopeKey, kind, since) as unknown as { taken: number };
    return Number(row.taken);
  }

  /** Moments that waited too long are only things that happened; rows older than 30 days are dropped. */
  private expire(scopeKey: string, at: string): void {
    const rows = this.database.prepare(`
      SELECT moment_key, kind, perceived_at FROM proactive_moments WHERE scope_key = ? AND status IN ('perceived', 'wanted')
    `).all(scopeKey) as unknown as Array<{ moment_key: string; kind: ProactiveMomentKind; perceived_at: string }>;
    const stale = rows.filter(row => !momentFresh(row.kind, row.perceived_at, at));
    const mark = this.database.prepare(`
      UPDATE proactive_moments SET status = 'expired', decided_at = ? WHERE scope_key = ? AND moment_key = ? AND status IN ('perceived', 'wanted')
    `);
    for (const row of stale) mark.run(at, scopeKey, row.moment_key);
    const oldest = new Date(Date.parse(at) - PROACTIVE_MOMENTS_KEEP_DAYS * DAY).toISOString();
    this.database.prepare('DELETE FROM proactive_moments WHERE perceived_at < ?').run(oldest);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
