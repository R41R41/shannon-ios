/** Her pursuits, kept in her own time's database (Syzygy ADR-0008 stage 3, S2: the ledger of `mind/self/autonomyPursuits.ts`, moved unchanged beside the store that opens it; the rules of a pursuit stay in the self part). */
import type { DatabaseSync } from 'node:sqlite';
import { SHANNON_PURSUIT_LIMITS, SHANNON_SEED_PURSUITS, type ShannonPursuit, type ShannonPursuitKind, type ShannonPursuitLink, type ShannonPursuitOrigin, type ShannonPursuitStatus } from '@shannon/cognition';
import { normalizedDraft, normalizedLinks, type PursuitDraft, type PursuitRejection, STATUSES, pursuitText as text, titleKey } from '../../../self/selfPorts.js';
import { randomUUID } from 'node:crypto';
import { GOAL_LIMITS } from '@shannon/mind';
import { ensurePursuitGoalSchema, migratePursuitGoals, type PursuitGoalMigrationReport } from './pursuitGoalMigration.js';
import { PursuitGoalLedger, atomically } from './pursuitGoals.js';

interface PursuitRow {
  pursuit_id: string; kind: string; title: string; why: string; status: string; origin: string;
  links_json: string; created_at: string; updated_at: string;
}

export class AutonomyPursuitLedger {
  /** The goal side of each pursuit (Syzygy ADR-0009 stage 2, E2): lifecycle columns, events, evidence and the owner's confirmation. */
  private readonly goalLedger: PursuitGoalLedger;
  private goalSchema = false;

  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_pursuits (
        scope_key TEXT NOT NULL,
        pursuit_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('goal', 'question', 'work')),
        title TEXT NOT NULL,
        why TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'resting', 'done', 'dropped')),
        origin TEXT NOT NULL CHECK (origin IN ('seed', 'conversation', 'self')),
        links_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, pursuit_id)
      );
      CREATE TRIGGER IF NOT EXISTS autonomy_pursuits_seed_no_update BEFORE UPDATE ON autonomy_pursuits
        WHEN OLD.origin = 'seed' BEGIN SELECT RAISE(ABORT, 'PURSUIT_SEED_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS autonomy_pursuits_seed_no_delete BEFORE DELETE ON autonomy_pursuits
        WHEN OLD.origin = 'seed' BEGIN SELECT RAISE(ABORT, 'PURSUIT_SEED_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS autonomy_pursuits_no_seed_promotion BEFORE UPDATE ON autonomy_pursuits
        WHEN NEW.origin = 'seed' AND OLD.origin <> 'seed' BEGIN SELECT RAISE(ABORT, 'PURSUIT_SEED_IMMUTABLE'); END;
    `);
    this.goalLedger = new PursuitGoalLedger(database);
  }

  /**
   * The goal side, its schema made on first use: a database whose pursuits were never more than the seeds keeps the table as
   * it was (the stage-3 byte proofs of afb38c28 open such a database).
   */
  get goals(): PursuitGoalLedger {
    if (!this.goalSchema) {
      ensurePursuitGoalSchema(this.database);
      this.goalSchema = true;
    }
    return this.goalLedger;
  }

  /**
   * The one-time migration of existing pursuits to goals (`pursuitGoalMigration.ts`), run once the study's tables exist; with
   * nothing but seeds there is nothing to migrate and nothing is created (null).
   */
  migrateGoals(at: string): PursuitGoalMigrationReport | null {
    const own = this.database.prepare(`SELECT 1 FROM autonomy_pursuits WHERE origin <> 'seed' LIMIT 1`).get();
    if (!own && !this.goalSchema) return null;
    return migratePursuitGoals(this.goals && this.database, at);
  }

  /** Seeds first, then the rest by most recent change. */
  list(scopeKey: string, at: string): readonly ShannonPursuit[] {
    this.ensureSeeds(scopeKey, at);
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_pursuits WHERE scope_key = ?
      ORDER BY CASE origin WHEN 'seed' THEN 0 ELSE 1 END, updated_at DESC, pursuit_id LIMIT 200
    `).all(scopeKey) as unknown as PursuitRow[];
    const seedOrder = new Map<string, number>(SHANNON_SEED_PURSUITS.map((seed, index) => [seed.id, index]));
    return Object.freeze(rows.flatMap(row => pursuit(row) ?? []).sort((left, right) =>
      (seedOrder.get(left.id) ?? 99) - (seedOrder.get(right.id) ?? 99)));
  }

  get(scopeKey: string, id: string): ShannonPursuit | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_pursuits WHERE scope_key = ? AND pursuit_id = ?
    `).get(scopeKey, id) as unknown as PursuitRow | undefined;
    return row ? pursuit(row) : null;
  }

  add(scopeKey: string, draft: PursuitDraft, at: string): ShannonPursuit | PursuitRejection {
    this.ensureSeeds(scopeKey, at);
    const normalized = normalizedDraft(draft);
    if (!normalized) return 'PURSUIT_INVALID';
    const existing = this.list(scopeKey, at);
    const key = titleKey(normalized.title);
    if (existing.some(item => (item.status === 'active' || item.status === 'resting') && titleKey(item.title) === key)) {
      return 'PURSUIT_DUPLICATE';
    }
    const open = existing.filter(item => item.origin !== 'seed' && (item.status === 'active' || item.status === 'resting'));
    // Eight are active at once (the rest rest); the open ceiling leaves room beyond the legacy goals (ADR-0009 stage 2, E2).
    if (open.length >= GOAL_LIMITS.open) return 'PURSUIT_LIMIT';
    const id = randomUUID();
    const goals = this.goals;
    migratePursuitGoals(this.database, at);
    atomically(this.database, () => {
      this.database.prepare(`
        INSERT INTO autonomy_pursuits
          (scope_key, pursuit_id, kind, title, why, status, origin, links_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(scopeKey, id, normalized.kind, normalized.title, normalized.why, normalized.origin, JSON.stringify(normalized.links), at, at);
      goals.created(scopeKey, id, normalized.origin, at);
    });
    return this.get(scopeKey, id)!;
  }

  /**
   * Changes status, reason, or links of a non-seed entry. A dropped entry stays dropped. `done` is never set here (E2): asked
   * for, it is recorded as her proposal and the status stays; only evidence or the owner closes a goal (`goals`).
   */
  update(
    scopeKey: string,
    id: string,
    change: { status?: ShannonPursuitStatus; why?: string; links?: readonly ShannonPursuitLink[] },
    at: string,
    actor: 'shannon' | 'owner' = 'shannon',
  ): ShannonPursuit | PursuitRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'PURSUIT_NOT_FOUND';
    if (current.origin === 'seed') return 'PURSUIT_SEED_IMMUTABLE';
    if (current.status === 'dropped') return 'PURSUIT_CLOSED';
    if (change.status !== undefined && !STATUSES.includes(change.status)) return 'PURSUIT_INVALID';
    const why = change.why === undefined ? current.why : text(change.why, SHANNON_PURSUIT_LIMITS.why);
    const links = change.links === undefined ? current.links : normalizedLinks(change.links);
    if (!why || !links) return 'PURSUIT_INVALID';
    // Her "done" is a proposal: the goal rests until evidence or the owner closes it, so the old loop stops working on it (and asking again).
    const proposing = change.status === 'done' && current.status !== 'done';
    const status = change.status === undefined ? current.status : proposing ? 'resting' : change.status;
    const goals = this.goals;
    migratePursuitGoals(this.database, at);
    atomically(this.database, () => {
      this.database.prepare(`
        UPDATE autonomy_pursuits SET status = ?, why = ?, links_json = ?, updated_at = ?
        WHERE scope_key = ? AND pursuit_id = ?
      `).run(status, why, JSON.stringify(links), at, scopeKey, id);
      const already = proposing && goals.columns(scopeKey).get(id)?.closedReason === 'proposed_complete';
      if (proposing && !already) goals.proposedComplete(scopeKey, id, current.status, at);
      const moved = { from: current.status, to: status, actor, ...(proposing ? { proposed: true } : {}) };
      if (status !== current.status) goals.statusChanged(scopeKey, id, moved, at);
    });
    return this.get(scopeKey, id)!;
  }

  private ensureSeeds(scopeKey: string, at: string): void {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO autonomy_pursuits
        (scope_key, pursuit_id, kind, title, why, status, origin, links_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'seed', '[]', ?, ?)
    `);
    for (const seed of SHANNON_SEED_PURSUITS) insert.run(scopeKey, seed.id, seed.kind, seed.title, seed.why, at, at);
  }
}

/** A seed row is shown with the text of the current code, so the stored copy can never drift from the decision. */
function pursuit(row: PursuitRow): ShannonPursuit | null {
  const seed = row.origin === 'seed' ? SHANNON_SEED_PURSUITS.find(item => item.id === row.pursuit_id) : undefined;
  if (row.origin === 'seed' && !seed) return null;
  let links: ShannonPursuitLink[] = [];
  try {
    const parsed: unknown = JSON.parse(row.links_json);
    if (Array.isArray(parsed)) links = normalizedLinks(parsed as ShannonPursuitLink[]) ?? [];
  } catch { /* an unreadable link list shows as no links */ }
  return Object.freeze({
    id: row.pursuit_id,
    kind: seed?.kind ?? row.kind as ShannonPursuitKind,
    title: seed?.title ?? row.title,
    why: seed?.why ?? row.why,
    status: row.status as ShannonPursuitStatus,
    origin: row.origin as ShannonPursuitOrigin,
    links: Object.freeze(links),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
