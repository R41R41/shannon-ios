import { DatabaseSync } from 'node:sqlite';

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

export class SQLiteVoiceIdentityStore implements ShannonVoiceIdentityStore {
  private readonly database: DatabaseSync;

  constructor(
    path: string,
    private readonly automaticVoice: ShannonRealtimeVoiceId = 'marin',
  ) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS voice_identity_preferences (
        scope_key TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('automatic','manual')),
        selected_voice TEXT CHECK (selected_voice IN ('marin','cedar','coral')),
        updated_at TEXT NOT NULL,
        CHECK (
          (mode = 'automatic' AND selected_voice IS NULL)
          OR (mode = 'manual' AND selected_voice IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS voice_identity_preview_usage (
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, day_key)
      );
    `);
  }

  read(scopeKey: string): ShannonVoiceIdentityPreference {
    const row = this.database.prepare(`
      SELECT mode, selected_voice, updated_at
      FROM voice_identity_preferences
      WHERE scope_key = ?
    `).get(scopeKey) as unknown as {
      mode: ShannonVoiceIdentityMode;
      selected_voice: ShannonRealtimeVoiceId | null;
      updated_at: string;
    } | undefined;
    return row
      ? normalizedPreference(row.mode, row.selected_voice, this.automaticVoice, row.updated_at)
      : automaticPreference(this.automaticVoice);
  }

  save(
    scopeKey: string,
    mode: ShannonVoiceIdentityMode,
    selectedVoice: ShannonRealtimeVoiceId | null,
    updatedAt: string,
  ): ShannonVoiceIdentityPreference {
    const preference = normalizedPreference(mode, selectedVoice, this.automaticVoice, updatedAt);
    this.database.prepare(`
      INSERT INTO voice_identity_preferences (scope_key, mode, selected_voice, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        mode = excluded.mode,
        selected_voice = excluded.selected_voice,
        updated_at = excluded.updated_at
    `).run(scopeKey, preference.mode, preference.selectedVoice, preference.updatedAt);
    return preference;
  }

  close(): void {
    this.database.close();
  }

  consumePreviewAllowance(scopeKey: string, at = new Date(), maximumPerDay = 12): boolean {
    const dayKey = japanDayKey(at);
    const changed = this.database.prepare(`
      INSERT INTO voice_identity_preview_usage (scope_key, day_key, request_count, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(scope_key, day_key) DO UPDATE SET
        request_count = request_count + 1,
        updated_at = excluded.updated_at
      WHERE request_count < ?
    `).run(scopeKey, dayKey, at.toISOString(), maximumPerDay).changes;
    this.database.prepare(`
      DELETE FROM voice_identity_preview_usage WHERE day_key < ?
    `).run(japanDayKey(new Date(at.getTime() - 14 * 86_400_000)));
    return changed === 1;
  }
}

function automaticPreference(automaticVoice: ShannonRealtimeVoiceId): ShannonVoiceIdentityPreference {
  return {
    mode: 'automatic',
    selectedVoice: null,
    effectiveVoice: automaticVoice,
    updatedAt: null,
  };
}

function normalizedPreference(
  mode: ShannonVoiceIdentityMode,
  selectedVoice: ShannonRealtimeVoiceId | null,
  automaticVoice: ShannonRealtimeVoiceId,
  updatedAt: string,
): ShannonVoiceIdentityPreference {
  if (mode === 'manual' && !selectedVoice) throw new Error('VOICE_IDENTITY_SELECTION_REQUIRED');
  return {
    mode,
    selectedVoice: mode === 'manual' ? selectedVoice : null,
    effectiveVoice: mode === 'manual' ? selectedVoice as ShannonRealtimeVoiceId : automaticVoice,
    updatedAt,
  };
}

function validIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(normalized)) throw new Error('voice preview identifier is invalid');
  return normalized;
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : fallback;
}

function optionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function japanDayKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
