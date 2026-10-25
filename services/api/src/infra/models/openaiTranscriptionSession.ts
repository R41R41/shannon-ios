export const SHANNON_OPENAI_TRANSCRIPTION_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
] as const;
export const SHANNON_OPENAI_TRANSCRIPTION_DEFAULT_MODEL = 'gpt-4o-mini-transcribe';
/**
 * The streaming transcription model for a client that ends turns itself (`manualTurns`, owner 2026-10-26: 「返答が要る時だけ gpt-live
 * で音声対話モード」). Played on 2026-10-26 with her voice: a transcription session refuses any `turn_detection` for it ("Turn detection
 * is not supported for this transcription model") and takes `null`; the words stream while he speaks, the client commits the buffer
 * when its own voice detection hears the end, and the final transcript came about 0.5 s after the commit; usage is the seconds of audio
 * sent (a 40 s pause with nothing sent kept the session and cost nothing). Published price $0.017 a minute.
 */
export const SHANNON_OPENAI_LIVE_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
const LIVE_USD_PER_MINUTE = 0.017;

/// Product vocabulary that Japanese speech recognition tends to mis-hear.
const TRANSCRIPTION_PROMPT = 'シャノン、ライ、Aether、Voyager、Syzygy、Jev、Minebot、Codex、SwiftUI、TestFlight';

