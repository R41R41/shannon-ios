import { SHANNON_AUTONOMY_SYSTEM_DOMAIN, SHANNON_SEEN_LIMITS, type ShannonOwnWork, type ShannonSeenNote } from '@shannon/cognition';
import { autonomyDayPhrases } from './autonomyDayLog.js';
import { AUTONOMY_REACH_OUT_MEMORY_MAXIMUM, reachOutMemories, reachOutMemoryLine } from './autonomyLoopObservePrompts.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
import { syncedWithin, type StudyAether } from './studyAether.js';
import {
  STUDY_KIND_LABEL, STUDY_REACTION_LABEL, STUDY_STATUS_LABEL,
  type StudyPiece, type StudyPieceKind, type StudyPieceStatus, type StudyReaction, type StudyRejection, type StudySource,
} from './studyStore.js';

/**
 * The owner's side of Shannon's study: reading what she is willing to show, leaving a
 * reaction, and asking her to put a piece away. Nothing here changes her text.
 *
 * A story she has not called 「見せてもいい」 appears only as a card without title or text
 * (「作っているものがあります」). Once a version is readable the owner keeps reading that
 * version while she revises; the newer draft stays hers until she shows it.
 *
 * With Aether configured (Syzygy ADR-0007 revised) the text of a piece that moved is Aether's: the routes first bring in
 * what Aether has (`overviewFresh`, `pieceFresh`), and a card and a reaction name the Aether document and version
 * (`aetherDocumentId`, `aetherVersion`; additive, the apps may ignore them). A piece may be named by its id or its document.
 */
/** What is told after the owner reacted to a story: the piece and the reaction's enum, never his comment. */
export type StudyReactionTap = (scopeKey: string, pieceId: string, reaction: StudyReaction, at: string) => void;

export interface StudyPieceCard {
  id: string;
  kind: StudyPieceKind;
  kindLabel: string;
  status: StudyPieceStatus;
  statusLabel: string;
  /** True while there is nothing she is willing to show: no title, no text. */
  hidden: boolean;
  title: string | null;
  excerpt: string | null;
  /** The version the owner reads. */
  version: number | null;
  /** She is working on a newer version than the one shown. */
  revising: boolean;
  /** A story the owner can read whose readable version they have not reacted to yet. */
  awaitingReaction: boolean;
  updatedAt: string;
  /** While the piece lives in Aether and is readable: its document, and the Aether version of the version the owner reads. */
  aetherDocumentId?: string;
  aetherVersion?: number;
}

export interface StudyPieceDetail extends StudyPieceCard {
  body: string | null;
  sources: readonly StudySource[];
  /** What changed and why, for the versions up to the readable one. */
  versions: readonly { version: number; changeNote: string; createdAt: string }[];
  feedback: readonly { id: string; version: number; reaction: StudyReaction; reactionLabel: string; comment: string; createdAt: string; used: boolean; aetherDocumentId?: string; aetherVersion?: number }[];
  canReact: boolean;
  canPutAway: boolean;
}

export interface StudyOverview {
  pieces: readonly StudyPieceCard[];
  reactions: readonly { id: StudyReaction; label: string }[];
  /** With Aether configured: where the text came from, and whether Aether could be reached just now (additive). */
  source?: { kind: 'aether'; reached: boolean };
}

/** How long a route waits for Aether before it answers from what Shannon has. */
const ROUTE_SYNC_MILLISECONDS = 4_000;
/** A sync that finished this recently serves an app read as it is. */
const ROUTE_FRESH_MILLISECONDS = 2_000;

