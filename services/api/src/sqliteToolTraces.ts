import type { DatabaseSync } from 'node:sqlite';
import { boundedTraceCalls, type ToolTraceRecord } from './shannonToolTrace.js';

/** A trace is kept this long; it is replayed only while its turn is in the replayed window anyway. */
const RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;
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
      PRIMARY KEY (scope_key, turn_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_tool_traces_thread ON conversation_tool_traces (scope_key, thread_id, recorded_at);
  `);
}

export function insertToolTrace(database: DatabaseSync, scopeKey: string, record: ToolTraceRecord): void {
  database.prepare(`
    INSERT INTO conversation_tool_traces (scope_key, turn_id, thread_id, recorded_at, asked, calls_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key, turn_id) DO UPDATE SET calls_json = excluded.calls_json, asked = excluded.asked
  `).run(scopeKey, record.turnId, record.threadId, record.recordedAt, record.asked ? 1 : 0, JSON.stringify(boundedTraceCalls(record.calls)));
  const recorded = Date.parse(record.recordedAt);
  if (Number.isFinite(recorded)) {
    database.prepare('DELETE FROM conversation_tool_traces WHERE scope_key = ? AND recorded_at < ?')
      .run(scopeKey, new Date(recorded - RETENTION_MILLISECONDS).toISOString());
  }
}

interface ToolTraceRow { turn_id: string; thread_id: string; recorded_at: string; asked: number; calls_json: string }

export function selectToolTraces(database: DatabaseSync, scopeKey: string, threadId: string, query: { turnIds?: readonly string[]; since?: string }): readonly ToolTraceRecord[] {
  const turnIds = (query.turnIds ?? []).slice(0, MAXIMUM_READ);
  const conditions = [
    ...(turnIds.length ? [`turn_id IN (${turnIds.map(() => '?').join(', ')})`] : []),
    ...(query.since !== undefined ? ['recorded_at >= ?'] : []),
  ];
  if (!conditions.length) return [];
  const rows = database.prepare(`
    SELECT turn_id, thread_id, recorded_at, asked, calls_json FROM conversation_tool_traces
    WHERE scope_key = ? AND thread_id = ? AND (${conditions.join(' OR ')})
    ORDER BY recorded_at DESC LIMIT ${MAXIMUM_READ}
  `).all(scopeKey, threadId, ...turnIds, ...(query.since !== undefined ? [query.since] : [])) as unknown as ToolTraceRow[];
  return Object.freeze(rows.map(row => {
    let calls: unknown = [];
    try { calls = JSON.parse(row.calls_json); } catch { calls = []; }
    return Object.freeze({ turnId: row.turn_id, threadId: row.thread_id, recordedAt: row.recorded_at, asked: row.asked === 1, calls: Object.freeze(boundedTraceCalls(calls)) });
  }));
}
