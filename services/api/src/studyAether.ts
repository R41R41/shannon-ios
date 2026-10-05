import {
  AetherAccessError, aetherErrorCode, aetherIdempotencyKey, type AetherAccess, type AetherDocument, type AetherWriteResult,
} from './aetherAccess.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
import type { StudyAetherLink } from './studyAetherLinks.js';
import { STUDY_LIMITS, type StudyPiece, type StudyPieceKind } from './studyStore.js';

/**
 * Her study in Aether (Syzygy ADR-0007 and its revision of 2026-10-06, owner decision): her stories are documents tagged
 * 書斎 in 「シャノン用フォルダ」 (`inStudy: true`), her notes documents in that folder without the tag (`inStudy: false`), and
 * Aether holds the canonical text. Present only while Aether is configured (`SHANNON_AETHER_API_URL` and
 * `SHANNON_AETHER_SHANNON_TOKEN`); without it her study is the SQLite study, exactly as before.
 *
 * The order of a write is always the same: first Aether (outside any transaction, with `baseVersion` and an idempotency key),
 * then, in the transaction that records it, her local version and its link (`commit`). A write Aether refused writes nothing
 * here; a stale `baseVersion` brings the newer Aether text in first (`refresh`), so her next try starts from it. The moment
 * Aether takes a write it is noted as pending (`notePending`) and the local commit clears it; a write whose local half was
 * lost is found by the next `sync` and linked as hers (her kind, her change note, within the open-story limit), never read
 * as a change of the owner's. Only a process that stops between Aether's answer and that note leaves a document the sync
 * does not know as hers: a story is then adopted like one the owner put in her study, a note stays a document of her folder.
 *
 * Pieces that have not moved yet (no link) stay in Shannon and are written there; they move only through the migration,
 * after the owner has seen what moves (`studyMigration.ts`). Her notes about a look at the room and what she jotted after an
 * unanswered message never move: they are hers to think with, and with others present her Aether folder may be read.
 */
export const STUDY_AETHER_SYNC = Object.freeze({ refresh: 6, adopt: 5, readCharacters: 100_000 });

export class StudyAether {
  /** Documents seen deleted in Aether, at that version: a deleted piece is not read again until Aether changes it. */
  private readonly seenDeleted = new Map<string, number>();

  constructor(private readonly store: SQLiteAutonomyStore, readonly access: AetherAccess, private readonly now: () => string) {}

  link(scopeKey: string, pieceId: string): StudyAetherLink | null {
    return this.store.study.aether.current(scopeKey, pieceId);
  }

  async create(scopeKey: string, draft: { kind: StudyPieceKind; title: string; body: string; changeNote?: string }, key: string, signal?: AbortSignal): Promise<AetherWriteResult> {
    const written = await this.access.create({ title: draft.title, body: draft.body, inStudy: draft.kind === 'story', idempotencyKey: key }, signal);
    this.store.study.aether.notePending(scopeKey, { documentId: written.documentId, aetherVersion: written.version, operation: 'create', kind: draft.kind, changeNote: draft.changeNote || '最初の稿です。' }, this.now());
    return written;
  }

  /** A new version of a piece that lives in Aether; null for a piece that has not moved (it is written in Shannon only). */
  async update(scopeKey: string, piece: StudyPiece, change: { title?: string; body: string; changeNote?: string }, key: string, signal?: AbortSignal): Promise<AetherWriteResult | null> {
    const link = this.link(scopeKey, piece.id);
    if (!link) return null;
    try {
      const written = await this.access.update({
        documentId: link.documentId, baseVersion: link.aetherVersion, body: change.body,
        ...(change.title !== undefined && change.title !== piece.title ? { title: change.title } : {}), idempotencyKey: key,
      }, signal);
      this.store.study.aether.notePending(scopeKey, { documentId: written.documentId, aetherVersion: written.version, operation: 'update', pieceId: piece.id, changeNote: change.changeNote || '書き直しました。' }, this.now());
      return written;
    } catch (error) {
      // What changed in Aether since is brought in, so that her next try starts from it.
      if (['STALE_VERSION', 'NOT_FOUND'].includes(aetherErrorCode(error))) await this.refresh(scopeKey, piece.id, signal).catch(() => 'unknown');
      throw error;
    }
  }

