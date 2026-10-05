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
export const STUDY_AETHER_SYNC = Object.freeze({ refresh: 6, adopt: 5, readCharacters: 100_000, runMilliseconds: 15_000 });

/** A write of hers this recent is still committing in its own transaction: a sync leaves its document and version to it. */
export const STUDY_AETHER_PENDING_FRESH_MILLISECONDS = 2 * 60_000;

export interface StudyAetherSyncCounts {
  changed: number; deleted: number; adopted: number;
  /** Documents left as they were, with a closed code (`too_long`: longer than Shannon reads whole). */
  skipped?: readonly { documentId: string; code: 'too_long' }[];
}

export class StudyAether {
  /** Documents seen deleted in Aether, at that version: a deleted piece is not read again until Aether changes it. */
  private readonly seenDeleted = new Map<string, number>();
  /** At most one sync per scope at a time in this process: callers that come while one runs share it. */
  private readonly running = new Map<string, Promise<StudyAetherSyncCounts>>();
  /** When the last sync of a scope finished (this process's clock), for a caller that accepts a recent one. */
  private readonly finished = new Map<string, number>();

  constructor(
    private readonly store: SQLiteAutonomyStore, readonly access: AetherAccess, private readonly now: () => string,
    /** The one scope whose study lives in Aether (`aetherStudyScope`, the owner's); every other scope keeps the SQLite study. */
    readonly scopeKey = 'owner',
  ) {}

  /** Whether this scope's study lives in Aether. Nothing here reads, writes or adopts for any other scope. */
  covers(scopeKey: string): boolean {
    return scopeKey === this.scopeKey;
  }

  link(scopeKey: string, pieceId: string): StudyAetherLink | null {
    return this.covers(scopeKey) ? this.store.study.aether.current(scopeKey, pieceId) : null;
  }

  async create(scopeKey: string, draft: { kind: StudyPieceKind; title: string; body: string; changeNote?: string }, key: string, signal?: AbortSignal): Promise<AetherWriteResult> {
    if (!this.covers(scopeKey)) throw new AetherAccessError('INVALID_REQUEST');
    const written = await this.access.create({ title: draft.title, body: draft.body, inStudy: draft.kind === 'story', idempotencyKey: key }, signal);
    this.store.study.aether.notePending(scopeKey, { documentId: written.documentId, aetherVersion: written.version, operation: 'create', kind: draft.kind, changeNote: draft.changeNote || '最初の稿です。' }, this.now());
    return written;
  }

  /** A new version of a piece that lives in Aether; null for a piece that has not moved (it is written in Shannon only). */
  async update(scopeKey: string, piece: StudyPiece, change: { title?: string; body: string; changeNote?: string }, key: string, signal?: AbortSignal): Promise<AetherWriteResult | null> {
    const link = this.link(scopeKey, piece.id);
    if (!link) return null;
    // Its document is longer than Shannon reads whole: a whole-body write from her shorter copy would cut it.
    if (this.store.study.aether.tooLongPiece(scopeKey, piece.id)) throw new AetherAccessError('TOO_LONG');
    try {
      const written = await this.access.update({
        documentId: link.documentId, baseVersion: link.aetherVersion, body: change.body,
        ...(change.title !== undefined && change.title !== piece.title ? { title: change.title } : {}), idempotencyKey: key,
      }, signal);
      this.store.study.aether.notePending(scopeKey, { documentId: written.documentId, aetherVersion: written.version, operation: 'update', pieceId: piece.id, changeNote: change.changeNote || '書き直しました。' }, this.now());
      return written;
    } catch (error) {
      // Moved out of her folder by the owner: gone for her study, like a deleted document (her trash; nothing adopted, no retry).
      if (aetherErrorCode(error) === 'OUTSIDE_SHANNON_FOLDER') this.gone(scopeKey, piece.id);
      // What changed in Aether since is brought in, so that her next try starts from it; one too long to read whole is said so plainly.
      if (['STALE_VERSION', 'NOT_FOUND'].includes(aetherErrorCode(error))) {
        if (await this.refresh(scopeKey, piece.id, signal).catch(() => 'unknown') === 'too_long') throw new AetherAccessError('TOO_LONG');
      }
      throw error;
    }
  }

