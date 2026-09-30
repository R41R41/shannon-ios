import type { DatabaseSync } from 'node:sqlite';
import {
  buildMemorySearchPlan,
  isEmptyMemorySearchPlan,
  memorySearchMatchExpression,
  scoreMemorySearchText,
} from '@shannon/cognition';

/** One searchable source row. Thread hits are prefixed so they never collide with experience IDs. */
export interface MemorySearchHit {
  kind: 'experience' | 'thread';
  id: string;
  sourceId: string;
  threadId?: string;
  summary: string;
  observedAt: string;
  score: number;
}

export interface MemorySearchSource {
  searchMemory(scopeKey: string, text: string, limit?: number): readonly MemorySearchHit[];
}

export const MEMORY_SEARCH_DEFAULT_LIMIT = 12;
const MAXIMUM_LIMIT = 40;

/**
 * Additive schema v15. `memory_search_documents` is an ordinary table kept in
 * sync by triggers, so every insertion path (app chat, voice, platform mirror)
 * is indexed without application code. The FTS5 trigram table is optional: a
 * runtime without FTS5/trigram still answers through bounded substring search.
 */
export function migrateMemorySearchIndex(database: DatabaseSync): void {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>)
    .map(row => row.name));
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_search_documents (
      doc_id INTEGER PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('experience', 'thread')),
      source_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_id TEXT,
      observed_at TEXT NOT NULL,
      body TEXT NOT NULL,
      UNIQUE (source_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS memory_search_documents_scope
      ON memory_search_documents (scope_key, observed_at DESC);
  `);
  if (tables.has('experience_events')) database.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_search_experience_insert
    AFTER INSERT ON experience_events
    WHEN NEW.event_type = 'turn.completed' AND json_valid(NEW.payload_json)
      AND json_type(NEW.payload_json, '$.summary') = 'text'
    BEGIN
      INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
      VALUES ('experience', NEW.event_id, NEW.scope_key, NULL, NEW.observed_at,
        substr(json_extract(NEW.payload_json, '$.summary'), 1, 2000))
      ON CONFLICT (source_kind, source_id) DO UPDATE SET
        body = excluded.body, observed_at = excluded.observed_at;
    END;
    INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
    SELECT 'experience', event_id, scope_key, NULL, observed_at, substr(json_extract(payload_json, '$.summary'), 1, 2000)
    FROM experience_events
    WHERE event_type = 'turn.completed' AND json_valid(payload_json)
      AND json_type(payload_json, '$.summary') = 'text'
    ON CONFLICT (source_kind, source_id) DO NOTHING;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_search_thread_insert
    AFTER INSERT ON conversation_threads
    WHEN NEW.summary IS NOT NULL AND length(trim(NEW.summary)) > 0
    BEGIN
      INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
      VALUES ('thread', NEW.thread_id, NEW.scope_key, NEW.thread_id, NEW.updated_at,
        substr(coalesce(NEW.title, '') || ' ' || NEW.summary, 1, 2000))
      ON CONFLICT (source_kind, source_id) DO UPDATE SET
        body = excluded.body, observed_at = excluded.observed_at;
    END;

    CREATE TRIGGER IF NOT EXISTS memory_search_thread_update
    AFTER UPDATE OF summary, title ON conversation_threads
    BEGIN
      DELETE FROM memory_search_documents
      WHERE source_kind = 'thread' AND source_id = NEW.thread_id
        AND (NEW.summary IS NULL OR length(trim(NEW.summary)) = 0);
      INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
      SELECT 'thread', NEW.thread_id, NEW.scope_key, NEW.thread_id, NEW.updated_at,
        substr(coalesce(NEW.title, '') || ' ' || NEW.summary, 1, 2000)
      WHERE NEW.summary IS NOT NULL AND length(trim(NEW.summary)) > 0
      ON CONFLICT (source_kind, source_id) DO UPDATE SET
        body = excluded.body, observed_at = excluded.observed_at;
    END;
  `);
  database.exec(`
    INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
    SELECT 'thread', thread_id, scope_key, thread_id, updated_at, substr(coalesce(title, '') || ' ' || summary, 1, 2000)
    FROM conversation_threads
    WHERE summary IS NOT NULL AND length(trim(summary)) > 0
    ON CONFLICT (source_kind, source_id) DO NOTHING;
  `);
  if (!supportsTrigramFts(database)) return;
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
      body, content='memory_search_documents', content_rowid='doc_id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS memory_search_fts_insert AFTER INSERT ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts (rowid, body) VALUES (NEW.doc_id, NEW.body);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_search_fts_delete AFTER DELETE ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts (memory_search_fts, rowid, body) VALUES ('delete', OLD.doc_id, OLD.body);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_search_fts_update AFTER UPDATE ON memory_search_documents BEGIN
      INSERT INTO memory_search_fts (memory_search_fts, rowid, body) VALUES ('delete', OLD.doc_id, OLD.body);
      INSERT INTO memory_search_fts (rowid, body) VALUES (NEW.doc_id, NEW.body);
    END;
    INSERT INTO memory_search_fts (memory_search_fts) VALUES ('rebuild');
  `);
}

function supportsTrigramFts(database: DatabaseSync): boolean {
  try {
    database.exec(`CREATE VIRTUAL TABLE temp.memory_search_probe USING fts5(body, tokenize='trigram'); DROP TABLE temp.memory_search_probe;`);
    return true;
  } catch {
    return false;
  }
}

interface DocumentRow { source_kind: 'experience' | 'thread'; source_id: string; thread_id: string | null; observed_at: string; body: string; }

/**
 * Read-only, deterministic search used by the response path. It performs no
 * writes and no model call. Archived threads are excluded at read time.
 */
export class SQLiteMemorySearchRepository implements MemorySearchSource {
  private hasFts: boolean | undefined;

  constructor(private readonly database: DatabaseSync) {}

  searchMemory(scopeKey: string, text: string, limit = MEMORY_SEARCH_DEFAULT_LIMIT): readonly MemorySearchHit[] {
    const plan = buildMemorySearchPlan(text);
    const bounded = Math.max(1, Math.min(MAXIMUM_LIMIT, Math.floor(limit)));
    if (isEmptyMemorySearchPlan(plan)) return [];
    const rows = new Map<string, DocumentRow>();
    const match = memorySearchMatchExpression(plan);
    if (match && this.ftsAvailable()) {
      for (const row of this.database.prepare(`
        SELECT d.source_kind, d.source_id, d.thread_id, d.observed_at, d.body
        FROM memory_search_fts f JOIN memory_search_documents d ON d.doc_id = f.rowid
        WHERE memory_search_fts MATCH ? AND d.scope_key = ?
        ORDER BY bm25(memory_search_fts), d.observed_at DESC
        LIMIT ?
      `).all(match, scopeKey, bounded * 3) as unknown as DocumentRow[]) rows.set(`${row.source_kind}:${row.source_id}`, row);
    }
    // Short terms (and every term when FTS5 is unavailable) use bounded substring search.
    const substringTerms = match && this.ftsAvailable() ? plan.shortTerms : [...plan.longTerms, ...plan.shortTerms];
    if (substringTerms.length) {
      const clauses = substringTerms.map(() => "d.body LIKE ? ESCAPE '\\'").join(' OR ');
      for (const row of this.database.prepare(`
        SELECT d.source_kind, d.source_id, d.thread_id, d.observed_at, d.body
        FROM memory_search_documents d
        WHERE d.scope_key = ? AND (${clauses})
        ORDER BY d.observed_at DESC
        LIMIT ?
      `).all(scopeKey, ...substringTerms.map(term => `%${term.replace(/[\\%_]/gu, '\\$&')}%`), bounded * 3) as unknown as DocumentRow[]) {
        rows.set(`${row.source_kind}:${row.source_id}`, row);
      }
    }
    const archived = this.archivedThreadIds(scopeKey);
    return Object.freeze([...rows.values()]
      .filter(row => !(row.thread_id && archived.has(row.thread_id)))
      .map(row => Object.freeze({
        kind: row.source_kind,
        id: row.source_kind === 'thread' ? `thread:${row.source_id}` : row.source_id,
        sourceId: row.source_id,
        ...(row.thread_id ? { threadId: row.thread_id } : {}),
        summary: row.body,
        observedAt: row.observed_at,
        score: scoreMemorySearchText(plan, row.body),
      }))
      .filter(hit => hit.score > 0)
      .sort((left, right) => right.score - left.score || right.observedAt.localeCompare(left.observedAt))
      .slice(0, bounded));
  }

  private ftsAvailable(): boolean {
    this.hasFts ??= Boolean(this.database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_search_fts'",
    ).get());
    return this.hasFts;
  }

  private archivedThreadIds(scopeKey: string): ReadonlySet<string> {
    const rows = this.database.prepare(`
      SELECT thread_id FROM conversation_threads WHERE scope_key = ? AND archived_at IS NOT NULL
    `).all(scopeKey) as unknown as Array<{ thread_id: string }>;
    return new Set(rows.map(row => row.thread_id));
  }
}