export class StudyDesk {
  constructor(
    private readonly store: SQLiteAutonomyStore,
    private readonly dayKey: (at: string) => string,
    private readonly now: () => string,
    /** Set while she observes what follows her messages: the owner-local zone for the times in those sentences. */
    private readonly reachOutMemory: { timeZone: string; ownerFirstActiveAfter?: (scopeKey: string, after: string) => string | null } | null = null,
    /** Her study in Aether; null, the SQLite study is the whole study and every answer is what it was. */
    private readonly aether: StudyAether | null = null,
    /** Syzygy ADR-0008 stage 1: told the reaction (its enum, never the comment) once it is stored; null, nothing is told. */
    private readonly reacted: StudyReactionTap | null = null,
  ) {}

  /** Whether this scope's study lives in Aether (one scope only, the owner's). */
  aetherCovers(scopeKey: string): boolean { return this.aether?.covers(scopeKey) ?? false; }

  /** The overview after bringing in what Aether has (or, when it cannot be reached, from what Shannon has, saying so). */
  async overviewFresh(scopeKey: string): Promise<StudyOverview> {
    if (!this.aether?.covers(scopeKey)) return this.overview(scopeKey);
    // An app read accepts a sync that finished a moment ago (several screens open at once share one).
    const reached = await syncedWithin(this.aether, scopeKey, ROUTE_SYNC_MILLISECONDS, undefined, ROUTE_FRESH_MILLISECONDS);
    return Object.freeze({ ...this.overview(scopeKey), source: { kind: 'aether' as const, reached } });
  }

  /** One piece, by its id or its Aether document, after bringing in what Aether has of it. */
  async pieceFresh(scopeKey: string, id: string): Promise<StudyPieceDetail | StudyRejection> {
    const pieceId = this.resolve(scopeKey, id);
    if (this.aether && this.aether.link(scopeKey, pieceId)) {
      try { await this.aether.refresh(scopeKey, pieceId, AbortSignal.timeout(ROUTE_SYNC_MILLISECONDS)); } catch { /* answered from what Shannon has */ }
    }
    return this.piece(scopeKey, pieceId);
  }

  /** A piece's id from its id or its Aether document id. */
  resolve(scopeKey: string, id: string): string {
    return this.store.study.find(scopeKey, id, true) ? id : this.store.study.aether.pieceFor(scopeKey, id) ?? id;
  }

  overview(scopeKey: string): StudyOverview {
    return Object.freeze({
      pieces: Object.freeze(this.store.study.list(scopeKey).map(piece => this.card(scopeKey, piece))),
      reactions: Object.freeze((Object.keys(STUDY_REACTION_LABEL) as StudyReaction[]).map(id => ({ id, label: STUDY_REACTION_LABEL[id] }))),
    });
  }

  piece(scopeKey: string, id: string): StudyPieceDetail | StudyRejection {
    const piece = this.store.study.get(scopeKey, id);
    if (!piece) return 'STUDY_NOT_FOUND';
    const card = this.card(scopeKey, piece);
    const readable = this.readable(scopeKey, piece);
    return Object.freeze({
      ...card,
      body: readable?.body ?? null,
      sources: card.hidden ? [] : piece.sources,
      versions: this.store.study.versions(scopeKey, id).filter(version => piece.readableVersion !== null && version.version <= piece.readableVersion)
        .map(version => ({ version: version.version, changeNote: version.changeNote, createdAt: version.createdAt })),
      feedback: this.store.study.feedback(scopeKey, id).map(item => ({
        id: item.id, version: item.version, reaction: item.reaction, reactionLabel: STUDY_REACTION_LABEL[item.reaction],
        comment: item.comment, createdAt: item.createdAt, used: Boolean(item.usedAt),
        ...(item.aetherDocumentId ? { aetherDocumentId: item.aetherDocumentId } : {}), ...(item.aetherVersion ? { aetherVersion: item.aetherVersion } : {}),
      })),
      canReact: !card.hidden && piece.kind === 'story' && piece.status !== 'put_away',
      canPutAway: piece.status !== 'put_away',
    });
  }

