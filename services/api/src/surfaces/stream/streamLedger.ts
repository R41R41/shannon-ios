import { createHash } from 'node:crypto';
import { commentDigest, commentTags, harassmentLadder, type CommentTag } from '@shannon/cognition';
import {
  STREAM_LIMITS, type IncomingComment, type StreamCommentKind, type StreamCommentRole, type StreamCommentStatus,
} from './streamContract.js';

/**
 * The words of one stream (`docs/stream-contract.md` §0): every comment the ear brought, with its closed reading (tags, a digest, whether it
 * is a question, a name call, a reaction) and where it stands (`status`). Kept in memory for the stream only and dropped at its end (`clear`);
 * nothing here is stored. The chooser (`streamChooser.ts`) reads this and nothing else.
 */
export interface CommentRecord {
  commentId: string;
  authorId: string;
  authorName: string;
  /** A digest of the viewer's account (never the account), the key of her feeling toward them across streams. */
  viewer: string;
  text: string;
  kind: StreamCommentKind;
  amountDisplay: string | null;
  roles: readonly StreamCommentRole[];
  publishedMs: number;
  receivedMs: number;
  status: StreamCommentStatus;
  tags: CommentTag[];
  digest: string;
  question: boolean;
  named: boolean;
  /** Short reactions (「w」「草」「888」) are folded into the crowd and never answered alone. */
  reaction: boolean;
  /** The viewer's first comment of this stream. */
  first: boolean;
  /** Times it was taken up for an answer and given back (a writer that failed or left it out). */
  attempts: number;
  /** When the line that answers it was made, and when its first sound played (the desktop's `startedAt`). */
  lineAtMs?: number;
  soundAtMs?: number;
}

const NAME = /シャノン|しゃのん|shannon/iu;
const QUESTION = /[?？]|(?:です|ます|でした|ました|だっけ|かな|かも|の|ん|っけ)か[。!！ー〜~]*$|教えて|どうして|なんで|なぜ|どっち|どれ|いつ|どこ|だれ|誰/u;
const REACTION = /^(?:[wｗWＷ草笑８8]+|lol|www+|[!！?？。、.…ー〜~・]+|(?:\p{Extended_Pictographic}|\u200d|\ufe0f)+)$/iu;

export function isQuestion(text: string): boolean { return QUESTION.test(text.normalize('NFKC').trim()); }
export function isNamed(text: string): boolean { return NAME.test(text.normalize('NFKC')); }

/** 「w」「ｗｗｗ」「草」「888」「！」and a run of emoji: a reaction of the crowd, not a thing to answer. */
export function isReaction(text: string): boolean {
  const plain = text.normalize('NFKC').replace(/\s+/gu, '');
  return plain.length === 0 || (Array.from(plain).length <= 12 && REACTION.test(plain));
}

export function viewerDigest(authorId: string, salt = 'stream'): string {
  return createHash('sha256').update(`stream-viewer\u0000${salt}\u0000${authorId}`).digest('hex').slice(0, 12);
}

/** A control character or a line break in a viewer's words or name is a space; the name is cut short. */
const plain = (value: string, limit: number): string =>
  Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');

export const PAID_KINDS: ReadonlySet<StreamCommentKind> = new Set(['superchat', 'supersticker', 'membership', 'gift']);

export class StreamLedger {
  private readonly records = new Map<string, CommentRecord>();
  private readonly order: string[] = [];
  private readonly seenViewers = new Set<string>();
  private readonly ignoredAuthors = new Set<string>();
  private readonly hurtful = new Map<string, number>();
  private readonly answeredAt = new Map<string, number>();
  private readonly reactionTimes: number[] = [];
  /** Counts for the summary, kept apart from the records so that the records may be dropped past their limit. */
  private total = 0;
  private duplicates = 0;

  constructor(private readonly salt = 'stream') {}

  /** One comment from the ear. Repeated ids are ignored; returns the record, or null for a repeat. */
  add(incoming: IncomingComment, nowMs: number): CommentRecord | null {
    if (this.records.has(incoming.id)) {
      this.duplicates += 1;
      return null;
    }
    const record = this.read(incoming, nowMs);
    this.seenViewers.add(incoming.authorId);
    if (this.seenViewers.size > 20_000) this.seenViewers.clear();
    if (record.tags.length) this.hurtful.set(incoming.authorId, (this.hurtful.get(incoming.authorId) ?? 0) + 1);
    if (record.reaction) {
      this.reactionTimes.push(nowMs);
      if (this.reactionTimes.length > 400) this.reactionTimes.shift();
    }
    // The console shows every comment; one the stream has already left behind, a viewer she ignores and a crowd's reaction are never answered.
    if (this.ignoredAuthors.has(incoming.authorId)) record.status = 'ignored';
    else if (nowMs - record.publishedMs > STREAM_LIMITS.staleCommentMilliseconds || record.reaction) record.status = 'skipped';
    this.records.set(record.commentId, record);
    this.order.push(record.commentId);
    this.total += 1;
    while (this.order.length > STREAM_LIMITS.keptComments) this.records.delete(this.order.shift()!);
    return record;
  }

