import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  parseKnowledgeHeadingTree,
  type AetherDecisionReference,
  type KnowledgeDraft,
  type KnowledgeHeadingNode,
  type ShannonKnowledgeDocument,
  type ShannonKnowledgeStatus,
} from '@shannon/cognition';

/** Shannon-internal knowledge. There is no user-facing folder, list, or summary for it. */
export interface ShannonKnowledgeStore {
  listShannonKnowledge(scopeKey: string, options?: { includeRetired?: boolean }): readonly ShannonKnowledgeDocument[];
  /** `draft` must already have passed `normalizeKnowledgeDraft`. */
  createShannonKnowledge(scopeKey: string, draft: KnowledgeDraft, at: string, reason: string): ShannonKnowledgeDocument;
  updateShannonKnowledge(scopeKey: string, id: string, expectedVersion: number, draft: KnowledgeDraft, at: string, reason: string): ShannonKnowledgeDocument | null;
  /** Retirement keeps the reason and sources in the revision history. */
  retireShannonKnowledge(scopeKey: string, id: string, reason: string, at: string, evidenceExperienceIds?: readonly string[]): ShannonKnowledgeDocument | null;
  experienceObservedAt(scopeKey: string, ids: readonly string[]): ReadonlyMap<string, string>;
}

/** Additive schema v17. */
export function migrateShannonKnowledge(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_knowledge_documents (
      knowledge_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      heading_tree_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('hypothesis', 'confirmed', 'retired')),
      applicability TEXT NOT NULL,
      source_experience_ids_json TEXT NOT NULL
        CHECK (json_valid(source_experience_ids_json) AND json_array_length(source_experience_ids_json) > 0),
      aether_refs_json TEXT NOT NULL CHECK (json_valid(aether_refs_json)),
      retired_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1)
    );
    CREATE INDEX IF NOT EXISTS shannon_knowledge_scope_status
      ON shannon_knowledge_documents (scope_key, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS shannon_knowledge_revisions (
      revision_id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      applicability TEXT NOT NULL,
      source_experience_ids_json TEXT NOT NULL,
      aether_refs_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE (knowledge_id, version)
    );
  `);
}

interface DocumentRow {
  knowledge_id: string; title: string; body_markdown: string; heading_tree_json: string; status: ShannonKnowledgeStatus;
  applicability: string; source_experience_ids_json: string; aether_refs_json: string; retired_reason: string | null;
  created_at: string; updated_at: string; version: number;
}

export class SQLiteShannonKnowledgeStore implements ShannonKnowledgeStore {
  constructor(private readonly database: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  listShannonKnowledge(scopeKey: string, options: { includeRetired?: boolean } = {}): readonly ShannonKnowledgeDocument[] {
    const rows = this.database.prepare(`
      SELECT * FROM shannon_knowledge_documents
      WHERE scope_key = ? AND (? OR status != 'retired')
      ORDER BY updated_at DESC LIMIT 500
    `).all(scopeKey, options.includeRetired ? 1 : 0) as unknown as DocumentRow[];
    return Object.freeze(rows.map(documentFromRow));
  }

  createShannonKnowledge(scopeKey: string, draft: KnowledgeDraft, at: string, reason: string): ShannonKnowledgeDocument {
    const id = randomUUID();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO shannon_knowledge_documents
          (knowledge_id, scope_key, title, body_markdown, heading_tree_json, status, applicability,
           source_experience_ids_json, aether_refs_json, retired_reason, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
      `).run(id, scopeKey, draft.title, draft.bodyMarkdown, JSON.stringify(parseKnowledgeHeadingTree(draft.bodyMarkdown)),
        draft.status, draft.applicability, JSON.stringify(draft.sourceExperienceIds), JSON.stringify(draft.aetherReferences ?? []), at, at);
      return this.afterWrite(scopeKey, id, reason, at);
    });
  }

  updateShannonKnowledge(scopeKey: string, id: string, expectedVersion: number, draft: KnowledgeDraft, at: string, reason: string) {
    return this.transaction(() => {
      const current = this.row(scopeKey, id);
      if (!current || current.status === 'retired' || current.version !== expectedVersion) return null;
      // Sources accumulate: an update never drops the provenance that justified the earlier version.
      const sources = [...new Set([...JSON.parse(current.source_experience_ids_json) as string[], ...draft.sourceExperienceIds])];
      const status = draft.status === 'confirmed' && sources.length >= 2 ? 'confirmed' : current.status === 'confirmed' && draft.status === 'confirmed' ? 'confirmed' : 'hypothesis';
      this.database.prepare(`
        UPDATE shannon_knowledge_documents
        SET title = ?, body_markdown = ?, heading_tree_json = ?, status = ?, applicability = ?,
            source_experience_ids_json = ?, aether_refs_json = ?, updated_at = ?, version = version + 1
        WHERE scope_key = ? AND knowledge_id = ? AND version = ?
      `).run(draft.title, draft.bodyMarkdown, JSON.stringify(parseKnowledgeHeadingTree(draft.bodyMarkdown)), status,
        draft.applicability, JSON.stringify(sources), JSON.stringify(draft.aetherReferences ?? []), at, scopeKey, id, expectedVersion);
      return this.afterWrite(scopeKey, id, reason, at);
    });
  }

  retireShannonKnowledge(scopeKey: string, id: string, reason: string, at: string, evidenceExperienceIds: readonly string[] = []) {
    return this.transaction(() => {
      const current = this.row(scopeKey, id);
      if (!current || current.status === 'retired') return null;
      const sources = [...new Set([...JSON.parse(current.source_experience_ids_json) as string[], ...evidenceExperienceIds])];
      this.database.prepare(`
        UPDATE shannon_knowledge_documents
        SET status = 'retired', retired_reason = ?, source_experience_ids_json = ?, updated_at = ?, version = version + 1
        WHERE scope_key = ? AND knowledge_id = ?
      `).run(reason.slice(0, 400), JSON.stringify(sources), at, scopeKey, id);
      return this.afterWrite(scopeKey, id, reason, at);
    });
  }

  experienceObservedAt(scopeKey: string, ids: readonly string[]): ReadonlyMap<string, string> {
    if (!ids.length) return new Map();
    const rows = this.database.prepare(`
      SELECT event_id, observed_at FROM experience_events
      WHERE scope_key = ? AND event_id IN (SELECT value FROM json_each(?))
    `).all(scopeKey, JSON.stringify(ids)) as unknown as Array<{ event_id: string; observed_at: string }>;
    return new Map(rows.map(row => [row.event_id, row.observed_at]));
  }

  private row(scopeKey: string, id: string): DocumentRow | undefined {
    return this.database.prepare('SELECT * FROM shannon_knowledge_documents WHERE scope_key = ? AND knowledge_id = ?')
      .get(scopeKey, id) as unknown as DocumentRow | undefined;
  }

  /** Records the revision and keeps the search index in step (retired knowledge leaves the index). */
  private afterWrite(scopeKey: string, id: string, reason: string, at: string): ShannonKnowledgeDocument {
    const row = this.row(scopeKey, id)!;
    this.database.prepare(`
      INSERT INTO shannon_knowledge_revisions
        (revision_id, knowledge_id, scope_key, version, status, title, body_markdown, applicability,
         source_experience_ids_json, aether_refs_json, reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), id, scopeKey, row.version, row.status, row.title, row.body_markdown, row.applicability,
      row.source_experience_ids_json, row.aether_refs_json, reason.slice(0, 400), at);
    if (row.status === 'retired') {
      this.database.prepare("DELETE FROM memory_search_documents WHERE source_kind = 'knowledge' AND source_id = ?").run(id);
      this.database.prepare("DELETE FROM memory_embeddings WHERE source_kind = 'knowledge' AND source_id = ?").run(id);
    } else {
      this.database.prepare(`
        INSERT INTO memory_search_documents (source_kind, source_id, scope_key, thread_id, observed_at, body)
        VALUES ('knowledge', ?, ?, NULL, ?, ?)
        ON CONFLICT (source_kind, source_id) DO UPDATE SET
          body = excluded.body, observed_at = excluded.observed_at, revision = revision + 1
        WHERE body IS NOT excluded.body
      `).run(id, scopeKey, row.updated_at, `${row.title}\n${row.applicability}\n${row.body_markdown}`.slice(0, 2_000));
    }
    return documentFromRow(row);
  }
}

function documentFromRow(row: DocumentRow): ShannonKnowledgeDocument {
  return Object.freeze({
    id: row.knowledge_id,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    headings: Object.freeze(JSON.parse(row.heading_tree_json) as KnowledgeHeadingNode[]),
    status: row.status,
    applicability: row.applicability,
    sourceExperienceIds: Object.freeze(JSON.parse(row.source_experience_ids_json) as string[]),
    aetherReferences: Object.freeze(JSON.parse(row.aether_refs_json) as AetherDecisionReference[]),
    ...(row.retired_reason ? { retiredReason: row.retired_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version),
  });
}
