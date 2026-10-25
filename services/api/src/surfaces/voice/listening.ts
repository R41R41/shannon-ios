import { GroqTranscriptionError, type ListenTranscriber } from '../../infra/models/groqTranscription.js';
import type { ListenSource, ListenUsage, ListenUsageToday } from '../../infra/models/listenUsage.js';

/**
 * Listening (owner 2026-10-26, 「常に音声認識して必要な時だけ返答する」, docs/listening-contract.md): one utterance heard by an app
 * that listens all the time (the Windows resident) or by the Discord voice channel, to text, through the one transcriber and the
 * one shared allowance. What the text is for (answering it or not) is decided by the caller with `AddressedJudge`.
 *
 * Nothing of what is heard is kept here: the audio and the words exist only for this request; only counts go to `ListenUsage`.
 */
export type ListenResult =
  | { status: 'ok'; text: string; sttMs: number }
  | { status: 'empty' | 'hallucination'; sttMs: number }
  | { status: 'limited'; sttMs: 0; limited: NonNullable<ListenUsageToday['limited']> }
  | { status: 'error'; sttMs: number; code: string };

/** The longest utterance one request may carry (the Discord collector cuts at 30 s, the resident at 15 s). */
export const LISTEN_MAXIMUM_MS = 30_000;
/** Shorter than this is a click or a breath: not sent (the resident already drops them, this is the guard for every caller). */
export const LISTEN_MINIMUM_MS = 300;

export class Listening {
  constructor(readonly transcriber: ListenTranscriber, readonly usage: ListenUsage) {}

  async transcribe(wav: Uint8Array, durationMs: number, source: ListenSource, signal?: AbortSignal): Promise<ListenResult> {
    if (durationMs < LISTEN_MINIMUM_MS) return { status: 'empty', sttMs: 0 };
    const limited = this.usage.refusal(durationMs);
    if (limited) return { status: 'limited', sttMs: 0, limited };
    this.usage.record(durationMs, source);
    const started = performance.now();
    try {
      const heard = await this.transcriber.transcribe(wav, signal);
      return heard.status === 'ok' ? { status: 'ok', text: heard.text, sttMs: heard.ms } : { status: heard.status, sttMs: heard.ms };
    } catch (error) {
      const code = error instanceof GroqTranscriptionError ? error.code : 'GROQ_FAILED';
      console.warn('Shannon listening transcription failed', { code, source, upstreamStatus: error instanceof GroqTranscriptionError ? error.upstreamStatus : undefined });
      return { status: 'error', sttMs: Math.round(performance.now() - started), code };
    }
  }
}

/** A base64 WAV of a request body, or null when it is not one (empty, too large, not base64). */
export function decodedAudio(value: unknown, maximumBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maximumBytes / 3) * 4 + 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength > 0 && bytes.byteLength <= maximumBytes ? new Uint8Array(bytes) : null;
}
