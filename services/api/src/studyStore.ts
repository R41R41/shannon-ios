import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Shannon's study (書斎): the notes and story drafts she writes in her own time.
 *
 * Aether's study does not exist yet, so for now the study lives inside Shannon. The text
 * is hers: the owner reads it and may react or ask her to put a piece away, but no
 * owner route edits a title or a body. Every revision appends a version with what
 * changed and why; earlier versions are kept.
 *
 * A story she has not yet called 「見せてもいい」 is visible to the owner only as
 * 「作っているものがあります」, without its title or text.
 */
export type StudyPieceKind = 'story' | 'note';
export type StudyPieceStatus = 'draft' | 'ready' | 'shown' | 'put_away';
export type StudyReaction = 'like' | 'more' | 'unclear';
export type StudyPieceOrigin = 'room_look' | 'reach_out';

export const STUDY_STATUS_LABEL: Readonly<Record<StudyPieceStatus, string>> = Object.freeze({
  draft: '下書き', ready: '見せてもいい', shown: '見せた', put_away: 'しまった',
});
export const STUDY_REACTION_LABEL: Readonly<Record<StudyReaction, string>> = Object.freeze({
  like: '好き', more: 'もう少し', unclear: 'よく分からない',
});
export const STUDY_KIND_LABEL: Readonly<Record<StudyPieceKind, string>> = Object.freeze({ story: '物語', note: 'メモ' });

export const STUDY_LIMITS = Object.freeze({
  title: 80, storyBody: 4_000, noteBody: 1_200, changeNote: 400, comment: 400, sources: 8, sourceTitle: 160, sourceUrl: 2_000,
  /** Stories that may be open (下書き or 見せてもいい) at once. */
  openStories: 12,
  /** Reactions kept unread per piece; more than this and the oldest stay but no new one is taken. */
  pendingFeedback: 6,
});

export interface StudySource { title: string; url: string }

export interface StudyPiece {
  id: string;
  kind: StudyPieceKind;
  title: string;
  body: string;
  status: StudyPieceStatus;
  version: number;
  /** The latest version she called 「見せてもいい」; the owner reads this one. */
  readableVersion: number | null;
  pursuitId?: string;
  sources: readonly StudySource[];
  createdAt: string;
  updatedAt: string;
  shownAt?: string;
  putAwayBy?: 'shannon' | 'owner';
  /** Set while the piece is in her study's trash: restorable, with every version kept. */
  deletedAt?: string;
  /**
   * `room_look`: her note about one look at the owner's room. She may use it in her own thinking and recall it with the owner; its text never goes into a file in her folder (coordinator decision 2026-10-05, checked by the v1 copy step and her folder tools), and it is never written into a story as it is.
   * `reach_out`: what she wrote down after a message of hers got no answer. Hers to think with; it is not material for a story or for a message.
   */
  origin?: StudyPieceOrigin;
}

export interface StudyVersion {
  version: number;
  title: string;
  body: string;
  /** What changed and why, in her words. */
  changeNote: string;
  model?: string;
  createdAt: string;
}

export interface StudyFeedback {
  id: string;
  pieceId: string;
  version: number;
  reaction: StudyReaction;
  comment: string;
  createdAt: string;
  /** When a revising step was given this reaction. */
  usedAt?: string;
}

export interface StudyDraft {
  kind: StudyPieceKind;
  title: string;
  body: string;
  changeNote?: string;
  pursuitId?: string;
  sources?: readonly StudySource[];
  model?: string;
  origin?: StudyPieceOrigin;
}

export type StudyRejection = 'STUDY_INVALID' | 'STUDY_LIMIT' | 'STUDY_NOT_FOUND' | 'STUDY_CLOSED' | 'STUDY_NOT_READABLE';

interface PieceRow {
  piece_id: string; kind: string; title: string; body: string; status: string; version: number; readable_version: number | null;
  pursuit_id: string | null; sources_json: string; created_at: string; updated_at: string; shown_at: string | null; put_away_by: string | null;
  origin: string | null;
  deleted_at?: string | null;
}

