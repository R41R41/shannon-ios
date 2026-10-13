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
  /** The session sends per-token log-probabilities with each transcript (the client's `userUtterance.confidence`). */
  transcriptionLogprobs: boolean;
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

/**
 * How the transcription session decides that he finished an utterance (owner's Windows call, 2026-10-14: a 360 ms silence split
 * his sentences). `semantic`: OpenAI's `semantic_vad`, which waits while the words sound unfinished, at `eagerness`; `server`: the
 * volume-based `server_vad` with `silenceDurationMilliseconds` (650 ms by default). A session the provider refuses with semantic
 * detection is minted again at once with the server one, and this gateway keeps to the server one from then on.
 */
export type TranscriptionTurnDetection = 'semantic' | 'server';
export type SemanticVadEagerness = 'low' | 'medium' | 'high' | 'auto';
const EAGERNESS: readonly SemanticVadEagerness[] = ['low', 'medium', 'high', 'auto'];
export const DEFAULT_TRANSCRIPTION_SILENCE_MILLISECONDS = 650;

interface OpenAITranscriptionGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  secretLifetimeSeconds?: number;
  silenceDurationMilliseconds?: number;
  inputUsdPerMinute?: number;
  turnDetection?: TranscriptionTurnDetection;
  eagerness?: SemanticVadEagerness;
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
  private readonly eagerness: SemanticVadEagerness;
  /** `semantic` until the provider refuses a session with it. */
  private turnDetection: TranscriptionTurnDetection;
  /**
   * Whether sessions ask for the transcript's log-probabilities (`include: item.input_audio_transcription.logprobs`), from which
   * the iOS and Windows clients compute `userUtterance.confidence`. They come with the transcript itself: no extra request, and
   * no price of their own. Dropped, like semantic detection, only if the provider refuses a session with them.
   */
  private logprobs = true;
  readonly inputUsdPerMinute: number;

  constructor(private readonly options: OpenAITranscriptionGatewayOptions) {
    if (!options.apiKey.trim()) throw new OpenAITranscriptionError('OPENAI_TRANSCRIPTION_NOT_CONFIGURED');
    this.model = validModel(options.model ?? SHANNON_OPENAI_TRANSCRIPTION_DEFAULT_MODEL);
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/realtime/client_secrets';
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.secretLifetimeSeconds = boundedNumber(options.secretLifetimeSeconds, 30, 3_600, 300);
    this.silenceDurationMilliseconds = boundedNumber(options.silenceDurationMilliseconds, 200, 2_000, DEFAULT_TRANSCRIPTION_SILENCE_MILLISECONDS);
    this.turnDetection = options.turnDetection === 'server' ? 'server' : 'semantic';
    this.eagerness = options.eagerness && EAGERNESS.includes(options.eagerness) ? options.eagerness : 'medium';
    this.inputUsdPerMinute = boundedNumber(
      options.inputUsdPerMinute,
      0,
      10,
      this.model === 'gpt-4o-transcribe' ? 0.006 : 0.003,
    );
  }

  /** The turn detection sessions are minted with now: `semantic` until the provider refused it once. */
  get detection(): TranscriptionTurnDetection { return this.turnDetection; }

  private turnDetectionBody(): Record<string, unknown> {
    return this.turnDetection === 'semantic'
      ? { type: 'semantic_vad', eagerness: this.eagerness }
      : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: this.silenceDurationMilliseconds };
  }

  async createSession(): Promise<OpenAITranscriptionSession> {
    let response = await this.requestSecret();
    // A session the provider refuses (400) is minted again at once with less: first the server detection instead of the semantic
    // one, then without log-probabilities; this gateway keeps to what was accepted from then on. Never a broken call.
    while (response.status === 400 && this.downgrade()) response = await this.requestSecret();
    return this.secretFrom(response);
  }

  /** One step down after a refused session; false when nothing is left to drop. */
  private downgrade(): boolean {
    if (this.turnDetection === 'semantic') {
      this.turnDetection = 'server';
      console.warn('Shannon transcription session: semantic turn detection refused, using server_vad');
      return true;
    }
    if (!this.logprobs) return false;
    this.logprobs = false;
    console.warn('Shannon transcription session: transcript logprobs refused, minting without them');
    return true;
  }

  private async secretFrom(response: { ok: boolean; status: number; text: string }): Promise<OpenAITranscriptionSession> {
    if (!response.ok) {
      throw new OpenAITranscriptionError(
        'OPENAI_TRANSCRIPTION_TOKEN_FAILED',
        response.status,
        safeUpstreamCode(response.text),
      );
    }
    const secret = clientSecret(response.text, this.now(), this.secretLifetimeSeconds);
    return Object.freeze({
      token: secret.token,
      model: this.model,
      expiresAt: secret.expiresAt,
      inputUsdPerMinute: this.inputUsdPerMinute,
      transcriptionLogprobs: this.logprobs,
    });
  }

  private async requestSecret(): Promise<{ ok: boolean; status: number; text: string }> {
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
            ...(this.logprobs ? { include: ['item.input_audio_transcription.logprobs'] } : {}),
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24_000 },
                transcription: { model: this.model, language: 'ja', prompt: TRANSCRIPTION_PROMPT },
                turn_detection: this.turnDetectionBody(),
              },
            },
          },
        }),
      });
    } catch {
      throw new OpenAITranscriptionError('OPENAI_TRANSCRIPTION_TOKEN_FAILED');
    }
    return { ok: response.ok, status: response.status, text: await response.text() };
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
    // `server` keeps the volume-based detection; anything else (unset included) is semantic.
    turnDetection: environment.SHANNON_VOICE_CALL_TURN_DETECTION?.trim().toLowerCase() === 'server' ? 'server' : 'semantic',
    eagerness: environment.SHANNON_VOICE_CALL_VAD_EAGERNESS?.trim().toLowerCase() as SemanticVadEagerness | undefined,
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
