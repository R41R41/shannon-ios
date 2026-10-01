import { SHANNON_AUTONOMY_SYSTEM_DOMAIN, type ShannonOwnWork } from '@shannon/cognition';
import { autonomyDayPhrases } from './autonomyDayLog.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
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
 */
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
}

export interface StudyPieceDetail extends StudyPieceCard {
  body: string | null;
  sources: readonly StudySource[];
  /** What changed and why, for the versions up to the readable one. */
  versions: readonly { version: number; changeNote: string; createdAt: string }[];
  feedback: readonly { id: string; version: number; reaction: StudyReaction; reactionLabel: string; comment: string; createdAt: string; used: boolean }[];
  canReact: boolean;
  canPutAway: boolean;
}

export interface StudyOverview {
  pieces: readonly StudyPieceCard[];
  reactions: readonly { id: StudyReaction; label: string }[];
}

export class StudyDesk {
  constructor(
    private readonly store: SQLiteAutonomyStore,
    private readonly dayKey: (at: string) => string,
    private readonly now: () => string,
  ) {}

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

  /** What she is working on, for the owner's own prompt: stages and shown titles, never an unshown title or any text. */
  ownWork(scopeKey: string, at: string): ShannonOwnWork | null {
    const today = this.store.activity.days(scopeKey, { sinceDayKey: this.dayKey(at) }).find(day => day.dayKey === this.dayKey(at));
    const stories = this.store.study.list(scopeKey).filter(piece => piece.kind === 'story' && piece.status !== 'put_away').slice(0, 3);
    const pieces = stories.map(piece => {
      const readable = this.readable(scopeKey, piece);
      const stage = piece.status === 'draft' ? `下書き・第${piece.version}稿${readable ? '（見せた稿を直している途中）' : ''}`
        : piece.status === 'ready' ? `第${piece.version}稿・見せてもいい（まだ知らせていない）` : `第${piece.version}稿・見せた`;
      return { ...(readable ? { title: readable.title } : {}), stage };
    });
    const phrases = autonomyDayPhrases(today?.entries ?? []);
    return phrases.length || pieces.length ? { today: phrases, pieces } : null;
  }

  private card(scopeKey: string, piece: StudyPiece): StudyPieceCard {
    const readable = this.readable(scopeKey, piece);
    const revising = readable !== null && piece.readableVersion !== piece.version && piece.status === 'draft';
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
