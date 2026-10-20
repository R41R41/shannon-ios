import { LiveGovernor, pickMoments, type LiveMoment, type LiveRoom } from '@shannon/mind';
import type { MinecraftLiveRoom, MinecraftLiveSpeechReceipt } from '../../contracts/minecraftControlContract.js';
import type { LiveSpeechDraft, LiveSpeechOutbox } from './minecraftLiveSpeech.js';

/**
 * Her live commentary (session dc-live; `SHANNON_MINECRAFT_LIVE_SPEECH`): the moments her body shows (`MinecraftLive`) are weighed by the
 * governor (`@shannon/mind` `LiveGovernor`: how loud, how long since her last word, whether someone is talking), the one worth a word is
 * written in her voice (the `write` port, a model call), and the line goes to the outbox for the body to say. Everything here is off the
 * decisions' path: a moment arrives from a poll and only schedules a timer; the model call runs on its own; a failure drops the moment.
 */
export const LIVE_COMMENTARY_ENGINE = Object.freeze({
  /** Moments waiting to be weighed (the oldest are dropped past this). */
  waitingLimit: 12,
  /** Weighed again this soon after a hold that may pass (someone talking, the spacing). */
  retryMilliseconds: 1_500,
  /** A model call that takes longer than this is given up. */
  writeMilliseconds: 12_000,
  /** How long a line stays worth saying once written (it is about a moment that is going by). */
  lineLifetimeMilliseconds: Object.freeze({ ordinary: 25_000, urgent: 35_000 }),
  /** A moment whose line was written but held back by the room (someone started talking) is written again at most this many times. */
  rewrites: 1,
});

export interface LiveWriteRequest {
  main: LiveMoment;
  also: readonly LiveMoment[];
  recent: readonly string[];
  /** The line will be spoken (she is in a voice channel), not written. */
  voice: boolean;
}

export interface LiveCommentaryParts {
  /** Where moments come from, what only the API sees of the room, and her danger. */
  live: {
    onMoment(listener: (moment: LiveMoment) => void): () => void;
    inDanger(): boolean;
    conversation(): { replying: boolean; sinceHumanMilliseconds: number | null };
  };
  outbox: Pick<LiveSpeechOutbox, 'enqueue' | 'onEnd' | 'room'>;
  /** The line for these moments in her voice, or null when she has none; may throw (the moment is then dropped). */
  write(request: LiveWriteRequest): Promise<string | null>;
  /** A line was delivered (said or posted): the wiring keeps it in the conversation it went into. */
  delivered?(told: { id: string; moment: LiveMoment; text: string; outcome: 'spoken' | 'posted'; conversationId?: string }): void;
  governor?: LiveGovernor;
  now?: () => number;
  log?: (line: string) => void;
}

interface Waiting { moment: LiveMoment; rewrites: number }
interface Pending { main: LiveMoment; also: LiveMoment[]; text: string }