export interface OpenAITranscriptionSession {
  token: string;
  model: string;
  expiresAt: string;
  inputUsdPerMinute: number;
  /** The session sends per-token log-probabilities with each transcript (the client's `userUtterance.confidence`). */
  transcriptionLogprobs: boolean;
  /**
   * How the session ends an utterance: `semantic` (`semantic_vad`), `server` (`server_vad`), or `manual`: no detection on the
   * provider's side; the client sends `input_audio_buffer.commit` at the end of each utterance (`gpt-live-transcribe`).
   */
  turnDetection: 'semantic' | 'server' | 'manual';
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
 * volume-based `server_vad` with `silenceDurationMilliseconds` (650 ms by default). Semantic detection is for the client platforms
 * that ask for it at session mint (`clientPlatform`, `semanticPlatforms`: Windows by default); every other client, and one that
 * says nothing (an older app), keeps `server_vad` until semantic detection is tested on it (review M4: the iPhone's barge-in).
 */
export type TranscriptionTurnDetection = 'semantic' | 'server';
export type SemanticVadEagerness = 'low' | 'medium' | 'high' | 'auto';
const EAGERNESS: readonly SemanticVadEagerness[] = ['low', 'medium', 'high', 'auto'];
export const DEFAULT_TRANSCRIPTION_SILENCE_MILLISECONDS = 650;
export const DEFAULT_SEMANTIC_PLATFORMS: readonly string[] = Object.freeze(['windows']);
/** A setting the provider refused is not asked for again for this long (then it is tried once more). */
const REFUSAL_MILLISECONDS = 3_600_000;
const LOGPROBS_INCLUDE = 'item.input_audio_transcription.logprobs';

/** What one mint asks for; each refusal of the provider names the part it drops. */
interface SessionSettings { detection: TranscriptionTurnDetection | 'manual'; logprobs: boolean; model: string }
type RefusedSetting = 'semantic' | 'logprobs';

interface OpenAITranscriptionGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  secretLifetimeSeconds?: number;
  silenceDurationMilliseconds?: number;
  inputUsdPerMinute?: number;
  /** `server`: no semantic detection for anyone (`SHANNON_VOICE_CALL_TURN_DETECTION=server`). */
  turnDetection?: TranscriptionTurnDetection;
  eagerness?: SemanticVadEagerness;
  /** The client platforms minted with semantic detection (`SHANNON_VOICE_CALL_SEMANTIC_PLATFORMS`). */
  semanticPlatforms?: readonly string[];
  /** The model for a client that ends its own turns (`SHANNON_VOICE_CALL_LIVE_MODEL`; default gpt-live-transcribe, `none` for none). */
  liveModel?: string | null;
  liveUsdPerMinute?: number;
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
  private readonly semanticPlatforms: ReadonlySet<string>;
  /**
   * The transcript's log-probabilities (`include`), from which the iOS and Windows clients compute `userUtterance.confidence`.
   * They come with the transcript itself: no extra request and no price of their own. A setting the provider refused (its error
   * names the parameter) is left out of new mints for `REFUSAL_MILLISECONDS`; an unrelated 400 drops nothing.
   */
  private readonly refusedUntil = new Map<RefusedSetting, number>();
  readonly inputUsdPerMinute: number;
  readonly liveModel: string | null;
  readonly liveUsdPerMinute: number;
  /** Until when a refused live mint is not asked for again (that client is minted as before meanwhile). */
  private liveRefusedUntil = 0;

  constructor(private readonly options: OpenAITranscriptionGatewayOptions) {
    if (!options.apiKey.trim()) throw new OpenAITranscriptionError('OPENAI_TRANSCRIPTION_NOT_CONFIGURED');
    this.model = validModel(options.model ?? SHANNON_OPENAI_TRANSCRIPTION_DEFAULT_MODEL);
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/realtime/client_secrets';
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.secretLifetimeSeconds = boundedNumber(options.secretLifetimeSeconds, 30, 3_600, 300);
    this.silenceDurationMilliseconds = boundedNumber(options.silenceDurationMilliseconds, 200, 2_000, DEFAULT_TRANSCRIPTION_SILENCE_MILLISECONDS);
    this.eagerness = options.eagerness && EAGERNESS.includes(options.eagerness) ? options.eagerness : 'medium';
    this.semanticPlatforms = new Set(options.turnDetection === 'server' ? [] : options.semanticPlatforms ?? DEFAULT_SEMANTIC_PLATFORMS);
    this.inputUsdPerMinute = boundedNumber(
      options.inputUsdPerMinute,
      0,
      10,
      this.model === 'gpt-4o-transcribe' ? 0.006 : 0.003,
    );
    this.liveModel = options.liveModel === undefined ? SHANNON_OPENAI_LIVE_TRANSCRIPTION_MODEL : options.liveModel;
    this.liveUsdPerMinute = boundedNumber(options.liveUsdPerMinute, 0, 10, LIVE_USD_PER_MINUTE);
  }

  private refused(setting: RefusedSetting): boolean {
    const until = this.refusedUntil.get(setting);
    return until !== undefined && this.now().getTime() < until;
  }

  /** The settings of a mint for this client: semantic only for its platforms, logprobs unless refused. */
  settingsFor(client: { platform?: string; manualTurns?: boolean } = {}): SessionSettings {
    if (client.manualTurns === true && this.liveModel && this.now().getTime() >= this.liveRefusedUntil) {
      return { detection: 'manual', logprobs: !this.refused('logprobs'), model: this.liveModel };
    }
    const semantic = client.platform !== undefined && this.semanticPlatforms.has(client.platform) && !this.refused('semantic');
    return { detection: semantic ? 'semantic' : 'server', logprobs: !this.refused('logprobs'), model: this.model };
  }

  private turnDetectionBody(settings: SessionSettings): Record<string, unknown> | null {
    if (settings.detection === 'manual') return null;
    return settings.detection === 'semantic'
      ? { type: 'semantic_vad', eagerness: this.eagerness }
      : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: this.silenceDurationMilliseconds };
  }

