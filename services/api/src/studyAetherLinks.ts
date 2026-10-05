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
      CREATE TABLE IF NOT EXISTS study_aether_pending (
        scope_key TEXT NOT NULL,
        document_id TEXT NOT NULL,
        aether_version INTEGER NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'update')),
        piece_id TEXT,
        kind TEXT CHECK (kind IS NULL OR kind IN ('story', 'note')),
        change_note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, document_id, aether_version)
      );
    `);
    // Additive: a reaction names the Aether document and version it was about, when the piece lives in Aether.
    const columns = database.prepare(`PRAGMA table_info('study_feedback')`).all() as unknown as Array<{ name: string }>;
    // Two processes opening the database for the first time at once (the API and the autonomy service) may both see the column
    // missing; the second add is then a duplicate column, which is what was wanted.
    const add = (sql: string) => { try { database.exec(sql); } catch (error) { if (!/duplicate column/iu.test(error instanceof Error ? error.message : '')) throw error; } };
    if (!columns.some(column => column.name === 'aether_document_id')) add('ALTER TABLE study_feedback ADD COLUMN aether_document_id TEXT');
    if (!columns.some(column => column.name === 'aether_version')) add('ALTER TABLE study_feedback ADD COLUMN aether_version INTEGER');
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
    return studyScopes(this.database);
  }

  /** Every piece of a scope as the migration plans it (`studyMigrationRows`), with no cap. */
  migrationRows(scopeKey: string): readonly StudyMigrationRow[] {
    return studyMigrationRows(this.database, scopeKey);
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
   * A write of hers that Aether took, noted the moment it answered and cleared when its local half commits (`clearPending`).
   * Should that commit be lost, the next sync knows the document or version as hers: it is linked with her own change note,
   * as the kind she wrote, and never read as a change the owner made.
   */
  notePending(scopeKey: string, write: { documentId: string; aetherVersion: number; operation: 'create' | 'update'; pieceId?: string; kind?: 'story' | 'note'; changeNote: string }, at: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO study_aether_pending (scope_key, document_id, aether_version, operation, piece_id, kind, change_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, write.documentId, write.aetherVersion, write.operation, write.pieceId ?? null, write.kind ?? null, write.changeNote, at);
  }

  /** Her write that made this version of the document, if its local half has not committed yet. */
  pending(scopeKey: string, documentId: string, aetherVersion: number): { operation: 'create' | 'update'; pieceId?: string; kind?: 'story' | 'note'; changeNote: string; createdAt: string } | null {
    const row = this.database.prepare(`
      SELECT operation, piece_id, kind, change_note, created_at FROM study_aether_pending WHERE scope_key = ? AND document_id = ? AND aether_version = ?
    `).get(scopeKey, documentId, aetherVersion) as unknown as { operation: 'create' | 'update'; piece_id: string | null; kind: 'story' | 'note' | null; change_note: string; created_at: string } | undefined;
    return row ? { operation: row.operation, ...(row.piece_id ? { pieceId: row.piece_id } : {}), ...(row.kind ? { kind: row.kind } : {}), changeNote: row.change_note, createdAt: row.created_at } : null;
  }

  /** Her create that made this document, if its local half has not committed yet. */
  pendingCreate(scopeKey: string, documentId: string): { aetherVersion: number; kind?: 'story' | 'note'; changeNote: string; createdAt: string } | null {
    const row = this.database.prepare(`
      SELECT aether_version, kind, change_note, created_at FROM study_aether_pending WHERE scope_key = ? AND document_id = ? AND operation = 'create' ORDER BY aether_version LIMIT 1
    `).get(scopeKey, documentId) as unknown as { aether_version: number; kind: 'story' | 'note' | null; change_note: string; created_at: string } | undefined;
    return row ? { aetherVersion: Number(row.aether_version), ...(row.kind ? { kind: row.kind } : {}), changeNote: row.change_note, createdAt: row.created_at } : null;
  }

  /** The writes of a document up to a version are settled (committed, or adopted by a sync). */
  clearPending(scopeKey: string, documentId: string, upToVersion: number): void {
    this.database.prepare(`DELETE FROM study_aether_pending WHERE scope_key = ? AND document_id = ? AND aether_version <= ?`).run(scopeKey, documentId, upToVersion);
  }

  /** Stories that are open (下書き or 見せてもいい) and not in her trash, for the open-story limit of an adoption. */
  openStories(scopeKey: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM study_pieces WHERE scope_key = ? AND kind = 'story' AND status IN ('draft', 'ready') AND deleted_at IS NULL
    `).get(scopeKey) as unknown as { count: number };
    return Number(row.count);
  }

  /**
   * A version that was made in Aether (the owner edited the document, or a write of hers whose local half was lost): it is
   * appended as her next local version, exactly as Aether returned it, and linked; a write of hers keeps her change note. A story becomes a draft again, as after a
   * revision of hers, and the owner keeps reading the version she showed; a note stays readable at its newest version.
   */
  adoptVersion(scopeKey: string, pieceId: string, change: { title: string; body: string; aetherVersion: number; documentId: string; changeNote?: string }, at: string): number | null {
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
    this.appendVersion(scopeKey, pieceId, version, change.title, change.body, change.changeNote ?? AETHER_SIDE_CHANGE, at);
    this.link(scopeKey, pieceId, version, change.documentId, change.aetherVersion, at);
    this.clearPending(scopeKey, change.documentId, change.aetherVersion);
    return version;
  }

  /**
   * A piece of hers that is in Aether but not in Shannon's study: a write whose local half was lost (her kind and change note
   * from `notePending`), or a story found in her study in Aether. A note is readable; a story is a draft, or put away when
   * her open stories are at their limit, so an adoption never goes past it.
   */
  adoptPiece(scopeKey: string, document: { documentId: string; aetherVersion: number; title: string; body: string; kind: 'story' | 'note'; changeNote?: string },
    openStoryLimit: number, at: string): string {
    const id = randomUUID();
    const note = document.kind === 'note';
    const full = !note && this.openStories(scopeKey) >= openStoryLimit;
    this.database.prepare(`
      INSERT INTO study_pieces (scope_key, piece_id, kind, title, body, status, version, readable_version, pursuit_id, sources_json, created_at, updated_at, put_away_by)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, '[]', ?, ?, ?)
    `).run(scopeKey, id, document.kind, document.title, document.body, note ? 'ready' : full ? 'put_away' : 'draft', note ? 1 : null, at, at, full ? 'shannon' : null);
    this.appendVersion(scopeKey, id, 1, document.title, document.body, document.changeNote ?? AETHER_SIDE_CHANGE, at);
    this.link(scopeKey, id, 1, document.documentId, document.aetherVersion, at);
    this.clearPending(scopeKey, document.documentId, document.aetherVersion);
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

/** What the migration needs of one piece: metadata and the length of its current body, never the body. */
export interface StudyMigrationRow {
  pieceId: string; kind: 'story' | 'note'; title: string; characters: number; status: 'draft' | 'ready' | 'shown' | 'put_away';
  readableVersion: number | null; origin: 'room_look' | 'reach_out' | null; deleted: boolean; documentId: string | null;
  /** The piece's current local version, and the local version its newest link is (a piece revised in Shannon since is ahead). */
  version: number; linkedVersion: number | null;
}

/**
 * The scopes of her study, read without changing anything: a database that predates the study answers none. Works on a
 * read-only connection (`readOnlyMigrationPlan`): it creates no table and adds no column.
 */
export function studyScopes(database: DatabaseSync): readonly string[] {
  if (!hasTable(database, 'study_pieces')) return [];
  return (database.prepare('SELECT DISTINCT scope_key FROM study_pieces ORDER BY scope_key').all() as unknown as Array<{ scope_key: string }>).map(row => row.scope_key);
}

/** Every piece of a scope, newest change first, read without changing anything; columns and tables added later may be absent. */
export function studyMigrationRows(database: DatabaseSync, scopeKey: string): readonly StudyMigrationRow[] {
  if (!hasTable(database, 'study_pieces')) return [];
  const columns = new Set((database.prepare(`PRAGMA table_info('study_pieces')`).all() as unknown as Array<{ name: string }>).map(column => column.name));
  const links = hasTable(database, 'study_aether_links');
  const rows = database.prepare(`
    SELECT p.piece_id, p.kind, p.title, length(p.body) AS characters, p.status, p.readable_version, p.version,
      ${links ? `(SELECT MAX(l.version) FROM study_aether_links l WHERE l.scope_key = p.scope_key AND l.piece_id = p.piece_id)` : 'NULL'} AS linked_version,
      ${columns.has('origin') ? 'p.origin' : 'NULL'} AS origin, ${columns.has('deleted_at') ? 'p.deleted_at' : 'NULL'} AS deleted_at,
      ${links ? `(SELECT l.document_id FROM study_aether_links l WHERE l.scope_key = p.scope_key AND l.piece_id = p.piece_id ORDER BY l.version DESC LIMIT 1)` : 'NULL'} AS document_id
    FROM study_pieces p WHERE p.scope_key = ? ORDER BY p.updated_at DESC, p.piece_id
  `).all(scopeKey) as unknown as Array<{ piece_id: string; kind: 'story' | 'note'; title: string; characters: number; status: StudyMigrationRow['status']; readable_version: number | null; version: number; linked_version: number | null; origin: string | null; deleted_at: string | null; document_id: string | null }>;
  return Object.freeze(rows.map(row => Object.freeze({
    pieceId: row.piece_id, kind: row.kind, title: row.title, characters: Number(row.characters), status: row.status,
    readableVersion: row.readable_version === null ? null : Number(row.readable_version),
    origin: row.origin === 'room_look' || row.origin === 'reach_out' ? row.origin : null, deleted: row.deleted_at !== null, documentId: row.document_id,
    version: Number(row.version), linkedVersion: row.linked_version === null ? null : Number(row.linked_version),
  })));
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/** The change note of a version that came from Aether rather than from a revision of hers. */
export const AETHER_SIDE_CHANGE = 'Aetherの側で変わった版です（ライ氏が直したか、Aetherにだけ届いていた書き込み）。';

interface LinkRow { piece_id: string; version: number; document_id: string; aether_version: number; linked_at: string }

function link(row: LinkRow): StudyAetherLink {
  return Object.freeze({ pieceId: row.piece_id, version: Number(row.version), documentId: row.document_id, aetherVersion: Number(row.aether_version), linkedAt: row.linked_at });
}
