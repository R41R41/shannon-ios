import { randomUUID } from 'node:crypto';
import { validatedElevenTags } from '../../infra/models/elevenSpeech.js';

/**
 * Her mouth in a Discord voice channel, as the head's side of it (dc-voice, 2026-10-20; the contract is `dc-speak-interface.md`).
 * Anything on the server that wants her to say a line there (`voiceMouth.say`, or `POST /v1/platform/voice/say`) puts it in this
 * queue; the body, which is in the channel and hears who is talking, takes it with a long poll (`POST /v1/platform/voice/mouth/poll`),
 * decides when it can be said (never over a person, never over her own reply) and reports what became of it
 * (`/voice/mouth/result`). The queue itself only bounds what may wait: how long, how many, and which line replaces which.
 */
export type VoiceMouthPriority = 'low' | 'normal' | 'high';

export type VoiceMouthStatus = 'queued' | 'taken' | 'spoken' | 'dropped_busy' | 'expired' | 'superseded' | 'not_in_voice'
  | 'disabled' | 'interrupted' | 'declined';

export const VOICE_MOUTH_RESULTS: readonly VoiceMouthStatus[] = ['spoken', 'dropped_busy', 'expired', 'superseded', 'not_in_voice',
  'disabled', 'interrupted', 'declined'];

export const VOICE_MOUTH_LIMITS = Object.freeze({
  textCharacters: 120,
  factCharacters: 120,
  facts: 5,
  keyCharacters: 80,
  sourceCharacters: 80,
  /** Lines waiting at once; the oldest low-priority one makes room, else the new one is refused. */
  waiting: 20,
  /** All lines accepted in a minute, whoever sent them: a flood guard (the body's mouth has its own, finer, rules). */
  perMinute: 30,
  /** The body has not taken a poll for this long: nobody is listening for a line. */
  bodyOfflineMilliseconds: 40_000,
  pollMaximumMilliseconds: 25_000,
  /** How long a result stays readable. */
  resultMinutes: 10,
  maxWaitDefaults: Object.freeze({ low: 4_000, normal: 8_000, high: 3_000 }),
  maxWaitRange: Object.freeze([500, 30_000] as const),
});

export interface VoiceMouthLine {
  id: string;
  /** Said as it is. Exactly one of `text` and `facts`. */
  text?: string;
  /** Event facts for her to put into words (`/voice/wording`), or say nothing. */
  facts?: string[];
  source: string;
  key?: string;
  priority: VoiceMouthPriority;
  maxWaitMs: number;
  tags?: string;
  createdAt: string;
}

export interface VoiceMouthSay {
  text?: string;
  facts?: readonly string[];
  source: string;
  key?: string;
  priority?: VoiceMouthPriority;
  maxWaitMs?: number;
  tags?: string;
}

export type VoiceMouthRefusal = 'invalid' | 'body_offline' | 'rate_limited' | 'queue_full';

export interface VoiceMouthAccepted {
  id: string;
  accepted: boolean;
  reason?: VoiceMouthRefusal;
}

type Release = 'line' | 'replaced';

interface Entry {
  line: VoiceMouthLine;
  status: VoiceMouthStatus;
  at: number;
  deadline: number;
}

const clip = (text: string, length: number): string => Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, length).join('');

const PRIORITIES: readonly string[] = ['low', 'normal', 'high'];

function lineTags(tags: string | undefined): { tags?: string } | null {
  if (tags === undefined) return {};
  try {
    const checked = validatedElevenTags(tags).trim();
    return checked ? { tags: checked } : {};
  } catch {
    return null;
  }
}

function lineFacts(facts: readonly unknown[]): string[] {
  return facts
    .filter((fact): fact is string => typeof fact === 'string')
    .map(fact => clip(fact, VOICE_MOUTH_LIMITS.factCharacters))
    .filter(Boolean)
    .slice(0, VOICE_MOUTH_LIMITS.facts);
}

/** The words of a line: exactly one of `text` and `facts`, bounded; null when it is neither or both. */
function lineWords(input: VoiceMouthSay): { text: string } | { facts: string[] } | null {
  const hasText = typeof input.text === 'string' && input.text.trim().length > 0;
  const hasFacts = Array.isArray(input.facts) && input.facts.length > 0;
  if (hasText === hasFacts) return null;
  if (hasText) return { text: clip(input.text!, VOICE_MOUTH_LIMITS.textCharacters) };
  const facts = lineFacts(input.facts!);
  return facts.length ? { facts } : null;
}

function lineWait(input: VoiceMouthSay, priority: VoiceMouthPriority): number | null {
  const [low, high] = VOICE_MOUTH_LIMITS.maxWaitRange;
  const waited = input.maxWaitMs ?? VOICE_MOUTH_LIMITS.maxWaitDefaults[priority];
  return Number.isFinite(waited) ? Math.min(high, Math.max(low, Math.round(waited))) : null;
}

function validatedLine(id: string, input: VoiceMouthSay, at: number): VoiceMouthLine | null {
  const words = lineWords(input);
  const priority = input.priority ?? 'normal';
  const source = clip(typeof input.source === 'string' ? input.source : '', VOICE_MOUTH_LIMITS.sourceCharacters);
  const tags = lineTags(input.tags);
  const maxWaitMs = lineWait(input, priority);
  if (!words || !PRIORITIES.includes(priority) || !source || !tags || maxWaitMs === null) return null;
  const key = typeof input.key === 'string' && input.key.trim() ? clip(input.key, VOICE_MOUTH_LIMITS.keyCharacters) : undefined;
  return { id, source, priority, maxWaitMs, createdAt: new Date(at).toISOString(), ...words, ...(key ? { key } : {}), ...tags };
}

