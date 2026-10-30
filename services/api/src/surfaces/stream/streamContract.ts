import type { ProgramInput, ProgramLayout, ProgramView } from './streamProgram.js';
import type { ShannonEmotionKind } from '@shannon/cognition';

/**
 * The wire of the YouTube stream (owner 2026-10-29, `docs/stream-contract.md`): the ear (the legacy runtime, bridge token) brings the chat in,
 * the head's stream place chooses, gates and writes, and her mouth (the desktop, paired device) is handed one line at a time. Types and
 * limits only; nothing here calls a model or keeps a word.
 */
export const STREAM_PLATFORM = 'youtube';
export const STREAM_LINE_KINDS = ['greeting', 'reply', 'commentary', 'topic', 'notice', 'closing'] as const;
export type StreamLineKind = typeof STREAM_LINE_KINDS[number];
export const STREAM_PHASES = ['waiting_for_chat', 'live', 'ended'] as const;
export type StreamPhase = typeof STREAM_PHASES[number];
export const STREAM_DELIVERIES = ['conversational', 'quick', 'gentle', 'focused', 'energetic'] as const;
export type StreamDelivery = typeof STREAM_DELIVERIES[number];
export const COMMENT_KINDS = ['text', 'superchat', 'supersticker', 'membership', 'gift'] as const;
export type StreamCommentKind = typeof COMMENT_KINDS[number];
export const COMMENT_ROLES = ['owner', 'moderator', 'member', 'verified'] as const;
export type StreamCommentRole = typeof COMMENT_ROLES[number];
export const COMMENT_STATUSES = ['new', 'picked', 'answered', 'skipped', 'declined', 'ignored'] as const;
export type StreamCommentStatus = typeof COMMENT_STATUSES[number];

export const STREAM_LIMITS = Object.freeze({
  titleCharacters: 100,
  /** A line of hers: one to three sentences a voice can say. */
  lineCharacters: 120,
  commentCharacters: 300,
  commentsPerBatch: 200,
  bridgeBodyBytes: 128 * 1024,
  controlBodyBytes: 8 * 1024,
  /** A comment older than this (by its `publishedAt`) is kept for the console and never answered. */
  staleCommentMilliseconds: 5 * 60_000,
  /** A candidate for an answer is not older than this; paid ones (superchat, membership) are waited for as long as a stale one is not. */
  candidateMilliseconds: 90_000,
  paidCandidateMilliseconds: 4 * 60_000,
  /** The chooser runs when her mouth has room, at most this often. */
  chooseEveryMilliseconds: 2_000,
  /** One reply (not a tell-off) per this long. */
  replyEveryMilliseconds: 6_000,
  modelCallsPerMinute: 10,
  /** Topics and commentary leave this many of the minute's calls to replies. */
  modelCallsKeptForReplies: 2,
  /** At most this many lines wait behind the one being said. */
  waitingLines: 2,
  /** The head frees the mouth after this long without a receipt for the line it handed. */
  receiptMilliseconds: 30_000,
  /** The stream's silence after which she talks on her own, and the least time between two topics. */
  topicAfterMilliseconds: 40_000,
  /** A comment from the same viewer answered within this long weighs less. */
  sameViewerMilliseconds: 60_000,
  /** The comments the console lists, and those kept in memory for the stream. */
  consoleComments: 50,
  keptComments: 2_000,
  keepaliveMilliseconds: 15_000,
  /** The closing line is spoken if the mouth takes it within this long after the stream ends; the lines stay open that long (`/v1/stream/lines`). */
  closingMilliseconds: 25_000,
  writerMilliseconds: 20_000,
  linesKept: 100,
  /** The reply lines in the chat's own words (`chatWrites`): YouTube's chat takes 200 characters. */
  chatPostCharacters: 190,
  chatPostsKept: 20,
} as const);

export interface StreamBroadcast { videoId: string; liveChatId: string; title: string; channelId: string; onAir?: boolean }

