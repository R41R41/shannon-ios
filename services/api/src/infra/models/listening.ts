import { GroqTranscriptionError, type GroqTranscriptionFailure, type ListenTranscriber } from './groqTranscription.js';
import type { ListenSource, ListenUsage, ListenUsageToday } from './listenUsage.js';

/**
 * Listening (owner 2026-10-26, 「常に音声認識して必要な時だけ返答する」, docs/listening-contract.md): one utterance heard by an app
 * that listens all the time (the Windows resident) or by the Discord voice channel, to text, through the one transcriber and the
 * one shared allowance. What the text is for (answering it or not) is decided by the caller with `AddressedJudge`.
 *
 * Nothing of what is heard is kept here: the audio and the words exist only for this request; only counts go to `ListenUsage`.
 *
 * Groq while it answers, the way it was when it does not (owner 2026-10-26: 「無料枠で動くうちは使って、切れていたら今の方式に切り替える」):
 * a rate limit (429), a used-up quota (402 or a quota message) or no answer at all takes listening to `unavailable` until Groq says it may
 * be asked again (Retry-After or its rate-limit reset), or for a growing pause when it says nothing (1, 5, 15, 60 min). Meanwhile no
 * request goes to Groq and the callers listen the way they did before (the resident waits for her name on the PC, the Discord body
 * transcribes with its own Whisper as it did). The first request after the pause asks Groq again. Each change of way is one log line.
 * There is no switch: only the key and Groq's answers decide.
 */
export type ListenResult =
  | { status: 'ok'; text: string; sttMs: number }
  | { status: 'empty' | 'hallucination'; sttMs: number }
  | { status: 'limited'; sttMs: 0; limited: NonNullable<ListenUsageToday['limited']>; retryAfterSeconds: number }
  | { status: 'unavailable'; sttMs: number; reason: GroqTranscriptionFailure; retryAfterSeconds: number }
  | { status: 'error'; sttMs: number; code: string };

/** The pauses when Groq says nothing of when to come back (seconds), growing with each failure in a row. */
export const LISTEN_BACKOFF_SECONDS: readonly number[] = [60, 300, 900, 3_600];
/** However long Groq asks for, ask again within a day. */
const LONGEST_PAUSE_SECONDS = 86_400;

/** The longest utterance one request may carry (the Discord collector cuts at 30 s, the resident at 15 s). */
export const LISTEN_MAXIMUM_MS = 30_000;
/** Shorter than this is a click or a breath: not sent (the resident already drops them, this is the guard for every caller). */
export const LISTEN_MINIMUM_MS = 300;

export class Listening {
  /** Until when Groq is not asked (ms since the epoch), why, and how many failures in a row led here. */
  private pausedUntil = 0;
  private pausedFor: GroqTranscriptionFailure | null = null;
  private failures = 0;
  private way: 'groq' | 'fallback' = 'groq';

  constructor(
    readonly transcriber: ListenTranscriber,
    readonly usage: ListenUsage,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = line => console.log(line),
  ) {}

  /** Which way listening goes now: Groq, or the way it was (and until when, in seconds from now). */
  state(): { way: 'groq' | 'fallback'; reason?: GroqTranscriptionFailure; retryAfterSeconds?: number } {
    const left = this.pausedUntil - this.now();
    return left > 0 && this.pausedFor ? { way: 'fallback', reason: this.pausedFor, retryAfterSeconds: Math.ceil(left / 1000) } : { way: 'groq' };
  }

  async transcribe(wav: Uint8Array, durationMs: number, source: ListenSource, signal?: AbortSignal): Promise<ListenResult> {
    if (durationMs < LISTEN_MINIMUM_MS) return { status: 'empty', sttMs: 0 };
    const paused = this.state();
    if (paused.way === 'fallback') return { status: 'unavailable', sttMs: 0, reason: paused.reason!, retryAfterSeconds: paused.retryAfterSeconds! };
    const limited = this.usage.refusal(durationMs);
    if (limited) return { status: 'limited', sttMs: 0, limited, retryAfterSeconds: limitSeconds(limited, this.now()) };
    this.usage.record(durationMs, source);
    const started = performance.now();
    try {
      const heard = await this.transcriber.transcribe(wav, signal);
      this.answered();
      return heard.status === 'ok' ? { status: 'ok', text: heard.text, sttMs: heard.ms } : { status: heard.status, sttMs: heard.ms };
    } catch (error) {
      const code: GroqTranscriptionFailure = error instanceof GroqTranscriptionError ? error.code : 'GROQ_UNREACHABLE';
      const sttMs = Math.round(performance.now() - started);
      if (code === 'GROQ_FAILED') {
        const upstreamStatus = error instanceof GroqTranscriptionError ? error.upstreamStatus : undefined;
        console.warn('Shannon listening transcription failed', { code, source, upstreamStatus });
        return { status: 'error', sttMs, code };
      }
      const retryAfterSeconds = this.pause(code, error instanceof GroqTranscriptionError ? error.retryAfterSeconds : undefined);
      return { status: 'unavailable', sttMs, reason: code, retryAfterSeconds };
    }
  }

  /** Groq answered: back to Groq (one line when it was paused). */
  private answered(): void {
    this.failures = 0;
    this.pausedFor = null;
    this.pausedUntil = 0;
    if (this.way === 'groq') return;
    this.way = 'groq';
    this.log('Shannon listening way=groq (Groq answered again)');
  }

  /** Groq refused or did not answer: listen the way it was until it may be asked again. Returns the pause in seconds. */
  private pause(reason: GroqTranscriptionFailure, retryAfter: number | undefined): number {
    const backoff = LISTEN_BACKOFF_SECONDS[Math.min(this.failures, LISTEN_BACKOFF_SECONDS.length - 1)]!;
    this.failures += 1;
    const seconds = Math.max(1, Math.min(LONGEST_PAUSE_SECONDS, Math.ceil(retryAfter ?? backoff)));
    this.pausedFor = reason;
    this.pausedUntil = this.now() + seconds * 1000;
    const until = new Date(this.pausedUntil).toISOString();
    if (this.way !== 'fallback') this.log(`Shannon listening way=fallback reason=${reason} retryAfter=${seconds}s until=${until}`);
    else this.log(`Shannon listening way=fallback reason=${reason} retryAfter=${seconds}s until=${until} (still)`);
    this.way = 'fallback';
    return seconds;
  }
}

/** Seconds until a limit of the shared allowance opens again: the minute, the UTC hour, the UTC day. */
function limitSeconds(limited: NonNullable<ListenUsageToday['limited']>, now: number): number {
  if (limited === 'minute') return 60;
  const at = new Date(now);
  const next = limited === 'hour'
    ? Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours() + 1)
    : Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** A base64 WAV of a request body, or null when it is not one (empty, too large, not base64). */
export function decodedAudio(value: unknown, maximumBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximumBytes / 3) * 4 + 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength > 0 && bytes.byteLength <= maximumBytes ? new Uint8Array(bytes) : null;
}