  /** Stored as reader feedback; her next revising step is given it. */
  react(scopeKey: string, id: string, reaction: StudyReaction, comment: string | undefined): StudyPieceDetail | StudyRejection {
    const piece = this.store.study.get(scopeKey, id);
    if (!piece) return 'STUDY_NOT_FOUND';
    if (piece.kind !== 'story' || piece.status === 'put_away') return 'STUDY_CLOSED';
    const at = this.now();
    const result = this.store.transaction(() => {
      const feedback = this.store.study.addFeedback(scopeKey, id, { reaction, comment }, at);
      if (typeof feedback === 'string') return feedback;
      this.record(scopeKey, at, `所有者が「${clip(this.readable(scopeKey, piece)?.title ?? piece.title, 60)}」に感想を残しました（${STUDY_REACTION_LABEL[reaction]}）。`, id);
      return null;
    });
    if (result === null) { try { this.reacted?.(scopeKey, piece.id, reaction, at); } catch { /* never fails a reaction */ } }
    return result ?? this.piece(scopeKey, id);
  }

  /** The owner asks her to put a piece away. The text and its versions stay. */
  putAway(scopeKey: string, id: string): StudyPieceDetail | StudyRejection {
    const piece = this.store.study.get(scopeKey, id);
    if (!piece) return 'STUDY_NOT_FOUND';
    if (piece.status !== 'put_away') {
      const at = this.now();
      this.store.transaction(() => {
        this.store.study.putAway(scopeKey, id, 'owner', at);
        const readable = this.readable(scopeKey, piece);
        this.record(scopeKey, at, readable ? `所有者が「${clip(readable.title, 60)}」をしまうよう伝えました。` : '所有者が、作っているものを1つしまうよう伝えました。', id);
      });
    }
    return this.piece(scopeKey, id);
  }

  /**
   * What she is working on, for her prompt in a conversation with the owner alone: stages and titles, never any text.
   * Owner decision 2026-10-05: an unshown draft's title is hers to know (marked unshown); his screens still never show it.
   */
  ownWork(scopeKey: string, at: string): ShannonOwnWork | null {
    const today = this.store.activity.days(scopeKey, { sinceDayKey: this.dayKey(at) }).find(day => day.dayKey === this.dayKey(at));
    const stories = this.store.study.list(scopeKey).filter(piece => piece.kind === 'story' && piece.status !== 'put_away').slice(0, 3);
    const pieces = stories.map(piece => {
      const readable = this.readable(scopeKey, piece);
      const stage = piece.status === 'draft' ? `下書き・第${piece.version}稿${readable ? '（見せた稿を直している途中）' : ''}`
        : piece.status === 'ready' ? `第${piece.version}稿・見せてもいい（まだ知らせていない）` : `第${piece.version}稿・見せた`;
      return readable ? { title: readable.title, stage } : { title: piece.title, stage, unshown: true };
    });
    const phrases = autonomyDayPhrases(today?.entries ?? []);
    const reachOuts = this.reachOuts(scopeKey, at);
    return phrases.length || pieces.length || reachOuts.length ? { today: phrases, pieces, ...(reachOuts.length ? { reachOuts } : {}) } : null;
  }

  /**
   * What followed the messages she started on her own today, newest first, as sentences of facts from her
   * observations: when, whether an answer came while she waited, what her body reported, what she did then.
   * Empty while the mechanism is switched off. No words of hers or of the owner's are in an observation.
   */
  private reachOuts(scopeKey: string, at: string): readonly string[] {
    const memory = this.reachOutMemory;
    if (!memory) return [];
    try {
      const since = new Date(Date.parse(at) - 24 * 60 * 60_000).toISOString();
      return reachOutMemories(this.store.loop.observations.since(scopeKey, since))
        .filter(item => this.dayKey(item.facts.sentAt) === this.dayKey(at))
        .slice(0, AUTONOMY_REACH_OUT_MEMORY_MAXIMUM).map(item => {
          if (item.facts.replied || !memory.ownerFirstActiveAfter) return reachOutMemoryLine(item, memory.timeZone);
          // He wrote or spoke after her wait ended. The last two minutes are left out: that is the conversation this prompt is for.
          const waitedUntil = new Date(Date.parse(item.facts.sentAt) + item.facts.waitedSeconds * 1_000).toISOString();
          const first = memory.ownerFirstActiveAfter(scopeKey, waitedUntil);
          return reachOutMemoryLine({ ...item, repliedSince: first !== null && Date.parse(first) < Date.parse(at) - 120_000 }, memory.timeZone);
        });
    } catch { return []; }
  }

