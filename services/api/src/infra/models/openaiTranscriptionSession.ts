export const SHANNON_OPENAI_TRANSCRIPTION_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
] as const;
export const SHANNON_OPENAI_TRANSCRIPTION_DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

/// Product vocabulary that Japanese speech recognition tends to mis-hear.
const TRANSCRIPTION_PROMPT = 'シャノン、ライ、Aether、Voyager、Syzygy、Jev、Minebot、Codex、SwiftUI、TestFlight';

export interface OpenAITranscriptionSession {
  token: string;
  model: string;
  expiresAt: string;
  inputUsdPerMinute: number;
}

export type OpenAITranscriptionFailureCode =
  | 'OPENAI_TRANSCRIPTION_NOT_CONFIGURED'
  | 'OPENAI_TRANSCRIPTION_TOKEN_FAILED';

export class OpenAITranscriptionError extends Error {
  constructor(
    readonly code: OpenAITranscriptionFailureCode,
    readonly upstreamStatus?: number,
    readonly upstreamCode?: string,
  ) {
    super(code);
  }
}

interface OpenAITranscriptionGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  secretLifetimeSeconds?: number;
  silenceDurationMilliseconds?: number;
  inputUsdPerMinute?: number;
}

/// Mints a short-lived Realtime client secret whose session is fixed to Japanese
/// transcription, so the iPhone connects to OpenAI directly without the permanent key.
export class OpenAITranscriptionGateway {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly secretLifetimeSeconds: number;
  private readonly silenceDurationMilliseconds: number;
  readonly inputUsdPerMinute: number;

  constructor(private readonly options: OpenAITranscriptionGatewayOptions) {
    if (!options.apiKey.trim()) throw new OpenAITranscriptionError('OPENAI_TRANSCRIPTION_NOT_CONFIGURED');
    this.model = validModel(options.model ?? SHANNON_OPENAI_TRANSCRIPTION_DEFAULT_MODEL);
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/realtime/client_secrets';
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.secretLifetimeSeconds = boundedNumber(options.secretLifetimeSeconds, 30, 3_600, 300);
    this.silenceDurationMilliseconds = boundedNumber(options.silenceDurationMilliseconds, 200, 2_000, 360);
    this.inputUsdPerMinute = boundedNumber(
      options.inputUsdPerMinute,
      0,
      10,
      this.model === 'gpt-4o-transcribe' ? 0.006 : 0.003,
    );
  }

  async createSession(): Promise<OpenAITranscriptionSession> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: this.secretLifetimeSeconds },
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24_000 },
                transcription: { model: this.model, language: 'ja', prompt: TRANSCRIPTION_PROMPT },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: this.silenceDurationMilliseconds,
                },
              },
            },
          },
        }),
      });
    } catch {
      throw new OpenAITranscriptionError('OPENAI_TRANSCRIPTION_TOKEN_FAILED');
    }
    const responseText = await response.text();
    if (!response.ok) {
      throw new OpenAITranscriptionError(
        'OPENAI_TRANSCRIPTION_TOKEN_FAILED',
        response.status,
        safeUpstreamCode(responseText),
      );
    }
    const secret = clientSecret(responseText, this.now(), this.secretLifetimeSeconds);
    return Object.freeze({
      token: secret.token,
      model: this.model,
      expiresAt: secret.expiresAt,
      inputUsdPerMinute: this.inputUsdPerMinute,
    });
  }
}

export function createConfiguredOpenAITranscriptionGateway(
  environment: Readonly<Record<string, string | undefined>>,
): OpenAITranscriptionGateway | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAITranscriptionGateway({
    apiKey,
    model: environment.SHANNON_VOICE_CALL_TRANSCRIPTION_MODEL,
    endpoint: environment.SHANNON_VOICE_CALL_CLIENT_SECRET_ENDPOINT,
    secretLifetimeSeconds: optionalNumber(environment.SHANNON_VOICE_CALL_SECRET_SECONDS),
    silenceDurationMilliseconds: optionalNumber(environment.SHANNON_VOICE_CALL_SILENCE_MS),
    inputUsdPerMinute: optionalNumber(environment.SHANNON_VOICE_CALL_USD_PER_MINUTE),
  });
}

function validModel(value: string): string {
  const model = value.trim();
  if (!(SHANNON_OPENAI_TRANSCRIPTION_MODELS as readonly string[]).includes(model)) {
    throw new Error('SHANNON_VOICE_CALL_TRANSCRIPTION_MODEL is invalid');
  }
  return model;
}

function clientSecret(
  responseText: string,
  now: Date,
  lifetimeSeconds: number,
): { token: string; expiresAt: string } {
  try {
    const value = record(JSON.parse(responseText) as unknown);
    const token = value?.value;
    if (typeof token === 'string' && /^ek_[A-Za-z0-9_-]{8,512}$/.test(token)) {
      const expires = value?.expires_at;
      const expiresMilliseconds = typeof expires === 'number' && Number.isFinite(expires) && expires > 0
        ? expires * 1_000
        : now.getTime() + lifetimeSeconds * 1_000;
      return { token, expiresAt: new Date(expiresMilliseconds).toISOString() };
    }
  } catch {
    // Handled below without exposing the upstream response.
  }
  throw new OpenAITranscriptionError('OPENAI_TRANSCRIPTION_TOKEN_FAILED');
}

function safeUpstreamCode(value: string): string | undefined {
  try {
    const error = record(record(JSON.parse(value) as unknown)?.error);
    const code = error?.code ?? error?.type;
    return typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
