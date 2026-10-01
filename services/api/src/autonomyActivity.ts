import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { autonomyDomainLabel } from '@shannon/cognition';
import { roundYen } from './autonomyBudget.js';

/**
 * The activity record (「したことの記録」): an append-only log of every autonomous
 * decision and action, and of what the owner did to the switches around them.
 *
 * It is core. This module exposes `append` and reads; there is no update or delete,
 * and the table refuses both with triggers, so no code path Shannon can edit, and
 * no other writer on the same database, can rewrite or remove an entry.
 */
export type AutonomyActivityKind = 'decision' | 'action' | 'control' | 'budget' | 'pursuit' | 'proposal' | 'model';
export type AutonomyActivityOutcome =
  | 'allowed' | 'needs_approval' | 'refused' | 'done' | 'failed'
  | 'paused' | 'resumed' | 'requested' | 'approved' | 'declined' | 'recorded';
export type AutonomyApprovalState = 'not_needed' | 'needed' | 'approved' | 'declined';

export interface AutonomyActivityDraft {
  kind: AutonomyActivityKind;
  /** Who did it: Shannon's own activity, or the owner acting on the switches. */
  actor: 'shannon' | 'owner';
  /** One plain Japanese sentence. */
  summary: string;
  detail?: string;
  domain: string;
  model?: string;
  tool?: string;
  costYen?: number;
  outcome: AutonomyActivityOutcome;
  /** What it produced: a note, a draft, a proposal. */
  link?: string;
  approval: AutonomyApprovalState;
  reasonCode?: string;
  /** The entry this one follows, such as the decision an action was allowed by. */
  relatedId?: string;
}

export interface AutonomyActivityEntry extends AutonomyActivityDraft {
  id: string;
  sequence: number;
  occurredAt: string;
  dayKey: string;
  domainLabel: string;
  costYen: number;
}

export interface AutonomyActivityDay {
  dayKey: string;
  /** One line, computed without a model. */
  summary: string;
  counts: { done: number; needsApproval: number; refused: number; failed: number };
  costYen: number;
  entries: readonly AutonomyActivityEntry[];
}

interface ActivityRow {
  sequence: number; activity_id: string; occurred_at: string; day_key: string; kind: string; actor: string;
  summary: string; detail: string | null; domain: string; model: string | null; tool: string | null;
  cost_yen: number; outcome: string; link: string | null; approval: string; reason_code: string | null; related_id: string | null;
}

export function ensureAutonomyActivitySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS autonomy_activity (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id TEXT NOT NULL UNIQUE,
      scope_key TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      day_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('shannon', 'owner')),
      summary TEXT NOT NULL,
      detail TEXT,
      domain TEXT NOT NULL,
      model TEXT,
      tool TEXT,
      cost_yen REAL NOT NULL DEFAULT 0 CHECK (cost_yen >= 0),
      outcome TEXT NOT NULL,
      link TEXT,
      approval TEXT NOT NULL CHECK (approval IN ('not_needed', 'needed', 'approved', 'declined')),
      reason_code TEXT,
      related_id TEXT
    );
    CREATE INDEX IF NOT EXISTS autonomy_activity_scope_day ON autonomy_activity (scope_key, day_key, sequence);
    CREATE TRIGGER IF NOT EXISTS autonomy_activity_no_update BEFORE UPDATE ON autonomy_activity
      BEGIN SELECT RAISE(ABORT, 'AUTONOMY_ACTIVITY_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS autonomy_activity_no_delete BEFORE DELETE ON autonomy_activity
      BEGIN SELECT RAISE(ABORT, 'AUTONOMY_ACTIVITY_APPEND_ONLY'); END;
    -- INSERT OR REPLACE removes the old row without firing the delete trigger, so it is refused here.
    CREATE TRIGGER IF NOT EXISTS autonomy_activity_no_replace BEFORE INSERT ON autonomy_activity
      WHEN EXISTS (SELECT 1 FROM autonomy_activity WHERE sequence = NEW.sequence OR activity_id = NEW.activity_id)
      BEGIN SELECT RAISE(ABORT, 'AUTONOMY_ACTIVITY_APPEND_ONLY'); END;
  `);
}

export class AutonomyActivityRecord {
  constructor(private readonly database: DatabaseSync) {
    ensureAutonomyActivitySchema(database);
  }

  append(scopeKey: string, dayKey: string, occurredAt: string, draft: AutonomyActivityDraft): AutonomyActivityEntry {
    const id = randomUUID();
    const costYen = roundYen(Math.max(0, Number.isFinite(draft.costYen) ? draft.costYen! : 0));
    this.database.prepare(`
      INSERT INTO autonomy_activity
        (activity_id, scope_key, occurred_at, day_key, kind, actor, summary, detail, domain, model, tool,
         cost_yen, outcome, link, approval, reason_code, related_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, scopeKey, occurredAt, dayKey, draft.kind, draft.actor, bounded(draft.summary, 300),
      draft.detail ? bounded(draft.detail, 600) : null, bounded(draft.domain, 60),
      draft.model ? bounded(draft.model, 120) : null, draft.tool ? bounded(draft.tool, 120) : null,
      costYen, draft.outcome, draft.link ? bounded(draft.link, 500) : null, draft.approval,
      draft.reasonCode ?? null, draft.relatedId ?? null,
    );
    return this.get(scopeKey, id)!;
  }

  get(scopeKey: string, id: string): AutonomyActivityEntry | null {
    const row = this.database.prepare(`
      SELECT * FROM autonomy_activity WHERE scope_key = ? AND activity_id = ?
    `).get(scopeKey, id) as unknown as ActivityRow | undefined;
    return row ? entry(row) : null;
  }

  /** Newest day first, newest entry first inside a day. */
  days(scopeKey: string, options: { sinceDayKey?: string; limit?: number } = {}): readonly AutonomyActivityDay[] {
    const limit = Math.max(1, Math.min(1_000, Math.trunc(options.limit ?? 400)));
    const rows = this.database.prepare(`
      SELECT * FROM autonomy_activity
      WHERE scope_key = ? AND day_key >= ?
      ORDER BY sequence DESC LIMIT ?
    `).all(scopeKey, options.sinceDayKey ?? '', limit) as unknown as ActivityRow[];
    const byDay = new Map<string, AutonomyActivityEntry[]>();
    for (const row of rows) byDay.set(row.day_key, [...(byDay.get(row.day_key) ?? []), entry(row)]);
    return Object.freeze([...byDay.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([dayKey, entries]) => summarizeAutonomyDay(dayKey, entries)));
  }

  /** How many entries follow the given one, such as the action recorded for a decision. */
  followUps(scopeKey: string, relatedId: string, kind: AutonomyActivityKind): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM autonomy_activity WHERE scope_key = ? AND related_id = ? AND kind = ?
    `).get(scopeKey, relatedId, kind) as unknown as { count: number };
    return Number(row.count);
  }

  countForDay(scopeKey: string, dayKey: string, domain: string, outcome: AutonomyActivityOutcome): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM autonomy_activity
      WHERE scope_key = ? AND day_key = ? AND domain = ? AND outcome = ? AND kind = 'decision'
    `).get(scopeKey, dayKey, domain, outcome) as unknown as { count: number };
    return Number(row.count);
  }
}

