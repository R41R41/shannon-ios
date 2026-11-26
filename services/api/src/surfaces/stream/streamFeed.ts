import type { ServerResponse } from 'node:http';
import { STREAM_LIMITS, type IncomingComment, type StreamCommentKind, type StreamCommentRole, type StreamCommentStatus } from './streamContract.js';
import type { CommentRecord } from './streamLedger.js';

/**
 * The comment feed (`docs/stream-contract.md` §1, `GET /v1/stream/feed`): every comment the ear brought, as the stage on the desktop wants
 * it, not only the ones she answers. It is a read-only side of `ingest`: nothing it does may slow or fail the
 * ear's batch, so every write is guarded, a listener that does not keep up is closed and never waited for, and an error is swallowed.
 * The words stay in memory for the stream only (§0): the list is dropped when the stream ends. The author's account is never sent, only
 * the ledger's digest (`viewer`).
 */
export interface FeedComment {
  seq: number;
  streamId: string;
  commentId: string;
  viewer: string;
  authorName: string;
  text: string;
  kind: StreamCommentKind;
  amount?: { display: string; micros: number; currency: string };
  roles: readonly StreamCommentRole[];
  first: boolean;
  status: StreamCommentStatus;
  tags: string[];
  synthetic?: true;
  /** When it was written on YouTube (milliseconds). */
  at: number;
}

export const FEED_LIMITS = Object.freeze({
  /** Comments kept for a late listener: the stream's last ones. */
  kept: 2_000,
  /** Listeners at once; a ninth closes the oldest. */
  listeners: 8,
  /** A listener with more than this unsent is not keeping up: it is closed (the reader connects again with `after`). */
  backlogBytes: 1024 * 1024,
});

interface Listener { response: ServerResponse; timer: ReturnType<typeof setInterval>; replayBytes?: number }
interface Kept { seq: number; frame: string }

const frame = (event: string, data: unknown, id?: number): string =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class StreamFeed {
  private kept: Kept[] = [];
  private last = 0;
  private streamId: string | null = null;
  private live = false;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly options: { keepaliveMilliseconds?: number } = {}) {}

  listenerCount(): number { return this.listeners.size; }
  keptCount(): number { return this.kept.length; }
  lastSeq(): number { return this.last; }

  /** One comment in, as the ledger read it (`record`) and as the ear brought it (`incoming`: the amount's micros and currency). Never throws. */
  comment(streamId: string, record: CommentRecord, incoming: IncomingComment): void {
    try {
      const seq = this.last + 1;
      const amount = incoming.amount && Number.isFinite(incoming.amount.micros)
        ? { display: record.amountDisplay ?? incoming.amount.display, micros: incoming.amount.micros, currency: incoming.amount.currency } : undefined;
      const body: FeedComment = {
        seq, streamId, commentId: record.commentId, viewer: record.viewer, authorName: record.authorName, text: record.text, kind: record.kind,
        ...(amount ? { amount } : {}), roles: [...record.roles], first: record.first, status: record.status, tags: [...record.tags],
        ...(incoming.synthetic === true ? { synthetic: true as const } : {}), at: record.publishedMs,
      };
      const text = frame('comment', body, seq);
      this.last = seq;
      this.kept.push({ seq, frame: text });
      if (this.kept.length > FEED_LIMITS.kept) this.kept.splice(0, this.kept.length - FEED_LIMITS.kept);
      this.broadcast(text);
    } catch { /* the feed never fails the ear's batch */ }
  }

  /** The stream began (`live`) or ended. An end drops the words; so does a different stream's start. Never throws. */
  state(streamId: string | null, live: boolean): void {
    try {
      if (!live || streamId !== this.streamId) this.kept = [];
      this.streamId = streamId;
      this.live = live;
      this.broadcast(this.stateFrame());
    } catch { /* see comment() */ }
  }

  private stateFrame(): string { return frame('state', { streamId: this.streamId, live: this.live, seq: this.last }); }

  /**
   * `GET /v1/stream/feed`: the state once, then what is kept after `after` (all of it when `after` is missing, 0 or beyond the last number:
   * the head started again), then what comes. Returns the function that removes the listener.
   */
  subscribe(response: ServerResponse, after = 0): () => void {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive',
      'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    while (this.listeners.size >= FEED_LIMITS.listeners) this.drop(this.listeners.values().next().value as Listener);
    const timer = setInterval(() => this.guardedWrite(listener, ': keepalive\n\n'), this.options.keepaliveMilliseconds ?? STREAM_LIMITS.keepaliveMilliseconds);
    timer.unref?.();
    const listener: Listener = { response, timer };
    this.listeners.add(listener);
    const from = Number.isInteger(after) && after > 0 && after <= this.last ? after : 0;
    this.guardedWrite(listener, this.stateFrame());
    // The replay is one burst the socket has not sent yet: it is not a listener falling behind, so it is not measured against the backlog.
    for (const item of this.kept) {
      if (item.seq > from) this.guardedWrite(listener, item.frame, true);
    }
    const leave = () => { this.remove(listener); };
    response.on('close', leave);
    return leave;
  }

  private broadcast(text: string): void {
    for (const listener of [...this.listeners]) this.guardedWrite(listener, text);
  }

  /** A write that never throws and never waits: a listener that fails or falls far behind is closed. */
  private guardedWrite(listener: Listener, text: string, replay = false): void {
    const { response } = listener;
    try {
      if (response.destroyed || response.writableEnded) return this.remove(listener);
      response.write(text);
      if (!replay && response.writableLength > FEED_LIMITS.backlogBytes + (listener.replayBytes ?? 0)) this.drop(listener);
      if (replay) listener.replayBytes = (listener.replayBytes ?? 0) + Buffer.byteLength(text);
    } catch {
      this.remove(listener);
    }
  }

  private remove(listener: Listener): void {
    clearInterval(listener.timer);
    this.listeners.delete(listener);
  }

  private drop(listener: Listener): void {
    this.remove(listener);
    try { listener.response.end(); } catch { /* already gone */ }
    try { listener.response.destroy(); } catch { /* already gone */ }
  }

  /** Closes every listener (the server stops). */
  closeAll(): void {
    for (const listener of [...this.listeners]) this.drop(listener);
  }
}