/** `promise`, or null once `milliseconds` have gone. */
function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class LiveCommentary {
  readonly governor: LiveGovernor;
  private waiting: Waiting[] = [];
  private readonly pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing = false;
  private serial = 0;
  private stops: Array<() => void> = [];
  private readonly counts: Record<string, number> = {};

  constructor(private readonly parts: LiveCommentaryParts) {
    this.governor = parts.governor ?? new LiveGovernor();
  }

  private now(): number { return (this.parts.now ?? Date.now)(); }
  private log(line: string): void { try { this.parts.log?.(line); } catch { /* the journal never fails the commentary */ } }
  private count(name: string): void { this.counts[name] = (this.counts[name] ?? 0) + 1; }

  start(): void {
    if (this.stops.length) return;
    this.stops.push(this.parts.live.onMoment(moment => this.hear(moment)), this.parts.outbox.onEnd((receipt, draft) => this.ended(receipt, draft)));
  }

  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Counts for the journal and the tests, closed values only. */
  stats(): Readonly<Record<string, number>> { return { ...this.counts, waiting: this.waiting.length, pending: this.pending.size }; }

  private hear(moment: LiveMoment): void {
    this.count('moments');
    this.waiting.push({ moment, rewrites: 0 });
    if (this.waiting.length > LIVE_COMMENTARY_ENGINE.waitingLimit) this.waiting.shift();
    this.schedule(0);
  }

  private schedule(milliseconds: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, milliseconds);
    this.timer.unref?.();
  }

  /** What the room is, as the governor weighs it: the body's reading, what the API sees, and her danger. */
  private room(): LiveRoom {
    const body: MinecraftLiveRoom | null = this.parts.outbox.room(), seen = this.parts.live.conversation();
    const since = [body?.sinceHumanMs ?? null, seen.sinceHumanMilliseconds].filter((value): value is number => value !== null);
    return { now: this.now(), sinceHumanMilliseconds: since.length ? Math.min(...since) : null, humanSpeaking: body?.humanSpeaking === true,
      replying: seen.replying, danger: this.parts.live.inDanger() };
  }

  /** Weighs what waits; the loudest that may speak is written. Never throws. */
  private async tick(): Promise<void> {
    try {
      // One line at a time: a line the body has not answered yet is not followed by another.
      if (this.writing || this.pending.size > 0) return;
      const room = this.room(), ready: Array<{ moment: LiveMoment; salience: number; rewrites: number }> = [];
      this.waiting = this.waiting.filter(item => {
        const verdict = this.governor.verdict(item.moment, room);
        if (verdict.speak) ready.push({ moment: item.moment, salience: verdict.salience, rewrites: item.rewrites });
        else if (verdict.reason === 'stale' || verdict.reason === 'salience') {
          this.governor.spend(item.moment);
          this.count(`dropped_${verdict.reason}`);
          return false;
        } else this.count(`held_${verdict.reason}`);
        return true;
      });
      // Nothing is written until the body has told its room lately: a body that cannot speak (its switch is off) would let every line expire.
      if (!this.parts.outbox.room()) {
        if (ready.length) this.count('held_no_body');
        return;
      }
      const picked = pickMoments(ready.map(item => ({ ...item })));
      if (picked) await this.compose(picked.main, picked.also);
    } catch (error) {
      this.log(`Shannon Minecraft live tick failed reason=${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
    } finally {
      if (this.waiting.length) this.schedule(LIVE_COMMENTARY_ENGINE.retryMilliseconds);
    }
  }

  private async compose(main: { moment: LiveMoment; salience: number; rewrites: number }, also: ReadonlyArray<{ moment: LiveMoment }>): Promise<void> {
    this.writing = true;
    try {
      const voice = this.parts.outbox.room()?.voice === true, folded = also.map(item => item.moment);
      const text = await within(this.parts.write({ main: main.moment, also: folded, recent: this.governor.recentWords(), voice }).catch(() => null),
        LIVE_COMMENTARY_ENGINE.writeMilliseconds);
      this.settle(main, folded, text, voice);
    } finally { this.writing = false; }
  }

  /** The written line meets the room again: it may have changed while the model wrote. */
  private settle(main: { moment: LiveMoment; salience: number; rewrites: number }, folded: LiveMoment[], text: string | null, voice: boolean): void {
    const spendAll = () => [main.moment, ...folded].forEach(moment => this.governor.spend(moment));
    if (!text) {
      this.count('write_empty');
      spendAll();
      return this.dropWaiting(main.moment, folded);
    }
    if (!this.governor.fresh(text)) {
      this.count('write_repeat');
      spendAll();
      return this.dropWaiting(main.moment, folded);
    }
    const again = this.governor.verdict(main.moment, this.room());
    if (!again.speak && (again.reason === 'human' || again.reason === 'replying') && main.rewrites < LIVE_COMMENTARY_ENGINE.rewrites) {
      // Someone began to talk while the line was written: it is not said over them; the moment waits, and is written again if it still stands.
      this.count('write_held');
      const waiting = this.waiting.find(item => item.moment.key === main.moment.key);
      if (waiting) waiting.rewrites += 1;
      return;
    }
    if (!again.speak) {
      this.count(`write_dropped_${again.reason}`);
      spendAll();
      return this.dropWaiting(main.moment, folded);
    }
    this.send(main, folded, text, voice);
  }

  private dropWaiting(main: LiveMoment, folded: LiveMoment[]): void {
    const gone = new Set([main.key, ...folded.map(moment => moment.key)]);
    this.waiting = this.waiting.filter(item => !gone.has(item.moment.key));
  }

  private send(main: { moment: LiveMoment; salience: number }, folded: LiveMoment[], text: string, voice: boolean): void {
    const id = `live-${this.now().toString(36)}-${++this.serial}`;
    const urgent = main.salience >= 0.9;
    const draft: LiveSpeechDraft = { id, text, urgency: urgent ? 'urgent' : 'ordinary', kind: main.moment.kind,
      ttlMilliseconds: LIVE_COMMENTARY_ENGINE.lineLifetimeMilliseconds[urgent ? 'urgent' : 'ordinary'] };
    this.pending.set(id, { main: main.moment, also: folded, text });
    if (this.pending.size > 8) this.pending.delete(this.pending.keys().next().value as string);
    this.dropWaiting(main.moment, folded);
    this.count('queued');
    this.parts.outbox.enqueue(draft);
    this.log(`Shannon Minecraft live queued id=${id} kind=${main.moment.kind} salience=${main.salience.toFixed(2)} folded=${folded.length}`
      + ` voice=${voice} length=${text.length}`);
  }

  /** The body's answer for a line (or the outbox's, when it never got one). */
  private ended(receipt: MinecraftLiveSpeechReceipt, draft: LiveSpeechDraft): void {
    const entry = this.pending.get(draft.id);
    if (!entry) return;
    this.pending.delete(draft.id);
    this.count(`ended_${receipt.outcome}`);
    this.log(`Shannon Minecraft live ended id=${draft.id} kind=${draft.kind} outcome=${receipt.outcome}${receipt.reason ? ` reason=${receipt.reason}` : ''}`);
    if (receipt.outcome !== 'spoken' && receipt.outcome !== 'posted') return;
    this.governor.delivered(entry.main, entry.text, this.now());
    for (const moment of entry.also) this.governor.spend(moment);
    try {
      this.parts.delivered?.({ id: draft.id, moment: entry.main, text: entry.text, outcome: receipt.outcome,
        ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}) });
    } catch { /* keeping the line in a thread never fails the commentary */ }
  }
}