  /** Into Aether's Recently Deleted (the owner can restore it on his iPhone); null for a piece that has not moved. */
  async remove(scopeKey: string, piece: StudyPiece, key: string, signal?: AbortSignal): Promise<AetherWriteResult | null> {
    const link = this.link(scopeKey, piece.id);
    if (!link) return null;
    try {
      const deleted = await this.access.delete({ documentId: link.documentId, baseVersion: link.aetherVersion, idempotencyKey: key }, signal);
      this.seenDeleted.set(link.documentId, deleted.version);
      return deleted;
    } catch (error) {
      // Gone already: her trash says so too.
      if (aetherErrorCode(error) === 'NOT_FOUND') return { documentId: link.documentId, version: link.aetherVersion };
      if (aetherErrorCode(error) === 'STALE_VERSION') await this.refresh(scopeKey, piece.id, signal).catch(() => 'unknown');
      throw error;
    }
  }

  /** Inside the transaction that records the write: the piece's current version is that Aether version. */
  commit(scopeKey: string, piece: Pick<StudyPiece, 'id' | 'version'>, write: AetherWriteResult): void {
    this.store.study.aether.link(scopeKey, piece.id, piece.version, write.documentId, write.version, this.now());
    this.store.study.aether.nameFeedbackDocument(scopeKey, piece.id, write.documentId);
    this.store.study.aether.clearPending(scopeKey, write.documentId, write.version);
  }

  /**
   * The whole document (in parts of at most 20,000 characters), up to `STUDY_AETHER_SYNC.readCharacters`. A document that is no
   * longer in 「シャノン用フォルダ」 (the owner moved it out) is, for her study, gone exactly like a deleted one: `NOT_FOUND`, and
   * nothing of its text is kept, adopted, or taken out of her trash.
   */
  async readWhole(documentId: string, signal?: AbortSignal): Promise<AetherDocument> {
    let document = await this.access.read({ documentId, offset: 0 }, signal);
    if (!document.inShannonFolder) throw new AetherAccessError('NOT_FOUND');
    let body = document.body;
    let read = [...body].length;
    while (document.hasMore && read < STUDY_AETHER_SYNC.readCharacters) {
      const next = await this.access.read({ documentId, offset: read }, signal);
      if (!next.inShannonFolder) throw new AetherAccessError('NOT_FOUND');
      if (next.version !== document.version || !next.body) throw new AetherAccessError('STALE_VERSION');
      body += next.body;
      read += [...next.body].length;
      document = next;
    }
    return Object.freeze({ ...document, body, bodyOffset: 0, hasMore: document.hasMore });
  }

  /**
   * One piece as Aether has it now: a newer Aether version becomes her next local version; a document deleted there, or
   * moved out of her folder, puts the piece in her trash, and one the owner restored (in her folder) takes it back out.
   */
  async refresh(scopeKey: string, pieceId: string, signal?: AbortSignal): Promise<'current' | 'changed' | 'deleted' | 'unlinked'> {
    const link = this.link(scopeKey, pieceId);
    if (!link) return 'unlinked';
    let document: AetherDocument;
    try { document = await this.readWhole(link.documentId, signal); } catch (error) {
      if (aetherErrorCode(error) !== 'NOT_FOUND') throw error;
      this.store.transaction(() => this.store.study.aether.setDeleted(scopeKey, pieceId, true, this.now()));
      return 'deleted';
    }
    this.seenDeleted.delete(link.documentId);
    const changed = document.version > link.aetherVersion;
    this.store.transaction(() => {
      this.store.study.aether.setDeleted(scopeKey, pieceId, false, this.now());
      // A version she wrote herself whose local half was lost keeps her change note; anything else is a change made in Aether.
      const hers = this.store.study.aether.pending(scopeKey, document.documentId, document.version);
      if (changed) this.store.study.aether.adoptVersion(scopeKey, pieceId, { title: document.title, body: document.body, aetherVersion: document.version, documentId: document.documentId, ...(hers ? { changeNote: hers.changeNote } : {}) }, this.now());
    });
    return changed ? 'changed' : 'current';
  }

