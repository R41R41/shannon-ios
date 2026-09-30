import type { DatabaseSync } from 'node:sqlite';

export type EmbeddingSourceKind = 'experience' | 'thread' | 'knowledge';

/** A source row whose current revision has no embedding for the configured model. */
export interface PendingEmbeddingSource {
  kind: EmbeddingSourceKind;
  sourceId: string;
  scopeKey: string;
  revision: number;
  text: string;
}

export interface StoredEmbeddingCandidate {
  kind: EmbeddingSourceKind;
  /** Recall identifier: experience ID, `thread:<id>`, or `knowledge:<id>`. */
  id: string;
  sourceId: string;
  threadId?: string;
  summary: string;
  observedAt: string;
  vector: Float32Array;
}

export interface MemoryEmbeddingIndex {
  embeddingScopes(): readonly string[];
  /** Missing, stale, or withheld-under-an-older-state sources for one scope. */
  pendingEmbeddingSources(scopeKey: string, model: string, stateVersion: number, limit: number): readonly PendingEmbeddingSource[];
  storeEmbedding(source: PendingEmbeddingSource, model: string, vector: Float32Array, stateVersion: number, updatedAt: string): void;
  /** Records that a hidden (forgotten/rejected) source was deliberately not sent to the provider. */
  withholdEmbedding(source: PendingEmbeddingSource, model: string, stateVersion: number, updatedAt: string): void;
  embeddingCandidates(scopeKey: string, model: string, limit: number): readonly StoredEmbeddingCandidate[];
}

const LANES = "'chat', 'sleep', 'voice', 'memory', 'memory_background'";

/**
 * Additive schema v16: source revisions (so a rewritten thread summary is
 * re-embedded), the embedding table, and the `memory` / `memory_background`
 * usage lanes. Existing rows and columns are preserved.
 */
export function migrateMemoryEmbeddings(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info('memory_search_documents')").all() as unknown as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'revision')) {
    database.exec('ALTER TABLE memory_search_documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;');
  }
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>)
    .map(row => row.name));
  // Recreate the v15 source triggers so every content change bumps the revision.
  database.exec(`
    DROP TRIGGER IF EXISTS memory_search_experience_insert;
    DROP TRIGGER IF EXISTS memory_search_thread_insert;
    DROP TRIGGER IF EXISTS memory_search_thread_update;
  `);
  if (tables.has('experience_events')) database.exec(`
    CREATE TRIGGER memory_search_experience_insert
    AFTER INSERT ON experience_events
    WHEN NEW.event_type = 'turn.completed' AND json_valid(NEW.payload_json)
      AND json_type(NEW.payload_json, '$.summary') = 'text'
    BEGIN
      INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
      VALUES ('experience', NEW.event_id, NEW.scope_key, NULL, NEW.observed_at,
        substr(json_extract(NEW.payload_json, '$.summary'), 1, 2000))
      ON CONFLICT (source_kind, source_id) DO UPDATE SET
        body = excluded.body, observed_at = excluded.observed_at, revision = revision + 1
      WHERE body IS NOT excluded.body;
    END;
  `);
  database.exec(`
    CREATE TRIGGER memory_search_thread_insert
    AFTER INSERT ON conversation_threads
    WHEN NEW.summary IS NOT NULL AND length(trim(NEW.summary)) > 0
    BEGIN
      INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
      VALUES ('thread', NEW.thread_id, NEW.scope_key, NEW.thread_id, NEW.updated_at,
        substr(coalesce(NEW.title, '') || ' ' || NEW.summary, 1, 2000))
      ON CONFLICT (source_kind, source_id) DO UPDATE SET
        body = excluded.body, observed_at = excluded.observed_at, revision = revision + 1
      WHERE body IS NOT excluded.body;
    END;

    CREATE TRIGGER memory_search_thread_update
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
        body = excluded.body, observed_at = excluded.observed_at, revision = revision + 1
      WHERE body IS NOT excluded.body;
    END;

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      source_kind TEXT NOT NULL CHECK (source_kind IN ('experience', 'thread', 'knowledge')),
      source_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions >= 0),
      source_revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('embedded', 'withheld')),
      state_version INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_kind, source_id, model)
    );
    CREATE INDEX IF NOT EXISTS memory_embeddings_scope_model
      ON memory_embeddings (scope_key, model);
  `);
  migrateUsageLanes(database);
}