  /**
   * Her recent notes about a look at the room, newest first, for a conversation the owner is part of:
   * at most three, from the last seven days, none she or the owner put away.
   */
  seen(scopeKey: string, at: string): readonly ShannonSeenNote[] {
    const since = Date.parse(at) - SHANNON_SEEN_LIMITS.days * 24 * 60 * 60_000;
    return this.store.study.list(scopeKey)
      .filter(piece => piece.origin === 'room_look' && piece.status !== 'put_away' && Date.parse(piece.createdAt) >= since)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, SHANNON_SEEN_LIMITS.notes)
      // The title is written by the step as 「見たこと（10月2日 10時）」; the time in it is the owner-local hour of the look.
      .map(piece => ({ when: /^見たこと（(.+)）$/u.exec(piece.title)?.[1] ?? piece.createdAt.slice(0, 10), text: piece.body }));
  }

  private card(scopeKey: string, piece: StudyPiece): StudyPieceCard {
    const readable = this.readable(scopeKey, piece);
    const revising = readable !== null && piece.readableVersion !== piece.version && piece.status === 'draft';
    // Named only while he can read it: a hidden card stays without anything that names what she is writing.
    const linked = readable && piece.readableVersion !== null ? this.store.study.aether.current(scopeKey, piece.id) : null;
    const readableLink = linked && piece.readableVersion !== null ? this.store.study.aether.forVersion(scopeKey, piece.id, piece.readableVersion) : null;
    return Object.freeze({
      id: piece.id, kind: piece.kind, kindLabel: STUDY_KIND_LABEL[piece.kind], status: piece.status,
      // While she revises, the owner still reads the version she showed.
      statusLabel: revising ? `${STUDY_STATUS_LABEL[piece.shownAt ? 'shown' : 'ready']}（直しています）` : STUDY_STATUS_LABEL[piece.status],
      hidden: readable === null, title: readable?.title ?? null,
      excerpt: readable ? clip(readable.body, 90) : null,
      version: readable ? piece.readableVersion : null,
      revising,
      // A readable story whose readable version has no reaction from the owner yet.
      awaitingReaction: readable !== null && piece.kind === 'story' && piece.status !== 'put_away'
        && !this.store.study.feedback(scopeKey, piece.id).some(item => item.version === piece.readableVersion),
      updatedAt: piece.updatedAt,
      ...(linked ? { aetherDocumentId: linked.documentId, ...(readableLink ? { aetherVersion: readableLink.aetherVersion } : {}) } : {}),
    });
  }

  /** The version she called 「見せてもいい」, or null while there is none. */
  private readable(scopeKey: string, piece: StudyPiece): { title: string; body: string } | null {
    if (piece.readableVersion === null) return null;
    if (piece.readableVersion === piece.version) return { title: piece.title, body: piece.body };
    const version = this.store.study.versions(scopeKey, piece.id).find(item => item.version === piece.readableVersion);
    return version ? { title: version.title, body: version.body } : null;
  }

  private record(scopeKey: string, at: string, summary: string, pieceId: string): void {
    this.store.activity.append(scopeKey, this.dayKey(at), at, {
      kind: 'control', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id, summary,
      outcome: 'recorded', approval: 'not_needed', link: `shannon-study://${pieceId}`,
    });
  }
}

function clip(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}
