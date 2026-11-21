import { LiveGovernor, pickMoments, type LiveMoment, type LiveRoom } from '@shannon/mind';
import { outsideActionExecution } from '../../infra/context/actionExecution.js';
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
  /**
   * How long a line stays worth saying once written (it is about a moment that is going by). From the event to the voice it already took the
   * poll, the model and the voice; a line the body could not say within this (someone kept talking) is dropped, not said late.
   */
  lineLifetimeMilliseconds: Object.freeze({ ordinary: 15_000, urgent: 25_000 }),
  /**
   * A kind's own time, from how much the word matters later: a thought of the moment is gone in ten seconds, the end of a request (the
   * thing she must say, and ask) waits for the room. The body waits at most as long as the line's time says (and, today, at most eight).
   */
  lineLifetimeByKindMilliseconds: Object.freeze<Record<string, number>>({ thinking: 10_000, plan_step: 12_000, material_got: 12_000, task_done: 40_000 }),
  /** Of these kinds only the newest waiting moment is worth a word: an older one is about a step that has already passed. */
  supersededKinds: Object.freeze(['thinking', 'plan_step']),
  /** The moments of her work as she does it: the end of a request closes them. */
  workKinds: Object.freeze(['thinking', 'plan_step', 'plan_changed', 'material_needed', 'material_got']),
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
  /**
   * What she says for the end of a request when the writer gave her nothing twice: the question after a finished job starts the
   * answer (where to put it, what next), so the end is never left unsaid. Absent: the end is dropped like any lost line.
   */
  doneFallback?: string;
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
  /** The ends of requests that were given a second try (the first line was lost); each gets one. */
  private readonly retried = new Set<string>();

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
    // The request ended: what waits of her work (a step, a thought, a material) is about a story that is over, and the end says it.
    if (moment.kind === 'task_done') {
      this.waiting = this.waiting.filter(item => !LIVE_COMMENTARY_ENGINE.workKinds.includes(item.moment.kind));
    }
    if (LIVE_COMMENTARY_ENGINE.supersededKinds.includes(moment.kind)) {
      const older = this.waiting.length;
      this.waiting = this.waiting.filter(item => item.moment.kind !== moment.kind);
      if (this.waiting.length < older) this.count('superseded');
    }
    this.waiting.push({ moment, rewrites: 0 });
    if (this.waiting.length > LIVE_COMMENTARY_ENGINE.waitingLimit) this.waiting.shift();
    this.schedule(0);
  }

  private schedule(milliseconds: number): void {
    if (this.timer) return;
    // A moment is heard from inside the task step that made it, and a timer keeps the action of the place it was set in: the model call it
    // leads to would be asked of a step that is over (ACTION_STOPPED), and so would every later timer of the chain. The word is hers, not the step's.
    this.timer = outsideActionExecution(() => setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, milliseconds));
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
    // The end of a request is the one word that is not told again by anything else: a line lost for a reason of the line (empty, a repeat,
    // the room) is written once more.
    const giveUp = () => {
      if (this.revive(main.moment)) return folded.forEach(moment => this.governor.spend(moment));
      spendAll();
      this.dropWaiting(main.moment, folded);
    };
    // The end was already written once more and is still lost for a reason of the line: the fixed line is said (it is not judged as a repeat).
    if ((!text || !this.governor.fresh(text)) && main.moment.kind === 'task_done' && this.retried.has(main.moment.key) && this.parts.doneFallback) {
      this.count('done_fallback');
      text = this.parts.doneFallback;
    } else if (!text) {
      this.count('write_empty');
      return giveUp();
    } else if (!this.governor.fresh(text)) {
      this.count('write_repeat');
      return giveUp();
    }
    if (!text) return;
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
      return giveUp();
    }
    this.send(main, folded, text, voice);
  }

  /**
   * The end of a request whose line was lost goes back to waiting, once, as new (its time runs from now); anything else is not given a
   * second try. Returns whether it was put back.
   */
  private revive(moment: LiveMoment): boolean {
    if (moment.kind !== 'task_done' || this.retried.has(moment.key)) return false;
    this.retried.add(moment.key);
    if (this.retried.size > 64) this.retried.delete(this.retried.values().next().value as string);
    const again = { ...moment, at: this.now() }, waiting = this.waiting.find(item => item.moment.key === moment.key);
    if (waiting) waiting.moment = again; else this.waiting.push({ moment: again, rewrites: 0 });
    this.count('revived');
    return true;
  }

  private dropWaiting(main: LiveMoment, folded: LiveMoment[]): void {
    const gone = new Set([main.key, ...folded.map(moment => moment.key)]);
    this.waiting = this.waiting.filter(item => !gone.has(item.moment.key));
  }

  private send(main: { moment: LiveMoment; salience: number }, folded: LiveMoment[], text: string, voice: boolean): void {
    const id = `live-${this.now().toString(36)}-${++this.serial}`;
    const urgent = main.salience >= 0.9;
    const draft: LiveSpeechDraft = { id, text, urgency: urgent ? 'urgent' : 'ordinary', kind: main.moment.kind,
      ttlMilliseconds: LIVE_COMMENTARY_ENGINE.lineLifetimeByKindMilliseconds[main.moment.kind]
        ?? LIVE_COMMENTARY_ENGINE.lineLifetimeMilliseconds[urgent ? 'urgent' : 'ordinary'] };
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
    if (receipt.outcome !== 'spoken' && receipt.outcome !== 'posted') {
      // The body could not say it (someone kept talking, the wait ran out): the end of a request waits for the room once more.
      if (this.revive(entry.main)) this.schedule(LIVE_COMMENTARY_ENGINE.retryMilliseconds);
      return;
    }
    this.governor.delivered(entry.main, entry.text, this.now());
    for (const moment of entry.also) this.governor.spend(moment);
    try {
      this.parts.delivered?.({ id: draft.id, moment: entry.main, text: entry.text, outcome: receipt.outcome,
        ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}) });
    } catch { /* keeping the line in a thread never fails the commentary */ }
  }
}