  private tooLong(scopeKey: string, documentId: string, version: number, pieceId: string | null, skipped: { documentId: string; code: 'too_long' }[]): void {
    this.store.study.aether.noteTooLong(scopeKey, documentId, version, pieceId, this.now());
    skipped.push({ documentId, code: 'too_long' });
  }

  private fresh(createdAt: string | undefined): boolean {
    return createdAt !== undefined && Date.parse(this.now()) - Date.parse(createdAt) < STUDY_AETHER_PENDING_FRESH_MILLISECONDS;
  }

  /**
   * She changed a document of her study through her Aether folder tools (`aetherFolder.update`): the new version is taken in
   * at once as hers, with her change note, never as a change of the owner's. Nothing for a document that is no piece of hers.
   */
  async adoptOwnWrite(scopeKey: string, write: AetherWriteResult, changeNote: string, signal?: AbortSignal): Promise<void> {
    const pieceId = this.covers(scopeKey) ? this.store.study.aether.pieceFor(scopeKey, write.documentId) : null;
    if (!pieceId) return;
    // Noted first: should the read below fail, a later sync still takes it in as hers.
    this.store.study.aether.notePending(scopeKey, { documentId: write.documentId, aetherVersion: write.version, operation: 'update', pieceId, changeNote }, this.now());
    let document: AetherDocument;
    try { document = await this.readWhole(write.documentId, signal); } catch (error) {
      // Too long to read whole: nothing is taken in, so nothing is left waiting; the document is noted as too long instead.
      if (aetherErrorCode(error) === 'TOO_LONG') {
        this.store.transaction(() => {
          this.store.study.aether.clearPending(scopeKey, write.documentId, write.version);
          this.store.study.aether.noteTooLong(scopeKey, write.documentId, (error as AetherAccessError).version ?? write.version, pieceId, this.now());
        });
      }
      throw error;
    }
    // Read whole: a document her write made short enough again is no longer too long.
    this.store.study.aether.clearTooLong(scopeKey, write.documentId);
    if (document.version !== write.version) return;
    this.store.transaction(() => {
      const linked = this.link(scopeKey, pieceId);
      if (!linked || linked.aetherVersion >= write.version) return;
      this.store.study.aether.adoptVersion(scopeKey, pieceId, { title: document.title, body: document.body, aetherVersion: write.version, documentId: write.documentId, changeNote }, this.now());
    });
  }

  /** A piece whose document is gone from her folder: into her trash, and not read again until Aether changes it. */
  private gone(scopeKey: string, pieceId: string): void {
    // No version memory is needed: a document outside her folder is not listed, so a sync never reads it again.
    this.store.transaction(() => this.store.study.aether.setDeleted(scopeKey, pieceId, true, this.now()));
  }

  /** Into Aether's Recently Deleted (the owner can restore it on his iPhone); null for a piece that has not moved. */
  async remove(scopeKey: string, piece: StudyPiece, key: string, signal?: AbortSignal): Promise<AetherWriteResult | null> {
    const link = this.link(scopeKey, piece.id);
    if (!link) return null;
    try {
      const deleted = await this.access.delete({ documentId: link.documentId, baseVersion: link.aetherVersion, idempotencyKey: key }, signal);
      this.seenDeleted.set(link.documentId, deleted.version);
      this.store.study.aether.noteDeleted(scopeKey, piece.id, link.documentId, this.now());
      return deleted;
    } catch (error) {
      // Gone already, or moved out of her folder by the owner: her trash says so too, and Aether is left as it is.
      if (aetherErrorCode(error) === 'NOT_FOUND' || aetherErrorCode(error) === 'OUTSIDE_SHANNON_FOLDER') {
        this.store.study.aether.noteDeleted(scopeKey, piece.id, link.documentId, this.now());
        return { documentId: link.documentId, version: link.aetherVersion };
      }
      if (aetherErrorCode(error) === 'STALE_VERSION') await this.refresh(scopeKey, piece.id, signal).catch(() => 'unknown');
      throw error;
    }
  }

