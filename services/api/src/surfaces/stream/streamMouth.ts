import type { ServerResponse } from 'node:http';
import type { CheckedStreamReply } from '../../mind/emotion/streamFeeling.js';
import {
  STREAM_LIMITS, type StreamAnswering, type StreamLineEvent, type StreamLineKind, type StreamLinePlan, type StreamReceipt,
} from './streamContract.js';

/**
 * Her mouth (`docs/stream-contract.md` §1): the one ordered list of what she says on the stream. Replies, commentary on the game, her own
 * talk and tell-offs all wait here, and the desktop is handed one line at a time: the next only after the previous one's receipt (or
 * `receiptMilliseconds` without one). At most two lines wait behind it; a new reply pushes out a waiting topic and never another reply; a
 * notice goes to the front. A line is made only from a `CheckedStreamReply` (the type `checkStreamReply` alone makes), so nothing that did
 * not pass the check before speaking can enter. It holds no model and no word of the chat beyond the lines' own text.
 */
export interface MouthLine {
  id: string;
  kind: StreamLineKind;
  text: string;
  plan: StreamLinePlan;
  answering: StreamAnswering[];
  commentIds: string[];
  createdMs: number;
  expiresMs: number;
  /** Set when the line is handed: the order the desktop receives them in. */
  seq?: number;
  handedMs?: number;
}

export interface MouthEnqueue {
  kind: StreamLineKind;
  reply: CheckedStreamReply;
  plan: StreamLinePlan;
  answering?: StreamAnswering[];
  commentIds?: string[];
  ttlMilliseconds: number;
}

export type MouthEndReason = 'spoken' | 'skipped' | 'failed' | 'expired' | 'pushed_out' | 'dropped' | 'no_receipt';
export interface MouthEnd { line: MouthLine; outcome: 'spoken' | 'skipped' | 'failed'; reason: MouthEndReason | string; receipt?: StreamReceipt }
export type MouthEnded = (end: MouthEnd) => void;

