import type { DatabaseSync } from 'node:sqlite';
import { boundedTraceCalls, type ToolTraceRecord } from '../shannonToolTrace.js';
import { TOOL_TRACE_RETENTION_MILLISECONDS } from '../shannonToolTurns.js';

const MAXIMUM_READ = 400;

/**
 * What her tools did in a conversation turn (`shannonToolTrace.ts`), one row per stored turn, beside the turn and not
 * in its message: nothing that reads messages for a client can carry it. Additive and outside the numbered
 * migrations, so an older API binary still opens the database.
 */
export function ensureToolTraceSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_tool_traces (
      scope_key TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      asked INTEGER NOT NULL,
      calls_json TEXT NOT NULL,
      said_digest TEXT,
      PRIMARY KEY (scope_key, turn_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_tool_traces_thread ON conversation_tool_traces (scope_key, thread_id, recorded_at);
  `);
}

export function insertToolTrace(database: DatabaseSync, scopeKey: string, record: ToolTraceRecord): void {
  database.prepare(`
    INSERT INTO conversation_tool_traces (scope_key, turn_id, thread_id, recorded_at, asked, calls_json, said_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, turn_id) DO UPDATE SET calls_json = excluded.calls_json, asked = excluded.asked
  `).run(scopeKey, record.turnId, record.threadId, record.recordedAt, record.asked ? 1 : 0, JSON.stringify(boundedTraceCalls(record.calls)), record.saidDigest ?? null);
}

export function deleteToolTraces(database: DatabaseSync, scopeKey: string, turnIds: readonly string[]): void {
  for (let index = 0; index < turnIds.length; index += 200) {
    const part = turnIds.slice(index, index + 200);
    database.prepare(`DELETE FROM conversation_tool_traces WHERE scope_key = ? AND turn_id IN (${part.map(() => '?').join(', ')})`).run(scopeKey, ...part);
  }
}

export function selectToolTraceScopes(database: DatabaseSync): readonly string[] {
  return (database.prepare('SELECT DISTINCT scope_key FROM conversation_tool_traces').all() as unknown as Array<{ scope_key: string }>).map(row => row.scope_key);
}

/** Every scope at once: run when the store opens, on the API's maintenance timer, and by `pruneToolTraces`. */
export function pruneToolTraces(database: DatabaseSync, before: string): void {
  database.prepare('DELETE FROM conversation_tool_traces WHERE recorded_at < ?').run(before);
}

/** The retention boundary seen from `now`. */
export function toolTraceRetentionBoundary(now: string): string | null {
  const at = Date.parse(now);
  return Number.isFinite(at) ? new Date(at - TOOL_TRACE_RETENTION_MILLISECONDS).toISOString() : null;
}

interface ToolTraceRow { turn_id: string; thread_id: string; recorded_at: string; asked: number; calls_json: string; said_digest: string | null }

export function selectToolTraces(database: DatabaseSync, scopeKey: string, threadId: string | null, query: { turnIds?: readonly string[]; since?: string }): readonly ToolTraceRecord[] {
  const turnIds = (query.turnIds ?? []).slice(0, MAXIMUM_READ);
  const conditions = [
    ...(turnIds.length ? [`turn_id IN (${turnIds.map(() => '?').join(', ')})`] : []),
    ...(query.since !== undefined ? ['recorded_at >= ?'] : []),
  ];
  if (!conditions.length) return [];
  const rows = database.prepare(`
    SELECT turn_id, thread_id, recorded_at, asked, calls_json, said_digest FROM conversation_tool_traces
    WHERE scope_key = ? AND (? IS NULL OR thread_id = ?) AND (${conditions.join(' OR ')})
    ORDER BY recorded_at DESC LIMIT ${threadId === null ? 5_000 : MAXIMUM_READ}
  `).all(scopeKey, threadId, threadId, ...turnIds, ...(query.since !== undefined ? [query.since] : [])) as unknown as ToolTraceRow[];
  return Object.freeze(rows.map(row => {
    let calls: unknown = [];
    try { calls = JSON.parse(row.calls_json); } catch { calls = []; }
    return Object.freeze({ turnId: row.turn_id, threadId: row.thread_id, recordedAt: row.recorded_at, asked: row.asked === 1, calls: Object.freeze(boundedTraceCalls(calls)), ...(row.said_digest ? { saidDigest: row.said_digest } : {}) });
  }));
}
