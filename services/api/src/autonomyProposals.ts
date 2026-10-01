import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ShannonCoreAreaId } from '@shannon/cognition';

/**
 * Agent-task proposals that come from Shannon's own background activity
 * (origin = shannon). A proposal is only a record: it creates no agent task and
 * queues no command. The owner starts it, which goes through the existing
 * `AgentTaskStore.create` path, or declines it. Every change to core reaches the
 * owner this way.
 */
export type ShannonProposalStatus = 'proposed' | 'started' | 'declined';

export interface ShannonAgentTaskProposal {
  id: string;
  origin: 'shannon';
  title: string;
  goal: string;
  /** Why she wants it, in her own words. */
  reason: string;
  projectHint?: string;
  /** Core areas the change touches; empty when it needs approval for another reason. */
  coreAreas: readonly ShannonCoreAreaId[];
  status: ShannonProposalStatus;
  /** The agent task the owner started from it. */
  taskId?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface ShannonProposalDraft {
  title: string;
  goal: string;
  reason: string;
  projectHint?: string;
  coreAreas?: readonly ShannonCoreAreaId[];
}

interface ProposalRow {
  proposal_id: string; title: string; goal: string; reason: string; project_hint: string | null;
  core_areas_json: string; status: string; task_id: string | null; created_at: string; decided_at: string | null;
}

export const SHANNON_PROPOSAL_LIMITS = Object.freeze({ title: 160, goal: 2_000, reason: 600, open: 12 });

export class AutonomyProposalLedger {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_proposals (
        proposal_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        reason TEXT NOT NULL,
        project_hint TEXT,
        core_areas_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('proposed', 'started', 'declined')),
        task_id TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS autonomy_proposals_scope_status ON autonomy_proposals (scope_key, status, created_at DESC);
    `);
  }

  list(scopeKey: string, status?: ShannonProposalStatus): readonly ShannonAgentTaskProposal[] {
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_proposals WHERE scope_key = ? ORDER BY created_at DESC, proposal_id LIMIT 100
    `).all(scopeKey) as unknown as ProposalRow[];
    return Object.freeze(rows.map(proposal).filter(item => !status || item.status === status));
  }

  get(scopeKey: string, id: string): ShannonAgentTaskProposal | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_proposals WHERE scope_key = ? AND proposal_id = ?
    `).get(scopeKey, id) as unknown as ProposalRow | undefined;
    return row ? proposal(row) : null;
  }

  /** Returns null for an invalid draft or when too many proposals already wait for the owner. */
  create(scopeKey: string, draft: ShannonProposalDraft, at: string): ShannonAgentTaskProposal | null {
    const title = text(draft.title, SHANNON_PROPOSAL_LIMITS.title);
    const goal = text(draft.goal, SHANNON_PROPOSAL_LIMITS.goal);
    const reason = text(draft.reason, SHANNON_PROPOSAL_LIMITS.reason);
    const projectHint = draft.projectHint === undefined ? null : text(draft.projectHint, 160);
    if (!title || !goal || !reason || (draft.projectHint !== undefined && !projectHint)) return null;
    if (this.list(scopeKey, 'proposed').length >= SHANNON_PROPOSAL_LIMITS.open) return null;
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO autonomy_proposals
        (proposal_id, scope_key, title, goal, reason, project_hint, core_areas_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
    `).run(id, scopeKey, title, goal, reason, projectHint, JSON.stringify([...new Set(draft.coreAreas ?? [])]), at);
    return this.get(scopeKey, id);
  }

  /** Only a waiting proposal can be decided; a second decision returns null. */
  decide(scopeKey: string, id: string, status: 'started' | 'declined', at: string, taskId?: string): ShannonAgentTaskProposal | null {
    const result = this.database.prepare(`
      UPDATE autonomy_proposals SET status = ?, task_id = ?, decided_at = ?
      WHERE scope_key = ? AND proposal_id = ? AND status = 'proposed'
    `).run(status, taskId ?? null, at, scopeKey, id);
    return result.changes ? this.get(scopeKey, id) : null;
  }
}

function proposal(row: ProposalRow): ShannonAgentTaskProposal {
  let coreAreas: ShannonCoreAreaId[] = [];
  try {
    const parsed: unknown = JSON.parse(row.core_areas_json);
    if (Array.isArray(parsed)) coreAreas = parsed.filter((item): item is ShannonCoreAreaId => typeof item === 'string');
  } catch { /* shown without areas */ }
  return Object.freeze({
    id: row.proposal_id,
    origin: 'shannon' as const,
    title: row.title,
    goal: row.goal,
    reason: row.reason,
    ...(row.project_hint ? { projectHint: row.project_hint } : {}),
    coreAreas: Object.freeze(coreAreas),
    status: row.status as ShannonProposalStatus,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  });
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}
