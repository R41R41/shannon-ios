import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  SHANNON_PURSUIT_LIMITS,
  SHANNON_SEED_PURSUITS,
  type ShannonPursuit,
  type ShannonPursuitKind,
  type ShannonPursuitLink,
  type ShannonPursuitOrigin,
  type ShannonPursuitStatus,
} from '@shannon/cognition';

/**
 * Shannon's own pursuits ledger (「シャノンのやりたいこと」). It is separate from the
 * owner's intention ledger (`cognitive_intents`) and never written by owner goals.
 *
 * The seed entries are the goal and motive of ADR-0002. They are inserted once per
 * owner scope and the table refuses to change or remove them; changing a seed means
 * changing `SHANNON_SEED_PURSUITS`, which is core.
 */
export interface PursuitDraft {
  kind: ShannonPursuitKind;
  title: string;
  why: string;
  origin: Exclude<ShannonPursuitOrigin, 'seed'>;
  links?: readonly ShannonPursuitLink[];
}

export type PursuitRejection =
  | 'PURSUIT_INVALID' | 'PURSUIT_DUPLICATE' | 'PURSUIT_LIMIT' | 'PURSUIT_NOT_FOUND' | 'PURSUIT_SEED_IMMUTABLE' | 'PURSUIT_CLOSED';

interface PursuitRow {
  pursuit_id: string; kind: string; title: string; why: string; status: string; origin: string;
  links_json: string; created_at: string; updated_at: string;
}

const KINDS: readonly ShannonPursuitKind[] = ['goal', 'question', 'work'];
const STATUSES: readonly ShannonPursuitStatus[] = ['active', 'resting', 'done', 'dropped'];

export class AutonomyPursuitLedger {
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
    if (open.length >= SHANNON_PURSUIT_LIMITS.open) return 'PURSUIT_LIMIT';
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO autonomy_pursuits
        (scope_key, pursuit_id, kind, title, why, status, origin, links_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(scopeKey, id, normalized.kind, normalized.title, normalized.why, normalized.origin, JSON.stringify(normalized.links), at, at);
    return this.get(scopeKey, id)!;
  }

  /** Changes status, reason, or links of a non-seed entry. A dropped entry stays dropped. */
  update(
    scopeKey: string,
    id: string,
    change: { status?: ShannonPursuitStatus; why?: string; links?: readonly ShannonPursuitLink[] },
    at: string,
  ): ShannonPursuit | PursuitRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'PURSUIT_NOT_FOUND';
    if (current.origin === 'seed') return 'PURSUIT_SEED_IMMUTABLE';
    if (current.status === 'dropped') return 'PURSUIT_CLOSED';
    if (change.status !== undefined && !STATUSES.includes(change.status)) return 'PURSUIT_INVALID';
    const why = change.why === undefined ? current.why : text(change.why, SHANNON_PURSUIT_LIMITS.why);
    const links = change.links === undefined ? current.links : normalizedLinks(change.links);
    if (!why || !links) return 'PURSUIT_INVALID';
    this.database.prepare(`
      UPDATE autonomy_pursuits SET status = ?, why = ?, links_json = ?, updated_at = ?
      WHERE scope_key = ? AND pursuit_id = ?
    `).run(change.status ?? current.status, why, JSON.stringify(links), at, scopeKey, id);
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

function normalizedDraft(draft: PursuitDraft): Required<PursuitDraft> | null {
  if (!draft || typeof draft !== 'object') return null;
  if (!KINDS.includes(draft.kind) || (draft.origin !== 'conversation' && draft.origin !== 'self')) return null;
  const title = text(draft.title, SHANNON_PURSUIT_LIMITS.title);
  const why = text(draft.why, SHANNON_PURSUIT_LIMITS.why);
  const links = normalizedLinks(draft.links ?? []);
  if (!title || !why || !links) return null;
  return { kind: draft.kind, title, why, origin: draft.origin, links };
}

function normalizedLinks(links: readonly ShannonPursuitLink[]): ShannonPursuitLink[] | null {
  if (!Array.isArray(links) || links.length > SHANNON_PURSUIT_LIMITS.links) return null;
  const result: ShannonPursuitLink[] = [];
  for (const link of links) {
    const label = text(link?.label, SHANNON_PURSUIT_LIMITS.linkLabel);
    const url = typeof link?.url === 'string' ? link.url.trim() : '';
    if (!label || !url || url.length > SHANNON_PURSUIT_LIMITS.linkUrl || !/^(?:https:\/\/|aether:\/\/|voyager:\/\/)\S+$/u.test(url)) return null;
    result.push({ label, url });
  }
  return result;
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function titleKey(title: string): string {
  return title.toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]+/gu, '');
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
