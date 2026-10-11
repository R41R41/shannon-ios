import type { DatabaseSync } from 'node:sqlite';

/**
 * The record of retained resources (Syzygy ADR-0009 §9, stage 1). When an unknown action's slot is released, the keys the
 * retention policy names at that moment are written here; only a recorded key keeps excluding others. So a row released
 * before this record existed stays free, and a policy change never re-blocks an earlier release.
 *
 * A record ends with a release proof: the domain's proof (`reconcileResource`), the settled original task (the sweep), the
 * owner's explicit release, or the action closing. Every end of a record is audited (who or what, when, which keys).
 */
export interface RetainedRelease {
  requestId: string;
  scopeKey: string;
  actionId: string;
  releasedBy: string;
  reason: 'domain_proof' | 'task_settled' | 'owner_release' | 'action_closed';
  at: string;
}

export function ensureRetainedResourceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mind_action_retained_resources (
      action_id TEXT NOT NULL, resource TEXT NOT NULL, retained_at TEXT NOT NULL, PRIMARY KEY (action_id, resource)
    );
    CREATE TABLE IF NOT EXISTS mind_action_retained_releases (
      request_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, action_id TEXT NOT NULL, released_by TEXT NOT NULL,
      reason TEXT NOT NULL, resources_json TEXT NOT NULL, released_at TEXT NOT NULL
    );
  `);
}

export function recordRetained(db: DatabaseSync, actionId: string, resources: readonly string[], at: string): void {
  const insert = db.prepare('INSERT OR IGNORE INTO mind_action_retained_resources(action_id, resource, retained_at) VALUES (?, ?, ?)');
  for (const resource of resources) insert.run(actionId, resource, at);
}

export function retainedOf(db: DatabaseSync, actionId: string): Set<string> {
  const rows = db.prepare('SELECT resource FROM mind_action_retained_resources WHERE action_id = ?').all(actionId);
  return new Set(rows.map(row => String(row.resource)));
}

/** The actions that hold a retained record, oldest first. */
export function retainedActionIds(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT action_id, MIN(retained_at) AS since FROM mind_action_retained_resources
    GROUP BY action_id ORDER BY since, action_id`).all();
  return rows.map(row => String(row.action_id));
}

/** Ends the record of some (or all) of an action's retained keys, with one audit row. Returns the keys it released. */
export function releaseRetained(db: DatabaseSync, release: RetainedRelease, only?: readonly string[]): string[] {
  const held = [...retainedOf(db, release.actionId)].filter(key => !only || only.includes(key)).sort();
  if (!held.length) return [];
  const remove = db.prepare('DELETE FROM mind_action_retained_resources WHERE action_id = ? AND resource = ?');
  for (const key of held) remove.run(release.actionId, key);
  db.prepare(`INSERT INTO mind_action_retained_releases
    (request_id, scope_key, action_id, released_by, reason, resources_json, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(release.requestId, release.scopeKey, release.actionId, release.releasedBy, release.reason, JSON.stringify(held), release.at);
  return held;
}

/** The audit row of an owner's release request, for an idempotent retry. */
export function knownRelease(db: DatabaseSync, requestId: string): { scopeKey: string; actionId: string; count: number } | null {
  const row = db.prepare('SELECT scope_key, action_id, resources_json FROM mind_action_retained_releases WHERE request_id = ?').get(requestId);
  if (!row) return null;
  const keys = JSON.parse(String(row.resources_json)) as string[];
  return { scopeKey: String(row.scope_key), actionId: String(row.action_id), count: keys.length };
}

/** How many retained keys are recorded and since when the oldest (`GET /v1/ops`). */
export function retainedSummary(db: DatabaseSync): { held: number; oldestAt: string | null } {
  const row = db.prepare('SELECT COUNT(*) AS held, MIN(retained_at) AS oldest FROM mind_action_retained_resources').get();
  return { held: Number(row?.held ?? 0), oldestAt: typeof row?.oldest === 'string' ? row.oldest : null };
}