  /** Her folder as Aether lists it, against the pieces that live there: what changed, what was deleted, what is new in her study. */
  async sync(scopeKey: string, signal?: AbortSignal): Promise<{ changed: number; deleted: number; adopted: number }> {
    const entries = await this.access.list(signal);
    const listed = new Map(entries.map(entry => [entry.documentId, entry]));
    const links = this.store.study.aether.all(scopeKey);
    const counts = { changed: 0, deleted: 0, adopted: 0 };
    const stale: string[] = [];
    for (const [pieceId, link] of links) {
      const entry = listed.get(link.documentId);
      const piece = this.store.study.find(scopeKey, pieceId, true);
      if (!piece) continue;
      if (!entry) {
        if (!piece.deletedAt) { this.store.transaction(() => this.store.study.aether.setDeleted(scopeKey, pieceId, true, this.now())); counts.deleted += 1; }
        continue;
      }
      if (this.seenDeleted.get(link.documentId) === entry.version) continue;
      if (entry.version > link.aetherVersion || piece.deletedAt) stale.push(pieceId);
    }
    for (const pieceId of stale.slice(0, STUDY_AETHER_SYNC.refresh)) {
      const outcome = await this.refresh(scopeKey, pieceId, signal);
      if (outcome === 'changed') counts.changed += 1;
      if (outcome === 'deleted') {
        counts.deleted += 1;
        const link = this.link(scopeKey, pieceId);
        if (link) this.seenDeleted.set(link.documentId, listed.get(link.documentId)?.version ?? link.aetherVersion);
      }
    }
    // Unknown documents of her folder: a write of hers whose local half was lost (a story or a note), or a story in her study.
    const known = new Set([...links.values()].map(link => link.documentId));
    const hers = (documentId: string) => this.store.study.aether.pendingCreate(scopeKey, documentId);
    for (const entry of entries.filter(item => !known.has(item.documentId) && this.seenDeleted.get(item.documentId) !== item.version
      && (item.inStudy || hers(item.documentId))).slice(0, STUDY_AETHER_SYNC.adopt)) {
      let document: AetherDocument;
      try { document = await this.readWhole(entry.documentId, signal); } catch (error) {
        if (aetherErrorCode(error) === 'NOT_FOUND') { this.seenDeleted.set(entry.documentId, entry.version); continue; }
        throw error;
      }
      const created = hers(document.documentId);
      const kind = created?.kind ?? (document.inStudy ? 'story' as const : null);
      if (!kind || this.store.study.aether.pieceFor(scopeKey, document.documentId)) continue;
      this.store.transaction(() => this.store.study.aether.adoptPiece(scopeKey, {
        documentId: document.documentId, aetherVersion: document.version, title: document.title, body: document.body, kind,
        // Her own note only when the version is the one she wrote; a later change in Aether is the owner's.
        ...(created && document.version === created.aetherVersion ? { changeNote: created.changeNote } : {}),
      }, STUDY_LIMITS.openStories, this.now()));
      counts.adopted += 1;
    }
    return counts;
  }
}

/** The idempotency key of a write of her study: the same write retried is the same key; another write is another key. */
export function studyWriteKey(scopeKey: string, origin: string, ...parts: readonly string[]): string {
  return aetherIdempotencyKey('study', scopeKey, origin, ...parts);
}

/** An Aether call of a loop step, as its result or as a closed reason code (`aether_stale_version` …). */
export async function aetherStep<T>(operation: () => Promise<T>): Promise<{ value: T } | { reasonCode: string }> {
  try { return { value: await operation() }; } catch (error) { return { reasonCode: `aether_${aetherErrorCode(error).toLowerCase()}` }; }
}

/** Sync before a call, within `milliseconds`; false when Aether could not be reached (the caller goes on with what Shannon has). */
export async function syncedWithin(aether: StudyAether, scopeKey: string, milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(Math.max(500, milliseconds));
  try { await aether.sync(scopeKey, signal ? AbortSignal.any([signal, timeout]) : timeout); return true; } catch { return false; }
}
