import type { LlmUsageStore } from './llmUsage.js';

export const SHANNON_GEMINI_SPEECH_MAXIMUM_CHARACTERS = 8_000;
export const SHANNON_GEMINI_SPEECH_MAXIMUM_BYTES = 8 * 1024 * 1024;

export interface GeminiSpeechRequest {
  scopeKey: string;
  text: string;
}

export interface GeminiSpeechResult {
  audio: Uint8Array;
  contentType: 'audio/wav';
  model: string;
  voice: string;
  durationSeconds: number;
  estimatedCostUsd: number;
}

export interface GeminiSpeechGateway {
  synthesize(request: GeminiSpeechRequest): Promise<GeminiSpeechResult>;
}

export type GeminiSpeechFailureCode =
  | 'GEMINI_SPEECH_NOT_CONFIGURED'
  | 'GEMINI_SPEECH_INVALID_TEXT'
  | 'GEMINI_SPEECH_FAILED';

export class GeminiSpeechError extends Error {
  constructor(
    readonly code: GeminiSpeechFailureCode,
    readonly upstreamStatus?: number,
    readonly upstreamCode?: string,
  ) {
    super(code);
  }
}

interface GeminiSpeechGatewayOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  style?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
  outputUsdPerTenSeconds?: number;
  usageStore?: LlmUsageStore;
  now?: () => Date;
}

export class GoogleGeminiSpeechGateway implements GeminiSpeechGateway {
  readonly model: string;
  readonly voice: string;
  private readonly style: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;
  private readonly outputUsdPerTenSeconds: number;
  private readonly now: () => Date;

  constructor(private readonly options: GeminiSpeechGatewayOptions) {
    if (!options.apiKey.trim()) throw new GeminiSpeechError('GEMINI_SPEECH_NOT_CONFIGURED');
    this.model = validGeminiSpeechModel(options.model ?? 'gemini-3.8-flash-lite-tts');
    this.voice = requiredText(options.voice ?? 'Leda', 200);
    this.style = optionalText(
      options.style ?? 'warm, naturally cute, intimate, and conversational Japanese without sounding childish or theatrical',
      500,
    );
    this.endpoint = options.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta/interactions';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = boundedNumber(options.timeoutMilliseconds, 5_000, 120_000, 60_000);
    this.outputUsdPerTenSeconds = boundedNumber(
      options.outputUsdPerTenSeconds,
      0,
      1,
      this.model === 'gemini-3.8-flash-tts' ? 0.00225 : 0.0015,
    );
    this.now = options.now ?? (() => new Date());
  }

  async synthesize(request: GeminiSpeechRequest): Promise<GeminiSpeechResult> {
    const text = normalizedSpeechText(request.text);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.options.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          input: [{
            type: 'user_input',
            content: [{
              type: 'text',
              text,
              annotations: [{ type: 'speech_metadata', style: this.style }],
            }],
          }],
          response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24_000 },
          generation_config: { speech_config: [{ voice: this.voice }] },
        }),
        signal: controller.signal,
      });
    } catch {
      throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
    } finally {
      clearTimeout(timeout);
    }
    const responseText = await response.text();
    if (!response.ok) {
      throw new GeminiSpeechError(
        'GEMINI_SPEECH_FAILED',
        response.status,
        safeUpstreamCode(responseText),
      );
    }
    const audio = decodedAudio(responseText);
    const durationSeconds = wavDurationSeconds(audio);
    const estimatedCostUsd = roundUsd(durationSeconds / 10 * this.outputUsdPerTenSeconds);
    const audioTokens = Math.max(1, Math.round(durationSeconds * 25));
    this.options.usageStore?.recordLlmUsage({
      scopeKey: request.scopeKey,
      lane: 'voice',
      model: this.model,
      inputTokens: Math.max(1, Math.ceil(text.length / 4)),
      cachedInputTokens: 0,
      outputTokens: audioTokens,
      totalTokens: Math.max(1, Math.ceil(text.length / 4)) + audioTokens,
      estimatedCostUsd,
      occurredAt: this.now().toISOString(),
    });
    return Object.freeze({
      audio,
      contentType: 'audio/wav' as const,
      model: this.model,
      voice: this.voice,
      durationSeconds,
      estimatedCostUsd,
    });
  }
}

