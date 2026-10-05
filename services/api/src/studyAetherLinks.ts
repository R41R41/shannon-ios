import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Which of her study pieces live in Aether (Syzygy ADR-0007, revised 2026-10-06), and as which Aether document and version.
 *
 * Once a piece has a link its text is Aether's: a story is a document tagged 書斎 in 「シャノン用フォルダ」, a note a document
 * in that folder without the tag. Shannon keeps what Aether does not: the stage (下書き, 見せてもいい, 見せた, しまった),
 * the version the owner reads, every version with what changed and why (so the owner keeps reading the version she showed
 * while she revises), and the owner's reactions, which are keyed by the Aether document and version they were about.
 * The rows of her study keep the text of each version as she wrote it or as Aether last returned it.
 *
 * A link row is written once per local version and never changed (append-only, like the versions). A piece without a link
 * is a piece that has not moved yet: it stays in Shannon's database until the owner has seen the move
 * (`studyMigration.ts`). Her notes about a look at the room and what she jotted after an unanswered message never move.
 */
export interface StudyAetherLink {
  pieceId: string;
  /** The local version this Aether version is. */
  version: number;
  documentId: string;
  aetherVersion: number;
  linkedAt: string;
}

export class StudyAetherLinks {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS study_aether_links (
        scope_key TEXT NOT NULL,
        piece_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        document_id TEXT NOT NULL,
        aether_version INTEGER NOT NULL CHECK (aether_version >= 1),
        linked_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, piece_id, version)
      );
      CREATE INDEX IF NOT EXISTS study_aether_links_document ON study_aether_links (scope_key, document_id);
      CREATE TRIGGER IF NOT EXISTS study_aether_links_no_update BEFORE UPDATE ON study_aether_links
        BEGIN SELECT RAISE(ABORT, 'STUDY_AETHER_LINK_APPEND_ONLY'); END;
    `);
    // Additive: a reaction names the Aether document and version it was about, when the piece lives in Aether.
    const columns = database.prepare(`PRAGMA table_info('study_feedback')`).all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'aether_document_id')) database.exec('ALTER TABLE study_feedback ADD COLUMN aether_document_id TEXT');
    if (!columns.some(column => column.name === 'aether_version')) database.exec('ALTER TABLE study_feedback ADD COLUMN aether_version INTEGER');
  }

  /** Local version `version` of the piece is Aether's `aetherVersion` of `documentId`. A version linked already stays as it was. */
  link(scopeKey: string, pieceId: string, version: number, documentId: string, aetherVersion: number, at: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO study_aether_links (scope_key, piece_id, version, document_id, aether_version, linked_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(scopeKey, pieceId, version, documentId, aetherVersion, at);
  }

  /** The newest link of a piece, or null while it has not moved to Aether. */
  current(scopeKey: string, pieceId: string): StudyAetherLink | null {
    const row = this.database.prepare(`
      SELECT * FROM study_aether_links WHERE scope_key = ? AND piece_id = ? ORDER BY version DESC LIMIT 1
    `).get(scopeKey, pieceId) as unknown as LinkRow | undefined;
    return row ? link(row) : null;
  }

  /** The Aether version a local version is, or null (a version written before the piece moved). */
  forVersion(scopeKey: string, pieceId: string, version: number): StudyAetherLink | null {
    const row = this.database.prepare(`
      SELECT * FROM study_aether_links WHERE scope_key = ? AND piece_id = ? AND version = ?
    `).get(scopeKey, pieceId, version) as unknown as LinkRow | undefined;
    return row ? link(row) : null;
  }

  /** The piece an Aether document is, or null. */
  pieceFor(scopeKey: string, documentId: string): string | null {
    const row = this.database.prepare(`SELECT piece_id FROM study_aether_links WHERE scope_key = ? AND document_id = ? LIMIT 1`).get(scopeKey, documentId) as unknown as { piece_id: string } | undefined;
    return row?.piece_id ?? null;
  }

  /** Every scope that has a piece in her study (for the migration). */
  scopes(): readonly string[] {
    return (this.database.prepare('SELECT DISTINCT scope_key FROM study_pieces ORDER BY scope_key').all() as unknown as Array<{ scope_key: string }>).map(row => row.scope_key);
  }

  /** The newest link of every piece that lives in Aether. */
  all(scopeKey: string): ReadonlyMap<string, StudyAetherLink> {
    const rows = this.database.prepare(`
      SELECT l.* FROM study_aether_links l
      JOIN (SELECT piece_id, MAX(version) AS version FROM study_aether_links WHERE scope_key = ? GROUP BY piece_id) m
        ON l.piece_id = m.piece_id AND l.version = m.version
      WHERE l.scope_key = ?
    `).all(scopeKey, scopeKey) as unknown as LinkRow[];
    return new Map(rows.map(row => [row.piece_id, link(row)]));
  }

  /**
   * A version that was made in Aether (the owner edited the document, or a write of hers whose local half was lost): it is
   * appended as her next local version, exactly as Aether returned it, and linked. A story becomes a draft again, as after a
   * revision of hers, and the owner keeps reading the version she showed; a note stays readable at its newest version.
   */
  adoptVersion(scopeKey: string, pieceId: string, change: { title: string; body: string; aetherVersion: number; documentId: string }, at: string): number | null {
    const row = this.database.prepare(`SELECT kind, version, status FROM study_pieces WHERE scope_key = ? AND piece_id = ?`).get(scopeKey, pieceId) as unknown as { kind: string; version: number; status: string } | undefined;
    if (!row) return null;
    const version = Number(row.version) + 1;
    const note = row.kind === 'note';
    this.database.prepare(`
      UPDATE study_pieces SET title = ?, body = ?, version = ?, updated_at = ?,
        status = CASE WHEN ? THEN status WHEN status = 'put_away' THEN status ELSE 'draft' END,
        readable_version = CASE WHEN ? THEN ? ELSE readable_version END
      WHERE scope_key = ? AND piece_id = ?
    `).run(change.title, change.body, version, at, note ? 1 : 0, note ? 1 : 0, version, scopeKey, pieceId);
    this.appendVersion(scopeKey, pieceId, version, change.title, change.body, AETHER_SIDE_CHANGE, at);
    this.link(scopeKey, pieceId, version, change.documentId, change.aetherVersion, at);
    return version;
  }

  /** A story of hers that is in Aether's study but not in Shannon's (written by a step whose local half was lost): kept as a draft. */
  adoptStory(scopeKey: string, document: { documentId: string; aetherVersion: number; title: string; body: string }, at: string): string {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO study_pieces (scope_key, piece_id, kind, title, body, status, version, readable_version, pursuit_id, sources_json, created_at, updated_at)
      VALUES (?, ?, 'story', ?, ?, 'draft', 1, NULL, NULL, '[]', ?, ?)
    `).run(scopeKey, id, document.title, document.body, at, at);
    this.appendVersion(scopeKey, id, 1, document.title, document.body, AETHER_SIDE_CHANGE, at);
    this.link(scopeKey, id, 1, document.documentId, document.aetherVersion, at);
    return id;
  }

  /** A piece deleted in Aether is in her trash; one the owner restored there comes back out. */
  setDeleted(scopeKey: string, pieceId: string, deleted: boolean, at: string): void {
    this.database.prepare(`UPDATE study_pieces SET deleted_at = ?, updated_at = ? WHERE scope_key = ? AND piece_id = ? AND (deleted_at IS NULL) = ?`)
      .run(deleted ? at : null, at, scopeKey, pieceId, deleted ? 1 : 0);
  }

  /** Reactions to a piece written before it moved: they name its document from now on (their version stays local). */
  nameFeedbackDocument(scopeKey: string, pieceId: string, documentId: string): void {
    this.database.prepare(`UPDATE study_feedback SET aether_document_id = ? WHERE scope_key = ? AND piece_id = ? AND aether_document_id IS NULL`).run(documentId, scopeKey, pieceId);
  }

  private appendVersion(scopeKey: string, pieceId: string, version: number, title: string, body: string, changeNote: string, at: string): void {
    this.database.prepare(`
      INSERT INTO study_piece_versions (scope_key, piece_id, version, title, body, change_note, model, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(scopeKey, pieceId, version, title, body, changeNote, at);
  }
}

/** The change note of a version that came from Aether rather than from a revision of hers. */
export const AETHER_SIDE_CHANGE = 'Aetherの側で変わった版です（ライ氏が直したか、Aetherにだけ届いていた書き込み）。';

interface LinkRow { piece_id: string; version: number; document_id: string; aether_version: number; linked_at: string }

function link(row: LinkRow): StudyAetherLink {
  return Object.freeze({ pieceId: row.piece_id, version: Number(row.version), documentId: row.document_id, aetherVersion: Number(row.aether_version), linkedAt: row.linked_at });
}
