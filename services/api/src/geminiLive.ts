export const SHANNON_GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';

export interface GeminiLiveSessionRequest {
  scopeKey: string;
  threadId: string;
  instructions: string;
}

export interface GeminiLiveSession {
  token: string;
  model: string;
  voice: string;
  threadId: string;
  instructions: string;
  expiresAt: string;
  inputUsdPerMinute: number;
  outputUsdPerMinute: number;
}

export type GeminiLiveFailureCode =
  | 'GEMINI_LIVE_NOT_CONFIGURED'
  | 'GEMINI_LIVE_TOKEN_FAILED';

export class GeminiLiveError extends Error {
  constructor(
    readonly code: GeminiLiveFailureCode,
    readonly upstreamStatus?: number,
    readonly upstreamCode?: string,
  ) {
    super(code);
  }
}

interface GeminiLiveGatewayOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  sessionLifetimeMinutes?: number;
  inputUsdPerMinute?: number;
  outputUsdPerMinute?: number;
}

export class GoogleGeminiLiveGateway {
  readonly model: string;
  readonly voice: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly sessionLifetimeMinutes: number;
  private readonly inputUsdPerMinute: number;
  private readonly outputUsdPerMinute: number;

  constructor(private readonly options: GeminiLiveGatewayOptions) {
    if (!options.apiKey.trim()) throw new GeminiLiveError('GEMINI_LIVE_NOT_CONFIGURED');
    this.model = validModel(options.model ?? SHANNON_GEMINI_TRANSCRIBE_MODEL);
    this.voice = validIdentifier(options.voice ?? 'Aoede', 'SHANNON_GEMINI_LIVE_VOICE');
    this.endpoint = options.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sessionLifetimeMinutes = boundedNumber(options.sessionLifetimeMinutes, 5, 30, 20);
    this.inputUsdPerMinute = boundedNumber(options.inputUsdPerMinute, 0, 10, 0.005);
    this.outputUsdPerMinute = boundedNumber(options.outputUsdPerMinute, 0, 10, 0.018);
  }

  async createSession(request: GeminiLiveSessionRequest): Promise<GeminiLiveSession> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionLifetimeMinutes * 60_000).toISOString();
    const newSessionExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.options.apiKey,
        },
        body: JSON.stringify({
          uses: 1,
          expireTime: expiresAt,
          newSessionExpireTime: newSessionExpiresAt,
          fieldMask: 'model,generationConfig.responseModalities',
          bidiGenerateContentSetup: {
            model: `models/${this.model}`,
            generationConfig: {
              responseModalities: ['TEXT'],
            },
          },
        }),
      });
    } catch {
      throw new GeminiLiveError('GEMINI_LIVE_TOKEN_FAILED');
    }
    const responseText = await response.text();
    if (!response.ok) {
      throw new GeminiLiveError(
        'GEMINI_LIVE_TOKEN_FAILED',
        response.status,
        safeUpstreamCode(responseText),
      );
    }
    const token = tokenName(responseText);
    return Object.freeze({
      token,
      model: this.model,
      voice: this.voice,
      threadId: request.threadId,
      instructions: request.instructions,
      expiresAt,
      inputUsdPerMinute: this.inputUsdPerMinute,
      outputUsdPerMinute: this.outputUsdPerMinute,
    });
  }
}

export function createConfiguredGeminiLiveGateway(
  environment: Readonly<Record<string, string | undefined>>,
): GoogleGeminiLiveGateway | null {
  const apiKey = environment.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGeminiLiveGateway({
    apiKey,
    model: environment.SHANNON_GEMINI_TRANSCRIBE_MODEL,
    voice: environment.SHANNON_GEMINI_TTS_VOICE,
    endpoint: environment.SHANNON_GEMINI_LIVE_TOKEN_ENDPOINT,
    sessionLifetimeMinutes: optionalNumber(environment.SHANNON_GEMINI_LIVE_SESSION_MINUTES),
    inputUsdPerMinute: optionalNumber(environment.SHANNON_GEMINI_LIVE_INPUT_USD_PER_MINUTE),
    outputUsdPerMinute: optionalNumber(environment.SHANNON_GEMINI_LIVE_OUTPUT_USD_PER_MINUTE),
  });
}

function validModel(value: string): string {
  const model = value.trim();
  if (model !== SHANNON_GEMINI_TRANSCRIBE_MODEL) {
    throw new Error('SHANNON_GEMINI_TRANSCRIBE_MODEL is invalid');
  }
  return model;
}

function validIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function tokenName(responseText: string): string {
  try {
    const value = JSON.parse(responseText) as unknown;
    const name = record(value)?.name;
    if (typeof name === 'string' && name.length >= 12 && name.length <= 4_096) return name;
  } catch {
    // Handled below without exposing the upstream response.
  }
  throw new GeminiLiveError('GEMINI_LIVE_TOKEN_FAILED');
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