export class VoiceMouthQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly acceptedAt: number[] = [];
  private lastPoll: number | null = null;
  private waiter: { release(why: Release): void } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether the body took a poll lately: a line sent now has someone to take it. */
  bodyOnline(): boolean {
    return this.lastPoll !== null && this.now() - this.lastPoll < VOICE_MOUTH_LIMITS.bodyOfflineMilliseconds;
  }

  say(input: VoiceMouthSay): VoiceMouthAccepted {
    const id = randomUUID();
    const at = this.now();
    const refusal = (reason: VoiceMouthRefusal): VoiceMouthAccepted => ({ id, accepted: false, reason });
    const line = validatedLine(id, input, at);
    if (!line) return refusal('invalid');
    if (!this.bodyOnline()) return refusal('body_offline');
    if (this.floodedAt(at)) return refusal('rate_limited');
    this.sweep(at);
    if (!this.makeRoom(line)) return refusal('queue_full');
    this.acceptedAt.push(at);
    this.entries.set(id, { line, status: 'queued', at, deadline: at + line.maxWaitMs });
    this.waiter?.release('line');
    return { id, accepted: true };
  }

  private floodedAt(at: number): boolean {
    while (this.acceptedAt.length && at - this.acceptedAt[0]! >= 60_000) this.acceptedAt.shift();
    return this.acceptedAt.length >= VOICE_MOUTH_LIMITS.perMinute;
  }

  private waiting(): Entry[] {
    return [...this.entries.values()].filter(entry => entry.status === 'queued');
  }

  /** A newer line with the same key replaces the waiting one; a full queue drops its oldest low line for a higher one. */
  private makeRoom(line: VoiceMouthLine): boolean {
    if (line.key) {
      for (const entry of this.waiting()) if (entry.line.key === line.key) entry.status = 'superseded';
    }
    const open = this.waiting();
    if (open.length < VOICE_MOUTH_LIMITS.waiting) return true;
    const lowest = open.filter(entry => entry.line.priority === 'low').sort((a, b) => a.at - b.at)[0];
    if (!lowest || line.priority === 'low') return false;
    lowest.status = 'dropped_busy';
    return true;
  }

  /** Marks the lines whose wait ran out, and forgets results older than the readable window. */
  private sweep(at: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.status === 'queued' && at > entry.deadline) {
        entry.status = 'expired';
        entry.at = at;
      }
      const settled = entry.status !== 'queued' && entry.status !== 'taken';
      if (settled && at - entry.at > VOICE_MOUTH_LIMITS.resultMinutes * 60_000) this.entries.delete(id);
    }
  }

  /**
   * The lines waiting, taken (the oldest first, `high` before the rest), or an empty list after `waitMs` with nothing to take. A second
   * poll replaces the first: the older one returns empty at once (one body, one mouth).
   */
  async poll(waitMs: number, signal?: AbortSignal): Promise<VoiceMouthLine[]> {
    this.lastPoll = this.now();
    this.waiter?.release('replaced');
    const bounded = Math.min(VOICE_MOUTH_LIMITS.pollMaximumMilliseconds, Math.max(0, Number.isFinite(waitMs) ? waitMs : 0));
    const deadline = this.now() + bounded;
    for (;;) {
      if (signal?.aborted) return [];
      const lines = this.takeWaiting();
      const remaining = deadline - this.now();
      if (lines.length || remaining <= 0) return lines;
      const outcome = await this.pause(remaining, signal);
      this.lastPoll = this.now();
      if (outcome === 'replaced' || outcome === 'abort') return [];
      if (outcome === 'timeout') return this.takeWaiting();
    }
  }

  private pause(milliseconds: number, signal?: AbortSignal): Promise<Release | 'timeout' | 'abort'> {
    return new Promise(resolve => {
      const holder: { release(why: Release): void } = { release: why => finish(why) };
      const finish = (why: Release | 'timeout' | 'abort') => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.waiter === holder) this.waiter = null;
        resolve(why);
      };
      const onAbort = () => finish('abort');
      const timer = setTimeout(() => finish('timeout'), milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiter = holder;
    });
  }

  private takeWaiting(): VoiceMouthLine[] {
    const at = this.now();
    this.sweep(at);
    const rank = (entry: Entry) => (entry.line.priority === 'high' ? 0 : 1);
    const waiting = this.waiting().sort((a, b) => rank(a) - rank(b) || a.at - b.at);
    for (const entry of waiting) {
      entry.status = 'taken';
      entry.at = at;
    }
    return waiting.map(entry => entry.line);
  }

  /** What the body reports of a line it took. An unknown id or a status that is not a result is ignored (false). */
  result(id: string, status: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !VOICE_MOUTH_RESULTS.includes(status as VoiceMouthStatus)) return false;
    entry.status = status as VoiceMouthStatus;
    entry.at = this.now();
    return true;
  }

  status(id: string): VoiceMouthStatus | null {
    this.sweep(this.now());
    return this.entries.get(id)?.status ?? null;
  }
}

/** The one queue of this server (the route and head-side callers share it). */
export const voiceMouth = new VoiceMouthQueue();