export class StudyStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS study_pieces (
        scope_key TEXT NOT NULL,
        piece_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('story', 'note')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'shown', 'put_away')),
        version INTEGER NOT NULL CHECK (version >= 1),
        readable_version INTEGER,
        pursuit_id TEXT,
        sources_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        shown_at TEXT,
        put_away_by TEXT CHECK (put_away_by IS NULL OR put_away_by IN ('shannon', 'owner')),
        PRIMARY KEY (scope_key, piece_id)
      );
      CREATE INDEX IF NOT EXISTS study_pieces_scope_updated ON study_pieces (scope_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS study_piece_versions (
        scope_key TEXT NOT NULL,
        piece_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        change_note TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, piece_id, version)
      );
      CREATE TRIGGER IF NOT EXISTS study_piece_versions_no_update BEFORE UPDATE ON study_piece_versions
        BEGIN SELECT RAISE(ABORT, 'STUDY_VERSION_APPEND_ONLY'); END;
      CREATE TABLE IF NOT EXISTS study_feedback (
        feedback_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        piece_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        reaction TEXT NOT NULL CHECK (reaction IN ('like', 'more', 'unclear')),
        comment TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS study_feedback_piece ON study_feedback (scope_key, piece_id, created_at);
    `);
    // Additive: where a note came from, when that matters for who may be given it.
    const columns = database.prepare(`PRAGMA table_info('study_pieces')`).all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'origin')) database.exec('ALTER TABLE study_pieces ADD COLUMN origin TEXT');
    // Additive (2026-10-05): her own delete is soft. A deleted piece is in her study's trash, and every other path reads it as gone.
    if (!columns.some(column => column.name === 'deleted_at')) database.exec('ALTER TABLE study_pieces ADD COLUMN deleted_at TEXT');
  }

  /** Newest change first. Pieces in her trash are left out unless `deleted` asks for them (`only`: nothing else). */
  list(scopeKey: string, limit = 200, deleted: 'exclude' | 'include' | 'only' = 'exclude'): readonly StudyPiece[] {
    const filter = deleted === 'exclude' ? 'AND deleted_at IS NULL' : deleted === 'only' ? 'AND deleted_at IS NOT NULL' : '';
    const rows = this.database.prepare(`
      SELECT * FROM study_pieces WHERE scope_key = ? ${filter} ORDER BY updated_at DESC, piece_id LIMIT ?
    `).all(scopeKey, Math.max(1, Math.min(500, Math.trunc(limit)))) as unknown as PieceRow[];
    return Object.freeze(rows.map(piece));
  }

  /** A piece in her trash is not found here; `find` with `includeDeleted` reads it. */
  get(scopeKey: string, id: string): StudyPiece | null {
    return this.find(scopeKey, id, false);
  }

  find(scopeKey: string, id: string, includeDeleted: boolean): StudyPiece | null {
    const row = this.database.prepare(`
      SELECT * FROM study_pieces WHERE scope_key = ? AND piece_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(scopeKey, id) as unknown as PieceRow | undefined;
    return row ? piece(row) : null;
  }

  /** Her delete: into the trash. The text and every version stay; `restore` takes it back. */
  softDelete(scopeKey: string, id: string, at: string): StudyPiece | StudyRejection {
    const current = this.find(scopeKey, id, true);
    if (!current) return 'STUDY_NOT_FOUND';
    if (current.deletedAt) return current;
    this.database.prepare(`UPDATE study_pieces SET deleted_at = ?, updated_at = ? WHERE scope_key = ? AND piece_id = ?`).run(at, at, scopeKey, id);
    return this.find(scopeKey, id, true)!;
  }

  restore(scopeKey: string, id: string, at: string): StudyPiece | StudyRejection {
    const current = this.find(scopeKey, id, true);
    if (!current) return 'STUDY_NOT_FOUND';
    if (!current.deletedAt) return current;
    if (current.kind === 'story' && (current.status === 'draft' || current.status === 'ready') && this.openStoryCount(scopeKey) >= STUDY_LIMITS.openStories) return 'STUDY_LIMIT';
    this.database.prepare(`UPDATE study_pieces SET deleted_at = NULL, updated_at = ? WHERE scope_key = ? AND piece_id = ?`).run(at, scopeKey, id);
    return this.get(scopeKey, id)!;
  }

  /** Takes a piece she or the owner put away back out: a story as a draft, a note as readable. */
  takeBack(scopeKey: string, id: string, at: string): StudyPiece | StudyRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'STUDY_NOT_FOUND';
    if (current.status !== 'put_away') return current;
    if (current.kind === 'story' && this.openStoryCount(scopeKey) >= STUDY_LIMITS.openStories) return 'STUDY_LIMIT';
    this.database.prepare(`
      UPDATE study_pieces SET status = ?, put_away_by = NULL, updated_at = ? WHERE scope_key = ? AND piece_id = ?
    `).run(current.kind === 'note' ? 'ready' : 'draft', at, scopeKey, id);
    return this.get(scopeKey, id)!;
  }

  /** Files a piece under one of her pursuits, or under none. */
  setPursuit(scopeKey: string, id: string, pursuitId: string | null, at: string): StudyPiece | StudyRejection {
    if (!this.get(scopeKey, id)) return 'STUDY_NOT_FOUND';
    if (pursuitId !== null && (typeof pursuitId !== 'string' || !pursuitId || pursuitId.length > 80)) return 'STUDY_INVALID';
    this.database.prepare(`UPDATE study_pieces SET pursuit_id = ?, updated_at = ? WHERE scope_key = ? AND piece_id = ?`).run(pursuitId, at, scopeKey, id);
    return this.get(scopeKey, id)!;
  }

  /**
   * Pieces whose current title or body contains `query` (case-insensitive), newest change first.
   * `deleted` as in `list`. The caller cuts the snippets.
   */
  search(scopeKey: string, query: string, limit: number, deleted: 'exclude' | 'include' | 'only' = 'exclude'): readonly StudyPiece[] {
    const needle = `%${query.replace(/[\\%_]/gu, match => `\\${match}`)}%`;
    const filter = deleted === 'exclude' ? 'AND deleted_at IS NULL' : deleted === 'only' ? 'AND deleted_at IS NOT NULL' : '';
    const rows = this.database.prepare(`
      SELECT * FROM study_pieces WHERE scope_key = ? ${filter} AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
      ORDER BY updated_at DESC, piece_id LIMIT ?
    `).all(scopeKey, needle, needle, Math.max(1, Math.min(100, Math.trunc(limit)))) as unknown as PieceRow[];
    return Object.freeze(rows.map(piece));
  }

  private openStoryCount(scopeKey: string): number {
    return this.list(scopeKey, 500).filter(item => item.kind === 'story' && (item.status === 'draft' || item.status === 'ready')).length;
  }

  versions(scopeKey: string, id: string): readonly StudyVersion[] {
    const rows = this.database.prepare(`
      SELECT version, title, body, change_note, model, created_at FROM study_piece_versions
      WHERE scope_key = ? AND piece_id = ? ORDER BY version
    `).all(scopeKey, id) as unknown as Array<{ version: number; title: string; body: string; change_note: string; model: string | null; created_at: string }>;
    return Object.freeze(rows.map(row => Object.freeze({
      version: Number(row.version), title: row.title, body: row.body, changeNote: row.change_note,
      ...(row.model ? { model: row.model } : {}), createdAt: row.created_at,
    })));
  }

  /** A note is readable from the start; a story starts as a draft only she can read. */
  create(scopeKey: string, draft: StudyDraft, at: string): StudyPiece | StudyRejection {
    const normalized = normalizedDraft(draft);
    if (!normalized) return 'STUDY_INVALID';
    if (normalized.kind === 'story' && this.openStoryCount(scopeKey) >= STUDY_LIMITS.openStories) return 'STUDY_LIMIT';
    const id = randomUUID();
    const note = normalized.kind === 'note';
    this.database.prepare(`
      INSERT INTO study_pieces
        (scope_key, piece_id, kind, title, body, status, version, readable_version, pursuit_id, sources_json, created_at, updated_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, id, normalized.kind, normalized.title, normalized.body, note ? 'ready' : 'draft', note ? 1 : null,
      normalized.pursuitId ?? null, JSON.stringify(normalized.sources), at, at, note && (draft.origin === 'room_look' || draft.origin === 'reach_out') ? draft.origin : null);
    this.appendVersion(scopeKey, id, 1, normalized.title, normalized.body, normalized.changeNote || '最初の稿です。', normalized.model, at);
    return this.get(scopeKey, id)!;
  }

  /** Appends a version. A revised piece is a draft again until she calls the new version 「見せてもいい」. */
  revise(
    scopeKey: string, id: string,
    change: { title?: string; body: string; changeNote: string; model?: string; sources?: readonly StudySource[] },
    at: string,
  ): StudyPiece | StudyRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'STUDY_NOT_FOUND';
    if (current.status === 'put_away') return 'STUDY_CLOSED';
    const title = change.title === undefined ? current.title : line(change.title, STUDY_LIMITS.title);
    const body = text(change.body, current.kind === 'story' ? STUDY_LIMITS.storyBody : STUDY_LIMITS.noteBody);
    const changeNote = line(change.changeNote, STUDY_LIMITS.changeNote);
    const sources = change.sources === undefined ? current.sources : normalizedSources(change.sources);
    if (!title || !body || !changeNote || !sources) return 'STUDY_INVALID';
    const version = current.version + 1;
    this.database.prepare(`
      UPDATE study_pieces SET title = ?, body = ?, version = ?, status = ?, sources_json = ?, updated_at = ?
      WHERE scope_key = ? AND piece_id = ?
    `).run(title, body, version, current.kind === 'note' ? 'ready' : 'draft', JSON.stringify(sources), at, scopeKey, id);
    if (current.kind === 'note') {
      this.database.prepare(`UPDATE study_pieces SET readable_version = ? WHERE scope_key = ? AND piece_id = ?`).run(version, scopeKey, id);
    }
    this.appendVersion(scopeKey, id, version, title, body, changeNote, change.model, at);
    return this.get(scopeKey, id)!;
  }

  /** 「見せてもいい」: the current version becomes the one the owner can read. */
  markReady(scopeKey: string, id: string, at: string): StudyPiece | StudyRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'STUDY_NOT_FOUND';
    if (current.status === 'put_away') return 'STUDY_CLOSED';
    this.database.prepare(`
      UPDATE study_pieces SET status = CASE WHEN status = 'shown' AND readable_version = version THEN 'shown' ELSE 'ready' END,
        readable_version = version, updated_at = ?
      WHERE scope_key = ? AND piece_id = ?
    `).run(at, scopeKey, id);
    return this.get(scopeKey, id)!;
  }

  /** 「見せた」: the owner has been told about the readable version. */
  markShown(scopeKey: string, id: string, at: string): StudyPiece | StudyRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'STUDY_NOT_FOUND';
    if (current.status !== 'ready') return current.status === 'shown' ? current : 'STUDY_CLOSED';
    this.database.prepare(`
      UPDATE study_pieces SET status = 'shown', shown_at = ?, updated_at = ? WHERE scope_key = ? AND piece_id = ?
    `).run(at, at, scopeKey, id);
    return this.get(scopeKey, id)!;
  }

  /** 「しまった」. The text and its versions stay; nothing is deleted. */
  putAway(scopeKey: string, id: string, by: 'shannon' | 'owner', at: string): StudyPiece | StudyRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'STUDY_NOT_FOUND';
    if (current.status === 'put_away') return current;
    this.database.prepare(`
      UPDATE study_pieces SET status = 'put_away', put_away_by = ?, updated_at = ? WHERE scope_key = ? AND piece_id = ?
    `).run(by, at, scopeKey, id);
    return this.get(scopeKey, id)!;
  }

  /** A reaction is about the version the owner could read at that moment. */
  addFeedback(scopeKey: string, id: string, input: { reaction: StudyReaction; comment?: string }, at: string): StudyFeedback | StudyRejection {
    const current = this.get(scopeKey, id);
    if (!current) return 'STUDY_NOT_FOUND';
    if (current.readableVersion === null) return 'STUDY_NOT_READABLE';
    if (!(input?.reaction in STUDY_REACTION_LABEL)) return 'STUDY_INVALID';
    const comment = input.comment === undefined || input.comment === '' ? '' : text(input.comment, STUDY_LIMITS.comment);
    if (comment === null) return 'STUDY_INVALID';
    if (this.pendingFeedback(scopeKey, id).length >= STUDY_LIMITS.pendingFeedback) return 'STUDY_LIMIT';
    const feedbackId = randomUUID();
    this.database.prepare(`
      INSERT INTO study_feedback (feedback_id, scope_key, piece_id, version, reaction, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(feedbackId, scopeKey, id, current.readableVersion, input.reaction, comment, at);
    return this.feedback(scopeKey, id).find(item => item.id === feedbackId)!;
  }

  feedback(scopeKey: string, id: string): readonly StudyFeedback[] {
    const rows = this.database.prepare(`
      SELECT * FROM study_feedback WHERE scope_key = ? AND piece_id = ? ORDER BY created_at, feedback_id
    `).all(scopeKey, id) as unknown as Array<{ feedback_id: string; piece_id: string; version: number; reaction: string; comment: string; created_at: string; used_at: string | null }>;
    return Object.freeze(rows.map(row => Object.freeze({
      id: row.feedback_id, pieceId: row.piece_id, version: Number(row.version), reaction: row.reaction as StudyReaction,
      comment: row.comment, createdAt: row.created_at, ...(row.used_at ? { usedAt: row.used_at } : {}),
    })));
  }

  /** Reactions no revising step has been given yet. */
  pendingFeedback(scopeKey: string, id: string): readonly StudyFeedback[] {
    return this.feedback(scopeKey, id).filter(item => !item.usedAt);
  }

  markFeedbackUsed(scopeKey: string, feedbackIds: readonly string[], at: string): void {
    const update = this.database.prepare(`
      UPDATE study_feedback SET used_at = ? WHERE scope_key = ? AND feedback_id = ? AND used_at IS NULL
    `);
    for (const id of feedbackIds) update.run(at, scopeKey, id);
  }

  private appendVersion(scopeKey: string, id: string, version: number, title: string, body: string, changeNote: string, model: string | undefined, at: string): void {
    this.database.prepare(`
      INSERT INTO study_piece_versions (scope_key, piece_id, version, title, body, change_note, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, id, version, title, body, changeNote, model ? model.slice(0, 120) : null, at);
  }
}

function normalizedDraft(draft: StudyDraft): (Required<Pick<StudyDraft, 'kind' | 'title' | 'body' | 'changeNote'>> & { sources: StudySource[]; pursuitId?: string; model?: string }) | null {
  if (!draft || typeof draft !== 'object' || (draft.kind !== 'story' && draft.kind !== 'note')) return null;
  const title = line(draft.title, STUDY_LIMITS.title);
  const body = text(draft.body, draft.kind === 'story' ? STUDY_LIMITS.storyBody : STUDY_LIMITS.noteBody);
  const changeNote = draft.changeNote === undefined ? '' : line(draft.changeNote, STUDY_LIMITS.changeNote);
  const sources = normalizedSources(draft.sources ?? []);
  if (!title || !body || changeNote === null || !sources) return null;
  return {
    kind: draft.kind, title, body, changeNote, sources,
    ...(typeof draft.pursuitId === 'string' && draft.pursuitId ? { pursuitId: draft.pursuitId.slice(0, 80) } : {}),
    ...(typeof draft.model === 'string' && draft.model ? { model: draft.model } : {}),
  };
}

function normalizedSources(sources: readonly StudySource[]): StudySource[] | null {
  if (!Array.isArray(sources) || sources.length > STUDY_LIMITS.sources) return null;
  const result: StudySource[] = [];
  for (const source of sources) {
    const title = line(source?.title, STUDY_LIMITS.sourceTitle);
    const url = typeof source?.url === 'string' ? source.url.trim() : '';
    if (!title || !url || url.length > STUDY_LIMITS.sourceUrl || !/^(?:https?|notion):\/\/\S+$/u.test(url)) return null;
    result.push({ title, url });
  }
  return result;
}

/** One line: whitespace collapsed. */
function line(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

/** Body text: paragraphs are kept, trailing space is not. */
function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/gu, '\n').replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function piece(row: PieceRow): StudyPiece {
  let sources: StudySource[] = [];
  try {
    const parsed: unknown = JSON.parse(row.sources_json);
    if (Array.isArray(parsed)) sources = normalizedSources(parsed as StudySource[]) ?? [];
  } catch { /* an unreadable source list shows as no sources */ }
  return Object.freeze({
    id: row.piece_id,
    kind: row.kind as StudyPieceKind,
    title: row.title,
    body: row.body,
    status: row.status as StudyPieceStatus,
    version: Number(row.version),
    readableVersion: row.readable_version === null ? null : Number(row.readable_version),
    ...(row.pursuit_id ? { pursuitId: row.pursuit_id } : {}),
    sources: Object.freeze(sources),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.shown_at ? { shownAt: row.shown_at } : {}),
    ...(row.put_away_by ? { putAwayBy: row.put_away_by as 'shannon' | 'owner' } : {}),
    ...(row.origin === 'room_look' || row.origin === 'reach_out' ? { origin: row.origin } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  });
}
