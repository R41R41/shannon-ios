import { automaticPreference, normalizedPreference, validIdentifier, boundedInteger, optionalInteger } from './store/voiceIdentityStore.js';
export { SQLiteVoiceIdentityStore } from './store/voiceIdentityStore.js';

export const SHANNON_REALTIME_VOICE_CANDIDATES = [
  { id: 'marin', name: 'Marin' },
  { id: 'cedar', name: 'Cedar' },
  { id: 'coral', name: 'Coral' },
] as const;

export type ShannonRealtimeVoiceId = typeof SHANNON_REALTIME_VOICE_CANDIDATES[number]['id'];
export type ShannonVoiceIdentityMode = 'automatic' | 'manual';

export interface ShannonVoiceIdentityPreference {
  readonly mode: ShannonVoiceIdentityMode;
  readonly selectedVoice: ShannonRealtimeVoiceId | null;
  readonly effectiveVoice: ShannonRealtimeVoiceId;
  readonly updatedAt: string | null;
}

export interface ShannonVoiceIdentityStore {
  read(scopeKey: string): ShannonVoiceIdentityPreference;
  save(
    scopeKey: string,
    mode: ShannonVoiceIdentityMode,
    selectedVoice: ShannonRealtimeVoiceId | null,
    updatedAt: string,
  ): ShannonVoiceIdentityPreference;
}

export interface ShannonVoicePreview {
  readonly audio: Uint8Array;
  readonly contentType: 'audio/mpeg';
}

export class VoicePreviewError extends Error {
  constructor(readonly code: 'VOICE_PREVIEW_NOT_CONFIGURED' | 'VOICE_PREVIEW_FAILED') {
    super(code);
  }
}

interface OpenAIVoicePreviewGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
}

export class OpenAIVoicePreviewGateway {
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: OpenAIVoicePreviewGatewayOptions) {
    if (!options.apiKey.trim()) throw new VoicePreviewError('VOICE_PREVIEW_NOT_CONFIGURED');
    this.model = validIdentifier(options.model ?? 'gpt-4o-mini-tts');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/audio/speech';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = boundedInteger(options.timeoutMilliseconds, 5_000, 60_000, 30_000);
  }

  async preview(voice: ShannonRealtimeVoiceId): Promise<ShannonVoicePreview> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          voice,
          input: 'こんにちは、シャノンです。今日も一緒に、ゆっくり考えていきましょう。',
          instructions: '自然で親しみやすい日本語で、落ち着いて話してください。',
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      throw new VoicePreviewError('VOICE_PREVIEW_FAILED');
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!response.ok || contentType !== 'audio/mpeg') {
      throw new VoicePreviewError('VOICE_PREVIEW_FAILED');
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (!audio.byteLength || audio.byteLength > 2 * 1024 * 1024) {
      throw new VoicePreviewError('VOICE_PREVIEW_FAILED');
    }
    return { audio, contentType: 'audio/mpeg' };
  }
}

export function createConfiguredVoicePreviewGateway(
  environment: Readonly<Record<string, string | undefined>>,
): OpenAIVoicePreviewGateway | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAIVoicePreviewGateway({
    apiKey,
    model: environment.SHANNON_VOICE_PREVIEW_MODEL,
    endpoint: environment.SHANNON_VOICE_PREVIEW_ENDPOINT,
    timeoutMilliseconds: optionalInteger(environment.SHANNON_VOICE_PREVIEW_TIMEOUT_MS),
  });
}

export function isShannonRealtimeVoiceId(value: unknown): value is ShannonRealtimeVoiceId {
  return SHANNON_REALTIME_VOICE_CANDIDATES.some(candidate => candidate.id === value);
}

export function voiceIdentityResponse(preference: ShannonVoiceIdentityPreference): {
  preference: ShannonVoiceIdentityPreference;
  candidates: typeof SHANNON_REALTIME_VOICE_CANDIDATES;
} {
  return { preference, candidates: SHANNON_REALTIME_VOICE_CANDIDATES };
}

export class InMemoryVoiceIdentityStore implements ShannonVoiceIdentityStore {
  private readonly preferences = new Map<string, ShannonVoiceIdentityPreference>();

  constructor(private readonly automaticVoice: ShannonRealtimeVoiceId = 'marin') {}

  read(scopeKey: string): ShannonVoiceIdentityPreference {
    return this.preferences.get(scopeKey) ?? automaticPreference(this.automaticVoice);
  }

  save(
    scopeKey: string,
    mode: ShannonVoiceIdentityMode,
    selectedVoice: ShannonRealtimeVoiceId | null,
    updatedAt: string,
  ): ShannonVoiceIdentityPreference {
    const preference = normalizedPreference(mode, selectedVoice, this.automaticVoice, updatedAt);
    this.preferences.set(scopeKey, preference);
    return preference;
  }
}