interface Subscriber { response: ServerResponse; timer: ReturnType<typeof setInterval> }

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class StreamMouth {
  private waiting: MouthLine[] = [];
  private current: MouthLine | null = null;
  private serial = 0;
  private sequence = 0;
  private readonly finished = new Map<string, MouthEnd>();
  private readonly listeners = new Set<MouthEnded>();
  private readonly subscribers = new Set<Subscriber>();
  private state: () => unknown = () => ({ stream: null });
  private streamId = '';

  constructor(private readonly options: { now: () => number; keepaliveMilliseconds?: number; receiptMilliseconds?: number; ids?: () => string }) {}

  private now(): number { return this.options.now(); }

  /** The stream the lines belong to (set when one starts); lines of an earlier stream are not carried over. */
  begin(streamId: string): void {
    this.streamId = streamId;
    this.waiting = [];
    this.current = null;
    this.sequence = 0;
    this.finished.clear();
  }

  /** What the `state` event carries; asked again on every connect and every phase change. */
  provideState(read: () => unknown): void { this.state = read; }

  onEnd(listener: MouthEnded): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitingCount(): number { return this.waiting.length; }
  /** A line is being said (or waiting for its receipt). */
  hasCurrent(): boolean { return this.current !== null; }
  currentLine(): MouthLine | null { return this.current; }
  waitingLines(): readonly MouthLine[] { return this.waiting; }
  subscriberCount(): number { return this.subscribers.size; }
  /** Whether some line of these kinds is in the mouth now (said or waiting). */
  holds(...kinds: StreamLineKind[]): boolean {
    return [this.current, ...this.waiting].some(line => line !== null && kinds.includes(line.kind));
  }

  /** Whether a line of this kind could be put in now (the room the chooser asks for). */
  hasRoom(kind: StreamLineKind): boolean {
    if (kind === 'notice' || kind === 'closing') return true;
    if (this.waiting.length < STREAM_LIMITS.waitingLines) return true;
    return kind === 'reply' ? this.waiting.some(line => line.kind === 'topic' || line.kind === 'commentary')
      : kind === 'commentary' ? this.waiting.some(line => line.kind === 'topic') : false;
  }

  /**
   * A line in. Returns its id, or null when there was no room (the caller gives its comments back). Pushed-out lines are ended as
   * `pushed_out`, expired ones as `expired`.
   */
  enqueue(input: MouthEnqueue): string | null {
    const text = input.reply.text;
    if (!this.hasRoom(input.kind)) return null;
    const now = this.now();
    const line: MouthLine = {
      id: this.options.ids?.() ?? `ln-${now.toString(36)}-${(this.serial += 1).toString(36)}`, kind: input.kind, text, plan: input.plan,
      answering: input.answering ?? [], commentIds: input.commentIds ?? [], createdMs: now, expiresMs: now + input.ttlMilliseconds,
    };
    if (input.kind === 'closing') {
      // The last word: whatever waits is dropped, and the closing is next.
      for (const dropped of this.waiting.splice(0)) this.end(dropped, 'skipped', 'dropped');
      this.waiting.push(line);
    } else if (input.kind === 'notice') {
      this.waiting.unshift(line);
      this.trim();
    } else if (this.waiting.length >= STREAM_LIMITS.waitingLines) {
      const out = this.waiting.findIndex(item => item.kind === 'topic');
      const fallback = input.kind === 'reply' ? this.waiting.findIndex(item => item.kind === 'commentary') : -1;
      const index = out >= 0 ? out : fallback;
      const [pushed] = this.waiting.splice(index, 1);
      if (pushed) this.end(pushed, 'skipped', 'pushed_out');
      this.waiting.push(line);
    } else this.waiting.push(line);
    this.pump();
    return line.id;
  }

  /** A notice at the front may overfill the list: the line behind it that matters least gives way (a topic, then commentary, then the newest reply). */
  private trim(): void {
    const weight: Partial<Record<StreamLineKind, number>> = { topic: 0, commentary: 1, reply: 2 };
    while (this.waiting.length > STREAM_LIMITS.waitingLines) {
      let victim = -1;
      for (let index = this.waiting.length - 1; index >= 1; index -= 1) {
        if (victim < 0 || (weight[this.waiting[index]!.kind] ?? 3) < (weight[this.waiting[victim]!.kind] ?? 3)) victim = index;
      }
      const [gone] = this.waiting.splice(victim < 0 ? this.waiting.length - 1 : victim, 1);
      if (gone) this.end(gone, 'skipped', 'pushed_out');
    }
  }

  /** The waiting lines that answer any of these comments are dropped (the line that was stopped, a viewer who is ignored). */
  dropAnswering(commentIds: readonly string[]): MouthLine[] {
    const ids = new Set(commentIds);
    const gone = this.waiting.filter(line => line.commentIds.some(id => ids.has(id)));
    this.waiting = this.waiting.filter(line => !gone.includes(line));
    for (const line of gone) this.end(line, 'skipped', 'dropped');
    return gone;
  }

  /** Every waiting line goes (the stream ended). */
  clearWaiting(): void {
    for (const line of this.waiting.splice(0)) this.end(line, 'skipped', 'dropped');
  }

  /** The desktop's answer for a line. 'ok': taken; 'repeat': already answered; 'unknown': a line this mouth never made. */
  receipt(id: string, receipt: StreamReceipt): 'ok' | 'repeat' | 'unknown' {
    if (this.current?.id === id) {
      this.end(this.current, receipt.outcome, receipt.reason ?? receipt.outcome, receipt);
      this.current = null;
      this.pump();
      return 'ok';
    }
    if (this.finished.has(id)) return 'repeat';
    return 'unknown';
  }

  /** Time passes: an expired waiting line is dropped, a line without a receipt too long frees the mouth. Call it often. */
  tick(): void {
    const now = this.now();
    const current = this.current;
    if (current && current.handedMs !== undefined && now - current.handedMs >= (this.options.receiptMilliseconds ?? STREAM_LIMITS.receiptMilliseconds)) {
      this.current = null;
      this.end(current, 'failed', 'no_receipt');
    }
    this.pump();
  }

  private pump(): void {
    if (this.current) return;
    const now = this.now();
    while (this.waiting.length) {
      const line = this.waiting.shift()!;
      if (now >= line.expiresMs) {
        this.end(line, 'skipped', 'expired');
        continue;
      }
      line.seq = this.sequence += 1;
      line.handedMs = now;
      this.current = line;
      this.send('line', this.eventOf(line));
      return;
    }
  }

  private end(line: MouthLine, outcome: MouthEnd['outcome'], reason: string, receipt?: StreamReceipt): void {
    const ended: MouthEnd = { line, outcome, reason, ...(receipt ? { receipt } : {}) };
    this.finished.set(line.id, ended);
    while (this.finished.size > STREAM_LIMITS.linesKept) this.finished.delete(this.finished.keys().next().value as string);
    for (const listener of this.listeners) {
      try { listener(ended); } catch { /* the stream never fails on a listener */ }
    }
  }

  eventOf(line: MouthLine): StreamLineEvent {
    return { seq: line.seq ?? 0, id: line.id, streamId: this.streamId, kind: line.kind, text: line.text, plan: line.plan, answering: line.answering,
      createdAt: new Date(line.createdMs).toISOString(), expiresAt: new Date(line.expiresMs).toISOString() };
  }

  /** `GET /v1/stream/lines`: the desktop listens. `after`: the last seq it already has; a line it has is not sent again. */
  subscribe(response: ServerResponse, after = 0): () => void {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive',
      'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    const timer = setInterval(() => this.write(response, ': keepalive\n\n'), this.options.keepaliveMilliseconds ?? STREAM_LIMITS.keepaliveMilliseconds);
    timer.unref?.();
    const subscriber: Subscriber = { response, timer };
    this.subscribers.add(subscriber);
    this.write(response, frame('state', this.state()));
    if (this.current && (this.current.seq ?? 0) > after) this.write(response, frame('line', this.eventOf(this.current)));
    const leave = () => {
      clearInterval(timer);
      this.subscribers.delete(subscriber);
    };
    response.on('close', leave);
    return leave;
  }

  /** The stream's phase changed: every listener hears the state. */
  announceState(): void { this.send('state', this.state()); }

  private send(event: string, data: unknown): void {
    const text = frame(event, data);
    for (const subscriber of this.subscribers) this.write(subscriber.response, text);
  }

  private write(response: ServerResponse, text: string): void {
    try {
      if (!response.destroyed && !response.writableEnded) response.write(text);
    } catch { /* a listener that went away is dropped by its close */ }
  }

  /** Closes every listener (the server stops). */
  closeAll(): void {
    for (const subscriber of [...this.subscribers]) {
      clearInterval(subscriber.timer);
      this.subscribers.delete(subscriber);
      try { subscriber.response.end(); } catch { /* already gone */ }
    }
  }
}