  /**
   * Inside the transaction that records the write: the piece's current version is that Aether version. Should a sync have
   * taken the write in meanwhile (the document is another piece's, or this piece already has that version), the commit
   * throws `STUDY_AETHER_LINKED` and the transaction leaves no second piece and no second version.
   */
  commit(scopeKey: string, piece: Pick<StudyPiece, 'id' | 'version'>, write: AetherWriteResult): void {
    const owner = this.store.study.aether.pieceFor(scopeKey, write.documentId);
    const linked = this.link(scopeKey, piece.id);
    if ((owner && owner !== piece.id) || (linked && linked.version < piece.version && linked.documentId === write.documentId && linked.aetherVersion >= write.version)) {
      throw new Error('STUDY_AETHER_LINKED');
    }
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
    // A body cut at what Shannon reads is never adopted: a later whole-body update from it would overwrite the longer document.
    if (document.hasMore) throw new AetherAccessError('TOO_LONG', document.version);
    return Object.freeze({ ...document, body, bodyOffset: 0, hasMore: false });
  }

  /**
   * One piece as Aether has it now: a newer Aether version becomes her next local version; a document deleted there, or
   * moved out of her folder, puts the piece in her trash, and one the owner restored (in her folder) takes it back out.
   */
  async refresh(scopeKey: string, pieceId: string, signal?: AbortSignal): Promise<'current' | 'changed' | 'deleted' | 'unlinked' | 'too_long'> {
    const link = this.link(scopeKey, pieceId);
    if (!link) return 'unlinked';
    let document: AetherDocument;
    try { document = await this.readWhole(link.documentId, signal); } catch (error) {
      // Too long to read whole: left as Shannon has it, and noted (her writes to it are refused, her own time does not revise it).
      if (aetherErrorCode(error) === 'TOO_LONG') {
        this.store.study.aether.noteTooLong(scopeKey, link.documentId, (error as AetherAccessError).version ?? link.aetherVersion, pieceId, this.now());
        return 'too_long';
      }
      if (aetherErrorCode(error) !== 'NOT_FOUND') throw error;
      this.store.transaction(() => this.store.study.aether.setDeleted(scopeKey, pieceId, true, this.now()));
      return 'deleted';
    }
    this.seenDeleted.delete(link.documentId);
    this.store.study.aether.clearTooLong(scopeKey, link.documentId);
    return this.store.transaction(() => {
      this.store.study.aether.setDeleted(scopeKey, pieceId, false, this.now());
      // Read the link again inside the transaction: a write of hers or another refresh may have linked this version meanwhile.
      const now = this.link(scopeKey, pieceId);
      if (!now || now.aetherVersion >= document.version) return 'current' as const;
      // A version she wrote herself whose local half was lost keeps her change note; anything else is a change made in Aether.
      const hers = this.store.study.aether.pending(scopeKey, document.documentId, document.version);
      // One she wrote a moment ago is still committing in its own transaction: it links itself.
      if (hers && this.fresh(hers.createdAt)) return 'current' as const;
      this.store.study.aether.adoptVersion(scopeKey, pieceId, { title: document.title, body: document.body, aetherVersion: document.version, documentId: document.documentId, ...(hers ? { changeNote: hers.changeNote } : {}) }, this.now());
      return 'changed' as const;
    });
  }

  /**
   * Her folder as Aether lists it, against the pieces that live there: what changed, what was deleted, what is new in her
   * study. One run per scope at a time (callers share it; each stops waiting at its own signal, the run goes on for the next);
   * `maxAgeMilliseconds` accepts a run that finished that recently instead of starting another (the app's reads).
   */
  sync(scopeKey: string, signal?: AbortSignal, options: { maxAgeMilliseconds?: number } = {}): Promise<StudyAetherSyncCounts> {
    if (!this.covers(scopeKey)) return Promise.resolve({ changed: 0, deleted: 0, adopted: 0 });
    const finished = this.finished.get(scopeKey);
    if (options.maxAgeMilliseconds && finished !== undefined && Date.now() - finished < options.maxAgeMilliseconds) return Promise.resolve({ changed: 0, deleted: 0, adopted: 0 });
    let run = this.running.get(scopeKey);
    if (!run) {
      run = this.syncOnce(scopeKey, AbortSignal.timeout(STUDY_AETHER_SYNC.runMilliseconds));
      this.running.set(scopeKey, run);
      run.then(() => this.finished.set(scopeKey, Date.now()), () => undefined).finally(() => this.running.delete(scopeKey));
    }
    return signal ? untilAborted(run, signal) : run;
  }