/** The one-line daily summary, from counts only. */
export function summarizeAutonomyDay(dayKey: string, entries: readonly AutonomyActivityEntry[]): AutonomyActivityDay {
  const count = (predicate: (entry: AutonomyActivityEntry) => boolean) => entries.filter(predicate).length;
  const counts = {
    done: count(item => item.kind === 'action' && item.outcome === 'done'),
    needsApproval: count(item => item.outcome === 'needs_approval'),
    refused: count(item => item.outcome === 'refused'),
    failed: count(item => item.outcome === 'failed'),
  };
  const costYen = roundYen(entries.reduce((total, item) => total + item.costYen, 0));
  const ownerActions = count(item => item.actor === 'owner');
  const parts = [
    counts.done ? `したこと${counts.done}件` : '',
    counts.needsApproval ? `承認が必要${counts.needsApproval}件` : '',
    counts.refused ? `止めたこと${counts.refused}件` : '',
    counts.failed ? `うまくいかなかったこと${counts.failed}件` : '',
    ownerActions ? `所有者の操作${ownerActions}件` : '',
  ].filter(Boolean);
  const summary = `${parts.length ? parts.join('、') : `記録${entries.length}件`}。使った費用は${formatYen(costYen)}です。`;
  return Object.freeze({ dayKey, summary, counts, costYen, entries: Object.freeze([...entries]) });
}

export function formatYen(value: number): string {
  const rounded = roundYen(value);
  return `${Number.isInteger(rounded) ? rounded.toLocaleString('en-US') : rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}円`;
}

function entry(row: ActivityRow): AutonomyActivityEntry {
  return Object.freeze({
    id: row.activity_id,
    sequence: Number(row.sequence),
    occurredAt: row.occurred_at,
    dayKey: row.day_key,
    kind: row.kind as AutonomyActivityKind,
    actor: row.actor as 'shannon' | 'owner',
    summary: row.summary,
    ...(row.detail ? { detail: row.detail } : {}),
    domain: row.domain,
    domainLabel: autonomyDomainLabel(row.domain),
    ...(row.model ? { model: row.model } : {}),
    ...(row.tool ? { tool: row.tool } : {}),
    costYen: Number(row.cost_yen),
    outcome: row.outcome as AutonomyActivityOutcome,
    ...(row.link ? { link: row.link } : {}),
    approval: row.approval as AutonomyApprovalState,
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    ...(row.related_id ? { relatedId: row.related_id } : {}),
  });
}

function bounded(value: string, maximum: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}
