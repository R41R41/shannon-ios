import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskSource } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import { applySchemaSteps } from './migrations/schemaSteps.js';
import { FCA_PROVENANCE_SETS_STEP } from './migrations/executionSteps.js';

/**
 * A step record's sources by reference (owner decision 2026-10-15, 「推奨の形で進める」; switch `SHANNON_FCA_PROVENANCE_REFS`).
 *
 * An evidence row (`fca_action_evidence.sources_json`) and a committed history row (`fca_task_history.sources_json`) held a copy of
 * the task's whole provenance (Minecraft runs 7–11: ~313 KB to ~2 MB a row, ~31 MB of a 71 MB database). The provenance itself is
 * already stored once, as rows of `fca_task_sources`; a memory row is written once and never changed, a conversation row is
 * changed only from `pending` to `bound` or `failed`, and nothing deletes either. So a record now keeps `{"set":"<id>"}`, and
 * `fca_provenance_sets` keeps, once per distinct list, the ordered step ids of those rows; the id is the sha256 of the scope and
 * the list (content-addressed: two records with the same sources share one set).
 *
 * Writing: a reference is written only when reading it back gives the very list being stored, field for field, and no row it
 * names is still `pending` (whose content could change). Otherwise the copy is written as before. An empty list stays `[]`.
 *
 * Reading: a copy (a JSON array, every row written before this change) is returned as written. A reference is resolved to its rows
 * as they are now (`taskSourceOfRow`, the same mapping as `TaskSourceStore.refs`), in their stored order, and only when the set
 * exists, is of this scope, and every row it names exists, is of this scope and is not `pending`; else null, which every caller
 * treats as not visible. Nothing is judged here: forgetting, corrections, withheld replies, read receipts and who can see or hear
 * are asked by the source guard at read time over the resolved list, exactly as over a copy.
 */
const REFERENCE = /^\{"set":"(sha256:[0-9a-f]{64})"\}$/u;
/** Resolved sets kept per connection: a set and the rows it names never change, so a resolved list stays true. */
const KEPT = 256;
const caches = new WeakMap<DatabaseSync, Map<string, readonly TaskSource[]>>();
const ready = new WeakSet<DatabaseSync>();

type SourceRow = Record<string, unknown>;

/** A row of `fca_task_sources` as a task's source (`TaskSourceStore.refs`); `pending` marks a turn still in progress the task runs on. */
export function taskSourceOfRow(row: SourceRow, pending: boolean): TaskSource {
  const base = row.source_kind === 'memory' ? { kind: 'memory' as const, threadId: null, experienceId: null }
    : { threadId: String(row.thread_id), experienceId: row.experience_id as string | null, ...(pending ? { pending: true as const } : {}) };
  return { ...base, stepId: String(row.step_id), observedAt: String(row.observed_at),
    recalledMemoryIds: JSON.parse(String(row.recalled_ids_json)) as string[],
    ...(row.read_ids_json !== '[]' ? { readSourceIds: JSON.parse(String(row.read_ids_json)) as string[] } : {}) } as TaskSource;
}

/** Makes the set table (step `execution/013_fca_provenance_sets`) where references are written: by the switch's owners only. */
export function enableFcaProvenanceSets(db: DatabaseSync): void {
  if (ready.has(db)) return;
  applySchemaSteps(db, [FCA_PROVENANCE_SETS_STEP]);
  ready.add(db);
}

/** Whether a stored `sources_json` is a reference (not a copy). */
export function isProvenanceReference(json: string): boolean {
  return REFERENCE.test(json);
}

/**
 * The `sources_json` to store for `sources` of `scopeKey`: a reference when `byReference` and the list can be read back exactly,
 * else the copy (`JSON.stringify(sources)`, as every row before). The caller holds the write transaction of the record.
 */
