import type { DatabaseSync } from 'node:sqlite';

/**
 * The provenance mark (owner decision 2026-10-06, Syzygy ADR-0007 「自分の時間に所有者の文書を読む」): what she writes after
 * reading the owner's documents, or a shared Notion page, is marked, and a turn with anyone else present does not read it.
 * The owner alone, and her own time, read it as before. Only marks are kept here: never a word of a document.
 *
 * - A session (one row of `autonomy_loop_cycles`) is marked by `owner_informed_at` the first time it reads one of the owner's
 *   documents, a shared Notion page, or a document already marked. The mark lasts until the session rests: it is the session's.
 * - Every document written in a marked session is a row of `owner_informed_documents`, append-only. A document is named by its
 *   Aether document id, or by `shannon-study://<piece id>` for a piece of her study (a jot or a note that never moves, or a piece
 *   written before Aether); a piece that moves to Aether later stays marked through its link (`marked`).
 * - A pursuit created or changed in a marked session carries `owner_informed_at` too.
 *
 * The literal filters of a turn with others present (`aetherShownText.ts`) stay as a second layer; they cannot catch a retelling,
 * which is why this mark exists.
 */
export const STUDY_DOCUMENT_PREFIX = 'shannon-study://';
export const AETHER_DOCUMENT_PREFIX = 'aether://documents/';
/** A reading her own time keeps until she writes a note about it (`autonomy_loop_readings`), when it came from a shared Notion page. */
export const READING_DOCUMENT_PREFIX = 'autonomy-reading://';

export class OwnerInformedMarks {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS owner_informed_documents (
        scope_key TEXT NOT NULL,
        document_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        informed_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, document_id)
      );
      CREATE TRIGGER IF NOT EXISTS owner_informed_documents_no_update BEFORE UPDATE ON owner_informed_documents
        BEGIN SELECT RAISE(ABORT, 'OWNER_INFORMED_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS owner_informed_documents_no_delete BEFORE DELETE ON owner_informed_documents
        BEGIN SELECT RAISE(ABORT, 'OWNER_INFORMED_APPEND_ONLY'); END;
    `);
    // Additive. Two processes opening the database for the first time at once may both add a column; the second is a duplicate.
    const add = (table: string) => {
      const columns = database.prepare(`PRAGMA table_info('${table}')`).all() as unknown as Array<{ name: string }>;
      if (columns.some(column => column.name === 'owner_informed_at')) return;
      try { database.exec(`ALTER TABLE ${table} ADD COLUMN owner_informed_at TEXT`); } catch (error) {
        if (!/duplicate column/iu.test(error instanceof Error ? error.message : '')) throw error;
      }
    };
    add('autonomy_loop_cycles');
    add('autonomy_pursuits');
  }

  /** The session read something of the owner's. The first mark stands. */
  markSession(cycleId: string, at: string): void {
    this.database.prepare('UPDATE autonomy_loop_cycles SET owner_informed_at = ? WHERE cycle_id = ? AND owner_informed_at IS NULL').run(at, cycleId);
  }

  /** Since when the session is marked, or null. */
  sessionInformedAt(cycleId: string): string | null {
    const row = this.database.prepare('SELECT owner_informed_at FROM autonomy_loop_cycles WHERE cycle_id = ?').get(cycleId) as unknown as { owner_informed_at: string | null } | undefined;
    return row?.owner_informed_at ?? null;
  }

  /** Whether the session open now (not yet rested) is marked. */
  openSessionInformed(scopeKey: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM autonomy_loop_cycles WHERE scope_key = ? AND ended_at IS NULL AND owner_informed_at IS NOT NULL
    `).get(scopeKey));
  }

  /** Marks documents written in a marked session; a piece of her study also by its Aether document, when it has one. */
  markDocuments(scopeKey: string, documentIds: readonly string[], sessionId: string, at: string): void {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO owner_informed_documents (scope_key, document_id, session_id, informed_at) VALUES (?, ?, ?, ?)
    `);
    for (const id of new Set(documentIds.flatMap(item => [item, ...this.aetherDocumentsOf(scopeKey, item)]))) {
      if (id) insert.run(scopeKey, id.slice(0, 300), sessionId, at);
    }
  }

  /** Whether a document is marked: by its own id, by the piece of her study it is, or by the Aether document a piece is. */
  marked(scopeKey: string, documentId: string): boolean {
    const id = documentId.startsWith(AETHER_DOCUMENT_PREFIX) ? decodeURIComponent(documentId.slice(AETHER_DOCUMENT_PREFIX.length)) : documentId;
    const names = [id, ...this.aetherDocumentsOf(scopeKey, id), ...this.piecesOf(scopeKey, id).map(piece => `${STUDY_DOCUMENT_PREFIX}${piece}`)];
    const known = this.database.prepare('SELECT 1 AS found FROM owner_informed_documents WHERE scope_key = ? AND document_id = ?');
    return names.some(name => Boolean(known.get(scopeKey, name)));
  }

  /** Pursuits created or changed since the session was marked carry the mark. Seeds never change. */
  markPursuits(scopeKey: string, since: string, at: string): void {
    this.database.prepare(`
      UPDATE autonomy_pursuits SET owner_informed_at = ? WHERE scope_key = ? AND origin <> 'seed' AND updated_at >= ? AND owner_informed_at IS NULL
    `).run(at, scopeKey, since);
  }

  /** The ids of marked pursuits. */
  informedPursuits(scopeKey: string): ReadonlySet<string> {
    const rows = this.database.prepare('SELECT pursuit_id FROM autonomy_pursuits WHERE scope_key = ? AND owner_informed_at IS NOT NULL').all(scopeKey) as unknown as Array<{ pursuit_id: string }>;
    return new Set(rows.map(row => row.pursuit_id));
  }

  private aetherDocumentsOf(scopeKey: string, id: string): string[] {
    if (!id.startsWith(STUDY_DOCUMENT_PREFIX)) return [];
    const rows = this.database.prepare('SELECT DISTINCT document_id FROM study_aether_links WHERE scope_key = ? AND piece_id = ?')
      .all(scopeKey, id.slice(STUDY_DOCUMENT_PREFIX.length)) as unknown as Array<{ document_id: string }>;
    return rows.map(row => row.document_id);
  }

  private piecesOf(scopeKey: string, documentId: string): string[] {
    if (documentId.includes('://')) return [];
    const rows = this.database.prepare('SELECT DISTINCT piece_id FROM study_aether_links WHERE scope_key = ? AND document_id = ?')
      .all(scopeKey, documentId) as unknown as Array<{ piece_id: string }>;
    return rows.map(row => row.piece_id);
  }
}