export interface StreamSessionView {
  streamId: string;
  platform: typeof STREAM_PLATFORM;
  startedAt: string;
  title: string;
  minecraft: boolean;
  chatWrites: boolean;
  phase: StreamPhase;
  broadcast: StreamBroadcast | null;
  targetVideoId?: string;
  program: ProgramView;
  endedAt?: string;
  /** No new line is written while paused (`pause` / `resume`). */
  paused: boolean;
}

export interface StreamStartInput { title?: string; minecraft?: boolean; chatWrites?: boolean; targetVideoId?: string; program?: ProgramInput }

/** What the ear sends of one chat message (`POST /v1/platform/stream/comments`). */
export interface IncomingComment {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  publishedAt: string;
  kind: StreamCommentKind;
  amount?: { display: string; micros: number; currency: string };
  roles: readonly StreamCommentRole[];
  /** The ear made `text` (a membership, a gift): an event to tell, not words of the viewer to quote. */
  synthetic?: boolean;
}

export interface StreamLinePlan { affect: ShannonEmotionKind; affectIntensity: number; delivery: StreamDelivery }
export interface StreamAnswering {
  commentId: string;
  authorName: string;
  text: string;
  kind: StreamCommentKind;
  /** The paid comment's amount as the chat shows it (「¥500」), for the screen. */
  amount?: { display: string };
}

/** One line as the desktop reads it (the `line` event of `GET /v1/stream/lines`). */
export interface StreamLineEvent {
  seq: number;
  id: string;
  streamId: string;
  kind: StreamLineKind;
  text: string;
  plan: StreamLinePlan;
  answering: StreamAnswering[];
  createdAt: string;
  expiresAt: string;
}

export type StreamReceiptOutcome = 'spoken' | 'skipped' | 'failed';
export interface StreamReceipt { outcome: StreamReceiptOutcome; startedAt?: string; endedAt?: string; reason?: string }

export type StreamControl =
  | { action: 'stop_line' }
  | { action: 'ignore'; commentId: string }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'program_next' | 'program_previous' | 'program_close' }
  | { action: 'program_extend'; minutes: number }
  | { action: 'program_layout'; layout: ProgramLayout };

export interface StreamSummary { comments: number; answered: number; lines: number; notices: number; declined: number; durationSeconds: number }

/** A closed reply of the bridge or the console: the error code the routes answer with. */
export class StreamError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code); }
}

/** How a line of commentary ended in the mouth, as the engine of the game's commentary is told (it counts only what was spoken). */
export interface CommentaryEnd { lineId: string; outcome: 'spoken' | 'skipped' | 'failed'; reason: string }

/** What the stream gives the game's commentary (composed in `wiring/streamCommentaryWiring.ts`; this surface knows nothing of Minecraft). */
export interface CommentaryHooks {
  now(): number;
  log(line: string): void;
  /** The mouth busy with a reply, and how long since the last reply was said (the quiet after someone's words). */
  room(): { replying: boolean; sinceHumanMilliseconds: number | null };
  /** Puts a line in the mouth; the mouth's id for it, or null when there is no room. The line must come from `accept`. */
  enqueue(text: string, ttlMilliseconds: number): string | null;
  /** The auxiliary model's answer to a prompt, against the minute's allowance; null when late, over the allowance or failed. */
  complete(system: string, message: string): Promise<string | null>;
  /** The line as one the mouth may take (voice-ready, checked); null when it is empty, too long or flagged. */
  accept(text: string): string | null;
  identity(): string;
  persona(): string;
  /** Her Minecraft body's present for a shared room. */
  body(): string;
  /** No new line is written while the stream is paused or over. */
  quiet(): boolean;
}

export interface CommentaryPort {
  start(): void;
  stop(): void;
  ended(end: CommentaryEnd): void;
  stats(): Readonly<Record<string, number>>;
}
export type CommentaryFactory = (hooks: CommentaryHooks) => CommentaryPort;
