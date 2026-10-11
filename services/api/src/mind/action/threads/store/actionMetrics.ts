import type { DatabaseSync } from 'node:sqlite';

/**
 * What `GET /v1/ops` counts of the action threads (Syzygy ADR-0009 stage 1, acceptance §4): closed counts only, read-only.
 * - `unknownSentOverdue`: unknown actions still holding their slot (sent) past the cutoff; the release should keep it at 0.
 * - `liveByKind`: running, waiting and stopping actions per kind.
 * - `sharedResources`: resource keys held by more than one live action at once (should be 0).
 * - `multiSegmentTasks`: FCA tasks with more than one live step action at once (should be 0).
 */
export interface ActionExecutionCounts {
  unknownSentOverdue: number;
  liveByKind: Readonly<Record<string, number>>;
  sharedResources: number;
  multiSegmentTasks: number;
}

const EMPTY: ActionExecutionCounts = Object.freeze({ unknownSentOverdue: 0, liveByKind: Object.freeze({}), sharedResources: 0, multiSegmentTasks: 0 });
const LIVE = "state IN ('running','waiting','stopping')";
const FCA_SOURCE = /^fca:([^:]+):[0-9]+$/u;

function hasActions(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'mind_actions'").get());
}

function liveByKind(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare(`SELECT kind, COUNT(*) AS count FROM mind_actions WHERE ${LIVE} GROUP BY kind ORDER BY kind`).all();
  return Object.fromEntries(rows.map(row => [String(row.kind), Number(row.count)]));
}

function sharedResources(db: DatabaseSync): number {
  const rows = db.prepare(`SELECT resources_json FROM mind_actions WHERE ${LIVE} OR (state = 'unknown' AND sent = 1)`).all();
  const holders = new Map<string, number>();
  for (const row of rows) {
    const keys = new Set(JSON.parse(String(row.resources_json)) as string[]);
    for (const key of keys) holders.set(key, (holders.get(key) ?? 0) + 1);
  }
  return [...holders.values()].filter(count => count > 1).length;
}

function multiSegmentTasks(db: DatabaseSync): number {
  const rows = db.prepare(`SELECT source_id FROM mind_actions WHERE kind = 'agentTask' AND ${LIVE}`).all();
  const segments = new Map<string, number>();
  for (const row of rows) {
    const task = FCA_SOURCE.exec(String(row.source_id))?.[1];
    if (task) segments.set(task, (segments.get(task) ?? 0) + 1);
  }
  return [...segments.values()].filter(count => count > 1).length;
}

export function readActionExecutionCounts(db: DatabaseSync, cutoff: string): ActionExecutionCounts {
  if (!hasActions(db)) return EMPTY;
  const overdue = db.prepare("SELECT COUNT(*) AS count FROM mind_actions WHERE state = 'unknown' AND sent = 1 AND updated_at <= ?").get(cutoff);
  return {
    unknownSentOverdue: Number(overdue?.count ?? 0),
    liveByKind: liveByKind(db),
    sharedResources: sharedResources(db),
    multiSegmentTasks: multiSegmentTasks(db),
  };
}