  private async syncOnce(scopeKey: string, signal: AbortSignal): Promise<StudyAetherSyncCounts> {
    const entries = await this.access.list(signal);
    const listed = new Map(entries.map(entry => [entry.documentId, entry]));
    const links = this.store.study.aether.all(scopeKey);
    const counts = { changed: 0, deleted: 0, adopted: 0 };
    const skipped: { documentId: string; code: 'too_long' }[] = [];
    const stale: string[] = [];
    for (const [pieceId, link] of links) {
      const entry = listed.get(link.documentId);
      const piece = this.store.study.find(scopeKey, pieceId, true);
      if (!piece) continue;
      if (!entry) {
        if (!piece.deletedAt) { this.store.transaction(() => this.store.study.aether.setDeleted(scopeKey, pieceId, true, this.now())); counts.deleted += 1; }
        continue;
      }
      if (this.seenDeleted.get(link.documentId) === entry.version || this.store.study.aether.tooLongVersion(scopeKey, link.documentId) === entry.version) continue;
      if (entry.version > link.aetherVersion || piece.deletedAt) stale.push(pieceId);
    }
    for (const pieceId of stale.slice(0, STUDY_AETHER_SYNC.refresh)) {
      const outcome = await this.refresh(scopeKey, pieceId, signal);
      if (outcome === 'changed') counts.changed += 1;
      if (outcome === 'too_long') skipped.push({ documentId: this.link(scopeKey, pieceId)!.documentId, code: 'too_long' });
      if (outcome === 'deleted') {
        counts.deleted += 1;
        const link = this.link(scopeKey, pieceId);
        if (link) this.seenDeleted.set(link.documentId, listed.get(link.documentId)?.version ?? link.aetherVersion);
      }
    }
    // Unknown documents of her folder: a write of hers whose local half was lost (a story or a note), or a story in her study.
    const known = new Set([...links.values()].map(link => link.documentId));
    const hers = (documentId: string) => this.store.study.aether.pendingCreate(scopeKey, documentId);
    // A create of hers that is still committing (fresh) is left to its own transaction.
    for (const entry of entries.filter(item => !known.has(item.documentId) && this.seenDeleted.get(item.documentId) !== item.version && this.store.study.aether.tooLongVersion(scopeKey, item.documentId) !== item.version
      && (item.inStudy || hers(item.documentId)) && !this.fresh(hers(item.documentId)?.createdAt)).slice(0, STUDY_AETHER_SYNC.adopt)) {
      let document: AetherDocument;
      try { document = await this.readWhole(entry.documentId, signal); } catch (error) {
        if (aetherErrorCode(error) === 'NOT_FOUND') { this.seenDeleted.set(entry.documentId, entry.version); continue; }
        if (aetherErrorCode(error) === 'TOO_LONG') { this.tooLong(scopeKey, entry.documentId, entry.version, null, skipped); continue; }
        throw error;
      }
      const created = hers(document.documentId);
      const kind = created?.kind ?? (document.inStudy ? 'story' as const : null);
      if (!kind) continue;
      // Checked again inside the transaction: a write of hers may have linked it while it was being read.
      const adopted = this.store.transaction(() => !this.store.study.aether.pieceFor(scopeKey, document.documentId) && Boolean(this.store.study.aether.adoptPiece(scopeKey, {
        documentId: document.documentId, aetherVersion: document.version, title: document.title, body: document.body, kind,
        // Her own note only when the version is the one she wrote; a later change in Aether is the owner's.
        ...(created && document.version === created.aetherVersion ? { changeNote: created.changeNote } : {}),
      }, STUDY_LIMITS.openStories, this.now())));
      if (adopted) counts.adopted += 1;
    }
    return skipped.length ? { ...counts, skipped: Object.freeze(skipped) } : counts;
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
export async function syncedWithin(aether: StudyAether, scopeKey: string, milliseconds: number, signal?: AbortSignal, maxAgeMilliseconds = 0): Promise<boolean> {
  const timeout = AbortSignal.timeout(Math.max(500, milliseconds));
  try { await aether.sync(scopeKey, signal ? AbortSignal.any([signal, timeout]) : timeout, { maxAgeMilliseconds }); return true; } catch { return false; }
}

/** A shared run as one caller waits for it: that caller stops at its own signal; the run itself goes on. */
function untilAborted<T>(run: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AetherAccessError('TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new AetherAccessError('TIMEOUT'));
    signal.addEventListener('abort', stop, { once: true });
    run.then(value => { signal.removeEventListener('abort', stop); resolve(value); }, (error: unknown) => { signal.removeEventListener('abort', stop); reject(error); });
  });
}