export function storedSourcesJson(db: DatabaseSync, scopeKey: string, sources: readonly TaskSource[], byReference: boolean): string {
  const copy = JSON.stringify(sources);
  if (!byReference || !sources.length) return copy;
  try {
    enableFcaProvenanceSets(db);
    const stepIds = sources.map(source => source.stepId);
    const setId = `sha256:${createHash('sha256').update(JSON.stringify([scopeKey, stepIds])).digest('hex')}`;
    const resolved = resolveRows(db, scopeKey, stepIds);
    if (!resolved || JSON.stringify(resolved) !== copy) return copy;
    const listed = JSON.stringify(stepIds);
    db.prepare('INSERT OR IGNORE INTO fca_provenance_sets(set_id,scope_key,step_ids_json,size,created_at) VALUES(?,?,?,?,?)')
      .run(setId, scopeKey, listed, stepIds.length, new Date().toISOString());
    const stored = db.prepare('SELECT scope_key,step_ids_json FROM fca_provenance_sets WHERE set_id=?').get(setId);
    if (stored?.scope_key !== scopeKey || stored.step_ids_json !== listed) return copy;
    return JSON.stringify({ set: setId });
  } catch {
    return copy;
  }
}

/**
 * The sources a stored `sources_json` names for `scopeKey`: a copy as written, a reference resolved now; null when it is neither
 * or the reference cannot be resolved (closed: not visible). A list handed back must not be changed by the caller.
 */
export function readStoredSources(db: DatabaseSync, scopeKey: string, json: string): readonly TaskSource[] | null {
  try {
    const reference = REFERENCE.exec(json);
    if (!reference) {
      const copy = JSON.parse(json) as unknown;
      return Array.isArray(copy) ? copy as TaskSource[] : null;
    }
    const setId = reference[1]!, known = caches.get(db)?.get(`${scopeKey}\u0000${setId}`);
    if (known) return known;
    const set = db.prepare('SELECT scope_key,step_ids_json FROM fca_provenance_sets WHERE set_id=?').get(setId);
    if (!set || set.scope_key !== scopeKey) return null;
    const stepIds = JSON.parse(String(set.step_ids_json)) as string[];
    const expected = `sha256:${createHash('sha256').update(JSON.stringify([scopeKey, stepIds])).digest('hex')}`;
    const resolved = expected === setId ? resolveRows(db, scopeKey, stepIds) : null;
    if (!resolved) return null;
    const frozen = Object.freeze(resolved);
    remember(db, `${scopeKey}\u0000${setId}`, frozen);
    return frozen;
  } catch {
    return null;
  }
}

/** As `readStoredSources`, for a reader that has no closed answer of its own: an unresolved reference stops it. */
export function requireStoredSources(db: DatabaseSync, scopeKey: string, json: string): readonly TaskSource[] {
  const sources = readStoredSources(db, scopeKey, json);
  if (!sources) throw new Error('FCA_PROVENANCE_UNRESOLVED');
  return sources;
}

/** The rows named, in that order, as sources; null when one is missing, of another scope, or still pending. */
function resolveRows(db: DatabaseSync, scopeKey: string, stepIds: readonly string[]): TaskSource[] | null {
  const rows = db.prepare('SELECT * FROM fca_task_sources WHERE step_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(stepIds));
  const byId = new Map(rows.map(row => [String(row.step_id), row]));
  const resolved: TaskSource[] = [];
  for (const id of stepIds) {
    const row = byId.get(id);
    if (!row || row.scope_key !== scopeKey || row.state === 'pending') return null;
    resolved.push(taskSourceOfRow(row, false));
  }
  return resolved;
}

function remember(db: DatabaseSync, key: string, sources: readonly TaskSource[]): void {
  const cache = caches.get(db) ?? new Map<string, readonly TaskSource[]>();
  caches.set(db, cache);
  cache.delete(key);
  if (cache.size >= KEPT) cache.delete(cache.keys().next().value!);
  cache.set(key, sources);
}
