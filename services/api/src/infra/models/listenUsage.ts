import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { billedSeconds, estimatedUsd } from './groqTranscription.js';

/**
 * The one allowance of listening transcription that the Windows resident and the Discord voice channel share (owner's plan
 * 2026-10-25: a shared budget, no silent paid fallback). Groq's Developer plan names base limits of 20 requests a minute, 2,000 a day,
 * 7,200 audio seconds an hour and 28,800 a day for whisper-large-v3-turbo (read 2026-10-26; the account's own page is the authority),
 * so the defaults stay just under them:
 *   SHANNON_VOICE_LISTEN_MAX_PER_MINUTE (18), SHANNON_VOICE_LISTEN_MAX_PER_DAY (1,800),
 *   SHANNON_VOICE_LISTEN_MAX_AUDIO_SECONDS_PER_HOUR (6,600), SHANNON_VOICE_LISTEN_MAX_AUDIO_SECONDS_PER_DAY (25,000).
 * The day is the UTC day, as Groq counts it. The counts survive a restart (a small JSON file beside the database); words and audio are
 * never written, only counts, seconds and the estimate.
 */
export interface ListenLimits {
  perMinute: number;
  perDay: number;
  audioSecondsPerHour: number;
  audioSecondsPerDay: number;
}

export const DEFAULT_LISTEN_LIMITS: ListenLimits = Object.freeze({ perMinute: 18, perDay: 1_800, audioSecondsPerHour: 6_600, audioSecondsPerDay: 25_000 });

export type ListenSource = 'windows' | 'discord';

export interface ListenUsageToday {
  day: string;
  requests: number;
  audioSeconds: number;
  billedSeconds: number;
  estimatedUsd: number;
  bySource: Record<ListenSource, number>;
  limits: ListenLimits;
  /** Set while a limit is reached: which one. */
  limited?: 'minute' | 'hour' | 'day' | 'audio_day';
}

interface Stored {
  day: string;
  requests: number;
  audioSeconds: number;
  billedSeconds: number;
  estimatedUsd: number;
  bySource: Record<ListenSource, number>;
  hours: Record<string, number>;
}

const emptyDay = (day: string): Stored => ({ day, requests: 0, audioSeconds: 0, billedSeconds: 0, estimatedUsd: 0, bySource: { windows: 0, discord: 0 }, hours: {} });

export class ListenUsage {
  private stored: Stored;
  private minute: number[] = [];

  constructor(
    readonly limits: ListenLimits = DEFAULT_LISTEN_LIMITS,
    private readonly path: string | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.stored = this.load();
  }

  /** Whether one more request of this length may go now; null when it may, else the limit it would pass. Records nothing. */
  refusal(durationMs: number): ListenUsageToday['limited'] | null {
    const at = this.now();
    this.roll(at);
    this.minute = this.minute.filter(time => at - time < 60_000);
    const seconds = Math.max(0, durationMs) / 1000;
    if (this.minute.length >= this.limits.perMinute) return 'minute';
    if (this.stored.requests >= this.limits.perDay) return 'day';
    if ((this.stored.hours[hourOf(at)] ?? 0) + seconds > this.limits.audioSecondsPerHour) return 'hour';
    if (this.stored.audioSeconds + seconds > this.limits.audioSecondsPerDay) return 'audio_day';
    return null;
  }

  /** A request was sent to Groq (whatever it answered: Groq bills it). */
  record(durationMs: number, source: ListenSource): void {
    const at = this.now();
    this.roll(at);
    const seconds = Math.max(0, durationMs) / 1000;
    this.minute.push(at);
    const day = this.stored;
    day.requests += 1;
    day.audioSeconds += seconds;
    day.billedSeconds += billedSeconds(durationMs);
    day.estimatedUsd += estimatedUsd(durationMs);
    day.bySource[source] += 1;
    const hour = hourOf(at);
    day.hours = { [hour]: (day.hours[hour] ?? 0) + seconds };
    this.save();
  }

  today(): ListenUsageToday {
    const at = this.now();
    this.roll(at);
    const day = this.stored;
    const limited = this.refusal(0);
    return {
      day: day.day, requests: day.requests, audioSeconds: round(day.audioSeconds), billedSeconds: round(day.billedSeconds),
      estimatedUsd: Math.round(day.estimatedUsd * 10_000) / 10_000, bySource: { ...day.bySource }, limits: this.limits,
      ...(limited ? { limited } : {}),
    };
  }

  private roll(at: number): void {
    const day = dayOf(at);
    if (this.stored.day !== day) this.stored = emptyDay(day);
  }

  private load(): Stored {
    const day = dayOf(this.now());
    if (!this.path) return emptyDay(day);
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Stored>;
      if (value.day !== day || typeof value.requests !== 'number') return emptyDay(day);
      return { ...emptyDay(day), ...value, bySource: { windows: value.bySource?.windows ?? 0, discord: value.bySource?.discord ?? 0 }, hours: value.hours ?? {} };
    } catch {
      return emptyDay(day);
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.stored), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // Counting never fails a turn; the in-memory counts still hold the limits until a restart.
    }
  }
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function hourOf(at: number): string {
  return new Date(at).toISOString().slice(0, 13);
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function configuredListenLimits(environment: Readonly<Record<string, string | undefined>>): ListenLimits {
  const read = (name: string, fallback: number, maximum: number): number => {
    const value = Number(environment[name]);
    return Number.isFinite(value) && value >= 1 && value <= maximum ? Math.floor(value) : fallback;
  };
  return {
    perMinute: read('SHANNON_VOICE_LISTEN_MAX_PER_MINUTE', DEFAULT_LISTEN_LIMITS.perMinute, 10_000),
    perDay: read('SHANNON_VOICE_LISTEN_MAX_PER_DAY', DEFAULT_LISTEN_LIMITS.perDay, 1_000_000),
    audioSecondsPerHour: read('SHANNON_VOICE_LISTEN_MAX_AUDIO_SECONDS_PER_HOUR', DEFAULT_LISTEN_LIMITS.audioSecondsPerHour, 1_000_000),
    audioSecondsPerDay: read('SHANNON_VOICE_LISTEN_MAX_AUDIO_SECONDS_PER_DAY', DEFAULT_LISTEN_LIMITS.audioSecondsPerDay, 10_000_000),
  };
}