export function createConfiguredGeminiSpeechGateway(
  environment: Readonly<Record<string, string | undefined>>,
  usageStore?: LlmUsageStore,
): GeminiSpeechGateway | null {
  const apiKey = environment.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGeminiSpeechGateway({
    apiKey,
    model: environment.SHANNON_GEMINI_TTS_MODEL,
    voice: environment.SHANNON_GEMINI_TTS_VOICE,
    style: environment.SHANNON_GEMINI_TTS_STYLE,
    endpoint: environment.SHANNON_GEMINI_TTS_ENDPOINT,
    timeoutMilliseconds: optionalNumber(environment.SHANNON_GEMINI_TTS_TIMEOUT_MS),
    outputUsdPerTenSeconds: optionalNumber(environment.SHANNON_GEMINI_TTS_OUTPUT_USD_PER_10_SECONDS),
    usageStore,
  });
}

export function normalizedSpeechText(value: unknown): string {
  if (typeof value !== 'string') throw new GeminiSpeechError('GEMINI_SPEECH_INVALID_TEXT');
  const text = value.trim();
  if (!text || text.length > SHANNON_GEMINI_SPEECH_MAXIMUM_CHARACTERS) {
    throw new GeminiSpeechError('GEMINI_SPEECH_INVALID_TEXT');
  }
  return text;
}

function decodedAudio(responseText: string): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(responseText) as unknown;
  } catch {
    throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
  }
  const root = record(value)?.interaction ?? value;
  const outputAudio = record(record(root)?.output_audio);
  const encoded = typeof outputAudio?.data === 'string'
    ? outputAudio.data
    : interactionAudioData(root);
  if (typeof encoded !== 'string' || !encoded) throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
  const audio = Buffer.from(encoded, 'base64');
  if (!audio.length || audio.length > SHANNON_GEMINI_SPEECH_MAXIMUM_BYTES) {
    throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
  }
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
  }
  return audio;
}

function interactionAudioData(value: unknown): string | undefined {
  const steps = record(value)?.steps;
  if (!Array.isArray(steps)) return undefined;
  for (const step of steps) {
    const content = record(step)?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const audio = record(item);
      if (
        audio?.type === 'audio'
        && audio.mime_type === 'audio/wav'
        && typeof audio.data === 'string'
        && audio.data
      ) return audio.data;
    }
  }
  return undefined;
}

function wavDurationSeconds(audio: Uint8Array): number {
  const buffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
    if (id === 'fmt ' && size >= 16) byteRate = buffer.readUInt32LE(body + 8);
    if (id === 'data') dataBytes = size;
    offset = body + size + (size % 2);
  }
  const duration = dataBytes / byteRate;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180) {
    throw new GeminiSpeechError('GEMINI_SPEECH_FAILED');
  }
  return duration;
}

function validGeminiSpeechModel(value: string): string {
  const model = value.trim();
  if (model !== 'gemini-3.8-flash-tts' && model !== 'gemini-3.8-flash-lite-tts') {
    throw new Error('SHANNON_GEMINI_TTS_MODEL is invalid');
  }
  return model;
}

function requiredText(value: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) throw new Error('Gemini speech setting is invalid');
  return normalized;
}

function optionalText(value: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length > maximumLength) throw new Error('Gemini speech setting is invalid');
  return normalized;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeUpstreamCode(value: string): string | undefined {
  try {
    const error = record(record(JSON.parse(value) as unknown)?.error);
    const code = error?.status ?? error?.code;
    return typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
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

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}
