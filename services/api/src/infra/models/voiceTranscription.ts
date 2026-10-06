import type { LlmUsageStore } from './llmUsage.js';

export const SHANNON_VOICE_MAXIMUM_BYTES = 5 * 1024 * 1024;
export const SHANNON_VOICE_MAXIMUM_SECONDS = 60;

export interface VoiceTranscriptionRequest {
  scopeKey: string;
  audio: Uint8Array;
  mimeType: string;
  durationSeconds: number;
}

export interface VoiceTranscriptionResult {
  transcript: string;
  model: string;
  durationSeconds: number;
  estimatedCostUsd: number;
}

export interface VoiceTranscriber {
  transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult>;
}

export type VoiceTranscriptionFailureCode =
  | 'VOICE_NOT_CONFIGURED'
  | 'VOICE_INVALID_AUDIO'
  | 'VOICE_DURATION_INVALID'
  | 'VOICE_DAILY_BUDGET_EXHAUSTED'
  | 'VOICE_TRANSCRIPTION_FAILED'
  | 'VOICE_TRANSCRIPT_EMPTY';

export class VoiceTranscriptionError extends Error {
  constructor(
    readonly code: VoiceTranscriptionFailureCode,
    readonly upstreamStatus?: number,
    readonly upstreamCode?: string,
  ) {
    super(code);
  }
}

interface OpenAIVoiceTranscriberOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
  usdPerMinute?: number;
  dailyBudgetUsd?: number;
  usageStore?: LlmUsageStore;
  now?: () => Date;
}

export class OpenAIVoiceTranscriber implements VoiceTranscriber {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;
  private readonly usdPerMinute: number;
  private readonly dailyBudgetUsd: number;
  private readonly now: () => Date;

  constructor(private readonly options: OpenAIVoiceTranscriberOptions) {
    if (!options.apiKey.trim()) throw new VoiceTranscriptionError('VOICE_NOT_CONFIGURED');
    this.model = validVoiceModel(options.model ?? 'gpt-transcribe');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/audio/transcriptions';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = boundedNumber(options.timeoutMilliseconds, 5_000, 120_000, 60_000);
    this.usdPerMinute = boundedNumber(options.usdPerMinute, 0, 10, 0.0045);
    this.dailyBudgetUsd = boundedNumber(options.dailyBudgetUsd, 0, 100, 0.10);
    this.now = options.now ?? (() => new Date());
  }

  async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    validateVoiceRequest(request);
    const timestamp = this.now();
    const dayKey = japanDayKey(timestamp);
    const spent = this.options.usageStore?.voiceLlmCostUsdForDay?.(request.scopeKey, dayKey) ?? 0;
    const estimatedCostUsd = roundUsd(request.durationSeconds / 60 * this.usdPerMinute);
    if (spent + estimatedCostUsd > this.dailyBudgetUsd) {
      throw new VoiceTranscriptionError('VOICE_DAILY_BUDGET_EXHAUSTED');
    }

    const form = new FormData();
    const blob = new Blob([request.audio], { type: normalizedVoiceMimeType(request.mimeType) });
    form.append('file', blob, 'shannon-voice.m4a');
    form.append('model', this.model);
    form.append('language', 'ja');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch {
      throw new VoiceTranscriptionError('VOICE_TRANSCRIPTION_FAILED');
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new VoiceTranscriptionError(
        'VOICE_TRANSCRIPTION_FAILED',
        response.status,
        safeUpstreamCode(body),
      );
    }

    const value = await response.json() as unknown;
    const transcript = transcriptionText(value);
    if (!transcript) throw new VoiceTranscriptionError('VOICE_TRANSCRIPT_EMPTY');
    const usage = transcriptionUsage(value);
    this.options.usageStore?.recordLlmUsage({
      scopeKey: request.scopeKey,
      lane: 'voice',
      model: this.model,
      ...usage,
      estimatedCostUsd,
      occurredAt: timestamp.toISOString(),
    });
    return Object.freeze({
      transcript,
      model: this.model,
      durationSeconds: request.durationSeconds,
      estimatedCostUsd,
    });
  }
}

export function createConfiguredVoiceTranscriber(
  environment: Readonly<Record<string, string | undefined>>,
  usageStore?: LlmUsageStore,
): VoiceTranscriber | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAIVoiceTranscriber({
    apiKey,
    model: environment.SHANNON_VOICE_TRANSCRIPTION_MODEL,
    endpoint: environment.SHANNON_VOICE_TRANSCRIPTION_ENDPOINT,
    timeoutMilliseconds: optionalNumber(environment.SHANNON_VOICE_TRANSCRIPTION_TIMEOUT_MS),
    usdPerMinute: optionalNumber(environment.SHANNON_VOICE_USD_PER_MINUTE),
    dailyBudgetUsd: optionalNumber(environment.SHANNON_VOICE_DAILY_BUDGET_USD),
    usageStore,
  });
}

export function normalizedVoiceMimeType(value: string | undefined): string {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'audio/mp4' || normalized === 'audio/m4a' || normalized === 'audio/x-m4a') {
    return 'audio/mp4';
  }
  throw new VoiceTranscriptionError('VOICE_INVALID_AUDIO');
}

export function parsedVoiceDurationSeconds(value: string | string[] | undefined): number {
  const scalar = Array.isArray(value) ? value[0] : value;
  const milliseconds = Number(scalar);
  const seconds = milliseconds / 1_000;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > SHANNON_VOICE_MAXIMUM_SECONDS) {
    throw new VoiceTranscriptionError('VOICE_DURATION_INVALID');
  }
  return seconds;
}

function validateVoiceRequest(request: VoiceTranscriptionRequest): void {
  normalizedVoiceMimeType(request.mimeType);
  if (!request.audio.byteLength || request.audio.byteLength > SHANNON_VOICE_MAXIMUM_BYTES) {
    throw new VoiceTranscriptionError('VOICE_INVALID_AUDIO');
  }
  if (!Number.isFinite(request.durationSeconds)
    || request.durationSeconds <= 0
    || request.durationSeconds > SHANNON_VOICE_MAXIMUM_SECONDS) {
    throw new VoiceTranscriptionError('VOICE_DURATION_INVALID');
  }
}

function validVoiceModel(value: string): string {
  const model = value.trim();
  const supported = new Set([
    'gpt-transcribe',
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'gpt-4o-transcribe-diarize',
    'whisper-1',
  ]);
  if (!supported.has(model)) throw new Error('SHANNON_VOICE_TRANSCRIPTION_MODEL is invalid');
  return model;
}

function transcriptionText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const text = (value as Record<string, unknown>).text;
  return typeof text === 'string' ? text.trim().slice(0, 8_000) : '';
}

function transcriptionUsage(value: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const usage = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).usage
    : undefined;
  const row = usage && typeof usage === 'object' && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : {};
  const inputTokens = nonnegativeInteger(row.input_tokens);
  const outputTokens = nonnegativeInteger(row.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    totalTokens: nonnegativeInteger(row.total_tokens) || inputTokens + outputTokens,
  };
}

function japanDayKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function boundedNumber(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function safeUpstreamCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
    const value = (error as Record<string, unknown>).code ?? (error as Record<string, unknown>).type;
    return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
