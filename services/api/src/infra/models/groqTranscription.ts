/**
 * Listening transcription (owner 2026-10-26, 「常時 Groq で文字起こし」): one utterance of WAV to text through Groq's
 * `whisper-large-v3-turbo`, for both the Windows resident and the Discord voice channel. Only the head holds `GROQ_API_KEY`;
 * the apps send audio here and never see the key.
 *
 * Groq's published terms (console.groq.com/docs/speech-to-text, read 2026-10-26): $0.04 per audio hour, at least 10 s billed per
 * request, 25 MB per file on the free tier; the model downsamples to 16 kHz mono itself, so the apps send 16 kHz mono WAV. A
 * request that fails is not retried with another paid model here: the caller decides (the resident falls back to its own name
 * waiting on the PC, the Discord body drops the utterance).
 */
export const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
export const GROQ_TRANSCRIPTION_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_USD_PER_HOUR = 0.04;
export const GROQ_MINIMUM_BILLED_SECONDS = 10;
/** The product words speech recognition tends to mis-hear (224 tokens at most on Groq). */
const PROMPT = 'シャノン、ライ、Aether、Voyager、Syzygy、Jev、Minebot、Codex、SwiftUI、TestFlight。シャノンとの日常会話です。';

/**
 * Phrases Whisper makes up out of silence or noise (moved from the Discord body's `voiceStt.ts`, 2026-10-26); an utterance holding
 * one is dropped, not answered.
 */
export const WHISPER_HALLUCINATIONS: readonly string[] = [
  'ご視聴ありがとうございました', 'ご視聴いただきありがとうございます', 'ご視聴頂きありがとうございました', 'チャンネル登録よろしくお願いします',
  '字幕は自動生成されています', 'ご視聴ありがとうございます', 'おやすみなさい', 'Thanks for watching', 'Thank you for watching',
  'Subscribe to my channel', 'Subtitles by', 'はじめしゃちょー', 'エンディング', 'チャンネル登録', '高評価', 'いいねボタン', 'お気に入り登録',
  '次の動画', '次回の動画', '次回へつづき', 'お楽しみに', 'ご覧いただき', 'グッドボタン', 'よろしくお願いします', '最後までご視聴',
];

export function isWhisperHallucination(text: string): boolean {
  return WHISPER_HALLUCINATIONS.some(phrase => text.includes(phrase));
}

/** What a request is billed: its length, at least 10 s. */
export function billedSeconds(durationMs: number): number {
  return Math.max(GROQ_MINIMUM_BILLED_SECONDS, Math.max(0, durationMs) / 1000);
}

export function estimatedUsd(durationMs: number): number {
  return (GROQ_USD_PER_HOUR * billedSeconds(durationMs)) / 3600;
}

export type ListenTranscript =
  | { status: 'ok'; text: string; ms: number }
  | { status: 'empty' | 'hallucination'; ms: number };

/**
 * Why Groq could not transcribe. `GROQ_RATE_LIMITED` (429) and `GROQ_QUOTA` (402, or a body that speaks of quota or credit) mean
 * the free tier or a limit is used up for a while; `GROQ_UNREACHABLE` means no answer at all (network, timeout, 5xx);
 * `GROQ_FAILED` is anything else (a request it refused). The first three take listening back to the way it was until Groq answers
 * again (`listening.ts`); the last fails one utterance only.
 */
export type GroqTranscriptionFailure = 'GROQ_RATE_LIMITED' | 'GROQ_QUOTA' | 'GROQ_UNREACHABLE' | 'GROQ_FAILED';

export class GroqTranscriptionError extends Error {
  constructor(readonly code: GroqTranscriptionFailure, readonly upstreamStatus?: number, readonly retryAfterSeconds?: number) {
    super(code);
  }
}

/** A Groq duration (`2m59.56s`, `7.66s`, `1h`), or plain seconds (`Retry-After: 30`), in seconds; null when neither. */
export function durationSeconds(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gu)) {
    matched = true;
    total += Number(amount) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : unit === 'ms' ? 0.001 : 1);
  }
  return matched ? total : null;
}

/** When Groq says it can be asked again (Retry-After, or the latest of its rate-limit resets), in seconds; undefined when it says nothing. */
export function retryAfterOf(headers: Headers): number | undefined {
  const values = ['retry-after', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset-audio-seconds']
    .map(name => durationSeconds(headers.get(name))).filter((value): value is number => value !== null && value >= 0);
  return values.length ? Math.ceil(Math.max(...values)) : undefined;
}

export interface ListenTranscriber {
  readonly model: string;
  transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<ListenTranscript>;
}

export class GroqTranscriber implements ListenTranscriber {
  readonly model = GROQ_TRANSCRIPTION_MODEL;
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly apiKey: string, options: { fetcher?: typeof fetch; endpoint?: string; timeoutMs?: number } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.endpoint = options.endpoint ?? GROQ_TRANSCRIPTION_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<ListenTranscript> {
    const started = performance.now();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', this.model);
    form.append('language', 'ja');
    form.append('prompt', PROMPT);
    form.append('temperature', '0');
    form.append('response_format', 'json');
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GroqTranscriptionError('GROQ_UNREACHABLE');
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 2_000).toLowerCase();
      const retryAfter = retryAfterOf(response.headers);
      const code: GroqTranscriptionFailure = response.status === 429 ? 'GROQ_RATE_LIMITED'
        : response.status === 402 || /quota|credit|billing|insufficient|exceeded/u.test(body) ? 'GROQ_QUOTA'
          : response.status >= 500 ? 'GROQ_UNREACHABLE' : 'GROQ_FAILED';
      throw new GroqTranscriptionError(code, response.status, retryAfter);
    }
    let text = '';
    try {
      const body = await response.json() as { text?: unknown };
      text = typeof body.text === 'string' ? body.text.trim() : '';
    } catch {
      throw new GroqTranscriptionError('GROQ_FAILED', response.status);
    }
    const ms = Math.round(performance.now() - started);
    if (!text) return { status: 'empty', ms };
    if (isWhisperHallucination(text)) return { status: 'hallucination', ms };
    return { status: 'ok', text, ms };
  }
}

/** A 16 kHz mono 16-bit WAV's length in ms from its header, or null when it is not one. */
export function wavDurationMs(wav: Uint8Array): number | null {
  if (wav.byteLength < 44) return null;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(wav[offset]!, wav[offset + 1]!, wav[offset + 2]!, wav[offset + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= wav.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 16 <= wav.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') return byteRate > 0 ? Math.round((Math.min(size, wav.byteLength - offset - 8) / byteRate) * 1000) : null;
    offset += 8 + size + (size % 2);
  }
  return null;
}