function migrateUsageLanes(database: DatabaseSync): void {
  const row = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'
  `).get() as unknown as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'memory_background'")) return;
  database.exec(`
    ALTER TABLE llm_usage_events RENAME TO llm_usage_events_before_memory;
    CREATE TABLE llm_usage_events (
      usage_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      lane TEXT NOT NULL CHECK (lane IN (${LANES})),
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
      estimated_cost_usd REAL NOT NULL CHECK (estimated_cost_usd >= 0),
      occurred_at TEXT NOT NULL
    );
    INSERT INTO llm_usage_events
      (usage_id, scope_key, lane, model, input_tokens, cached_input_tokens,
       output_tokens, total_tokens, estimated_cost_usd, occurred_at)
    SELECT usage_id, scope_key, lane, model, input_tokens, cached_input_tokens,
           output_tokens, total_tokens, estimated_cost_usd, occurred_at
    FROM llm_usage_events_before_memory;
    DROP TABLE llm_usage_events_before_memory;
    CREATE INDEX IF NOT EXISTS llm_usage_events_month_lane
      ON llm_usage_events (occurred_at, lane);
  `);
}

interface PendingRow { source_kind: EmbeddingSourceKind; source_id: string; scope_key: string; revision: number; body: string; }
interface CandidateRow { source_kind: EmbeddingSourceKind; source_id: string; thread_id: string | null; observed_at: string; body: string; vector: Uint8Array; }

export class SQLiteMemoryEmbeddingIndex implements MemoryEmbeddingIndex {
  constructor(private readonly database: DatabaseSync) {}

  embeddingScopes(): readonly string[] {
    return Object.freeze((this.database.prepare('SELECT DISTINCT scope_key FROM memory_search_documents ORDER BY scope_key')
      .all() as unknown as Array<{ scope_key: string }>).map(row => row.scope_key));
  }

  pendingEmbeddingSources(scopeKey: string, model: string, stateVersion: number, limit: number): readonly PendingEmbeddingSource[] {
    const rows = this.database.prepare(`
      SELECT d.source_kind, d.source_id, d.scope_key, d.revision, d.body
      FROM memory_search_documents d
      LEFT JOIN memory_embeddings e
        ON e.source_kind = d.source_kind AND e.source_id = d.source_id AND e.model = ?
      WHERE d.scope_key = ? AND (e.source_id IS NULL OR e.source_revision != d.revision
        OR (e.status = 'withheld' AND e.state_version < ?))
      ORDER BY d.observed_at DESC
      LIMIT ?
    `).all(model, scopeKey, stateVersion, Math.max(1, Math.min(256, Math.floor(limit)))) as unknown as PendingRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      kind: row.source_kind, sourceId: row.source_id, scopeKey: row.scope_key,
      revision: Number(row.revision), text: row.body,
    })));
  }

  storeEmbedding(source: PendingEmbeddingSource, model: string, vector: Float32Array, stateVersion: number, updatedAt: string): void {
    const normalized = unitVector(vector);
    this.upsert(source, model, 'embedded', stateVersion, normalized.length,
      new Uint8Array(normalized.buffer, normalized.byteOffset, normalized.byteLength), updatedAt);
  }

  withholdEmbedding(source: PendingEmbeddingSource, model: string, stateVersion: number, updatedAt: string): void {
    this.upsert(source, model, 'withheld', stateVersion, 0, new Uint8Array(0), updatedAt);
  }

  private upsert(source: PendingEmbeddingSource, model: string, status: 'embedded' | 'withheld', stateVersion: number,
    dimensions: number, vector: Uint8Array, updatedAt: string): void {
    this.database.prepare(`
      INSERT INTO memory_embeddings
        (source_kind, source_id, scope_key, model, dimensions, source_revision, status, state_version, vector, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_kind, source_id, model) DO UPDATE SET
        dimensions = excluded.dimensions, source_revision = excluded.source_revision, status = excluded.status,
        state_version = excluded.state_version, vector = excluded.vector, updated_at = excluded.updated_at
    `).run(source.kind, source.sourceId, source.scopeKey, model, dimensions, source.revision, status, stateVersion, vector, updatedAt);
  }

  /** Only embeddings of the current source revision are returned; stale vectors are ignored. */
  embeddingCandidates(scopeKey: string, model: string, limit: number): readonly StoredEmbeddingCandidate[] {
    const rows = this.database.prepare(`
      SELECT d.source_kind, d.source_id, d.thread_id, d.observed_at, d.body, e.vector
      FROM memory_embeddings e
      JOIN memory_search_documents d
        ON d.source_kind = e.source_kind AND d.source_id = e.source_id AND d.revision = e.source_revision
      WHERE e.scope_key = ? AND e.model = ? AND e.status = 'embedded'
        AND NOT EXISTS (
          SELECT 1 FROM conversation_threads t
          WHERE t.thread_id = d.thread_id AND t.archived_at IS NOT NULL
        )
      ORDER BY d.observed_at DESC
      LIMIT ?
    `).all(scopeKey, model, Math.max(1, Math.floor(limit))) as unknown as CandidateRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      kind: row.source_kind,
      id: row.source_kind === 'experience' ? row.source_id : `${row.source_kind}:${row.source_id}`,
      sourceId: row.source_id,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      summary: row.body,
      observedAt: row.observed_at,
      vector: decodeVector(row.vector),
    })));
  }
}

export function unitVector(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  const result = new Float32Array(vector.length);
  if (!Number.isFinite(norm) || norm === 0) return result;
  for (let index = 0; index < vector.length; index += 1) result[index] = vector[index]! / norm;
  return result;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return Number.isFinite(dot) ? dot : 0;
}

function decodeVector(value: Uint8Array): Float32Array {
  const copy = value.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}