  /** The closed reading of a comment: its tags and digest, whether it is a question, a name call or a reaction. */
  private read(incoming: IncomingComment, nowMs: number): CommentRecord {
    const text = plain(incoming.text, STREAM_LIMITS.commentCharacters);
    const published = Date.parse(incoming.publishedAt);
    const tags = commentTags(text);
    return {
      commentId: incoming.id, authorId: incoming.authorId, authorName: plain(incoming.authorName, 40) || 'みなさん',
      viewer: viewerDigest(incoming.authorId, this.salt), text, kind: incoming.kind,
      amountDisplay: incoming.amount ? plain(incoming.amount.display, 20) : null, roles: incoming.roles,
      publishedMs: Number.isFinite(published) ? Math.min(published, nowMs) : nowMs, receivedMs: nowMs, status: 'new', tags, digest: commentDigest(text),
      question: isQuestion(text), named: isNamed(text), reaction: isReaction(text) && !tags.length && !PAID_KINDS.has(incoming.kind),
      first: !this.seenViewers.has(incoming.authorId), attempts: 0,
    };
  }

  get(commentId: string): CommentRecord | undefined { return this.records.get(commentId); }
  all(): CommentRecord[] { return this.order.map(id => this.records.get(id)!).filter(Boolean); }
  count(): number { return this.total; }
  duplicateCount(): number { return this.duplicates; }

  /** How many of this viewer's comments in this stream carried a closed tag of hurt (the ladder's count). */
  hurtfulCount(authorId: string): number { return this.hurtful.get(authorId) ?? 0; }

  /** Whether this comment needs the safety floor (a threat, prying into the owner's life, repeated lewd words): answered first. */
  needsFloor(record: CommentRecord): boolean {
    return harassmentLadder({ hurtful: this.hurtfulCount(record.authorId), level: 0, tags: record.tags }).floor;
  }

  ignore(authorId: string): CommentRecord[] {
    this.ignoredAuthors.add(authorId);
    const dropped: CommentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.authorId === authorId && (record.status === 'new' || record.status === 'picked')) {
        record.status = 'ignored';
        dropped.push(record);
      }
    }
    return dropped;
  }
  isIgnored(authorId: string): boolean { return this.ignoredAuthors.has(authorId); }

  answeredRecently(authorId: string, nowMs: number): boolean {
    const at = this.answeredAt.get(authorId);
    return at !== undefined && nowMs - at <= STREAM_LIMITS.sameViewerMilliseconds;
  }
  noteAnswered(authorId: string, nowMs: number): void { this.answeredAt.set(authorId, nowMs); }

  /** Reactions of the crowd in the last `windowMs`, for her to feel the room (「草」が流れている). */
  crowdReactions(nowMs: number, windowMs = 30_000): number { return this.reactionTimes.filter(at => nowMs - at <= windowMs).length; }

  /** Comments waiting past their time are given up (`skipped`); returns them. */
  expire(nowMs: number): CommentRecord[] {
    const gone: CommentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== 'new') continue;
      const window = PAID_KINDS.has(record.kind) ? STREAM_LIMITS.paidCandidateMilliseconds : STREAM_LIMITS.candidateMilliseconds;
      if (nowMs - record.publishedMs > window) {
        record.status = 'skipped';
        gone.push(record);
      }
    }
    return gone;
  }

  countBy(status: StreamCommentStatus): number {
    let count = 0;
    for (const record of this.records.values()) if (record.status === status) count += 1;
    return count;
  }

  /** The console's list: the newest comments. */
  view(limit = STREAM_LIMITS.consoleComments) {
    return this.all().slice(-limit).map(record => ({
      commentId: record.commentId, authorName: record.authorName, text: record.text, kind: record.kind,
      at: new Date(record.publishedMs).toISOString(), status: record.status, tags: [...record.tags],
    }));
  }

  /** The stream is over: every word goes. */
  clear(): void {
    this.records.clear();
    this.order.length = 0;
    this.seenViewers.clear();
    this.ignoredAuthors.clear();
    this.hurtful.clear();
    this.answeredAt.clear();
    this.reactionTimes.length = 0;
  }
}