  async createSession(client: { platform?: string; manualTurns?: boolean } = {}): Promise<OpenAITranscriptionSession> {
    let settings = this.settingsFor(client);
    let response = await this.requestSecret(settings);
    // The live model refused (not on this account, or a provider change): this client is minted as before, and the live model is not
    // asked for again for an hour. The client reads `turnDetection` and keeps the provider's detection.
    if (settings.detection === 'manual' && !response.ok) {
      console.warn(`Shannon transcription session: ${settings.model} refused (${response.status}), minting the detected model`);
      this.liveRefusedUntil = this.now().getTime() + REFUSAL_MILLISECONDS;
      settings = this.settingsFor({ ...client, manualTurns: false });
      response = await this.requestSecret(settings);
    }
    // A refused mint is made again at once without exactly the part the provider named; each part is dropped at most once.
    for (let attempt = 0; attempt < 2 && response.status === 400; attempt += 1) {
      const dropped = refusedSetting(response.text, settings);
      if (!dropped) break;
      this.refusedUntil.set(dropped, this.now().getTime() + REFUSAL_MILLISECONDS);
      console.warn(`Shannon transcription session: ${dropped} refused by the provider, minting without it`);
      settings = dropped === 'semantic' ? { ...settings, detection: 'server' as const } : { ...settings, logprobs: false };
      response = await this.requestSecret(settings);
    }
    return this.secretFrom(response, settings);
  }

  private secretFrom(response: { ok: boolean; status: number; text: string }, settings: SessionSettings): OpenAITranscriptionSession {
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
      model: settings.model,
      expiresAt: secret.expiresAt,
      inputUsdPerMinute: settings.detection === 'manual' ? this.liveUsdPerMinute : this.inputUsdPerMinute,
      transcriptionLogprobs: settings.logprobs,
      turnDetection: settings.detection,
    });
  }

  private async requestSecret(settings: SessionSettings): Promise<{ ok: boolean; status: number; text: string }> {
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
            ...(settings.logprobs ? { include: [LOGPROBS_INCLUDE] } : {}),
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24_000 },
                transcription: { model: settings.model, language: 'ja', prompt: TRANSCRIPTION_PROMPT },
                turn_detection: this.turnDetectionBody(settings),
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

/** The part of the mint a 400 names (its `param`, else its message), when the mint asked for it; null for anything else. */
function refusedSetting(text: string, settings: SessionSettings): RefusedSetting | null {
  let named = '';
  try {
    const error = record(record(JSON.parse(text) as unknown)?.error);
    named = [error?.param, error?.message].filter(value => typeof value === 'string').join(' ').toLowerCase();
  } catch {
    return null;
  }
  if (settings.detection === 'semantic' && /turn_detection|semantic|eagerness/u.test(named)) return 'semantic';
  if (settings.logprobs && /include|logprob/u.test(named)) return 'logprobs';
  return null;
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
    // `server` keeps the volume-based detection for every client; otherwise semantic for the listed platforms (Windows unset).
    turnDetection: environment.SHANNON_VOICE_CALL_TURN_DETECTION?.trim().toLowerCase() === 'server' ? 'server' : 'semantic',
    eagerness: environment.SHANNON_VOICE_CALL_VAD_EAGERNESS?.trim().toLowerCase() as SemanticVadEagerness | undefined,
    semanticPlatforms: platformList(environment.SHANNON_VOICE_CALL_SEMANTIC_PLATFORMS),
    liveModel: liveModelOf(environment.SHANNON_VOICE_CALL_LIVE_MODEL),
    liveUsdPerMinute: optionalNumber(environment.SHANNON_VOICE_CALL_LIVE_USD_PER_MINUTE),
  });
}

/** `SHANNON_VOICE_CALL_LIVE_MODEL`: unset, gpt-live-transcribe; `none`, no live model (every client keeps the provider's detection). */
function liveModelOf(value: string | undefined): string | null | undefined {
  const model = value?.trim();
  if (!model) return undefined;
  if (model.toLowerCase() === 'none') return null;
  return /^[a-z0-9][a-z0-9.-]{0,63}$/u.test(model) ? model : undefined;
}

/** `windows,macos`; unset, the default list; `none` (or empty) for no platform. */
function platformList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map(item => item.trim().toLowerCase()).filter(item => item && item !== 'none');
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
