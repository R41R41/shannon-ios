export interface RealtimeVoiceCallRequest {
  sdp: string;
  instructions: string;
  voice?: string;
  enableClientTools?: boolean;
}

export interface RealtimeVoiceCallResult {
  answerSdp: string;
  callId?: string;
  model: string;
  engine: ShannonVoiceEngine;
}

export type ShannonVoiceEngine = 'realtime' | 'live';

export interface ShannonVoiceSessionGateway {
  readonly engine: ShannonVoiceEngine;
  readonly model: string;
  readonly defaultVoice: string;
  createCall(request: RealtimeVoiceCallRequest): Promise<RealtimeVoiceCallResult>;
}

export interface RealtimeVoiceSessionReservationRequest {
  scopeKey: string;
  dayKey: string;
  reservedSeconds: number;
  dailyLimitSeconds: number;
  createdAt: string;
}

export interface RealtimeVoiceSessionReservation {
  reservationId: string;
  remainingSeconds: number;
}

export interface RealtimeVoiceAllowanceStatus {
  dayKey: string;
  baseAllowanceSeconds: number;
  additionalAllowanceSeconds: number;
  totalAllowanceSeconds: number;
  reservedSeconds: number;
  remainingSeconds: number;
  maximumAllowanceSeconds: number;
}

export interface RealtimeVoiceReservationStore {
  reserveRealtimeVoiceSession(
    request: RealtimeVoiceSessionReservationRequest,
  ): RealtimeVoiceSessionReservation | null;
  releaseRealtimeVoiceSessionReservation(reservationId: string): void;
  realtimeVoiceAllowanceStatus(
    scopeKey: string,
    dayKey: string,
    baseAllowanceSeconds: number,
    maximumAllowanceSeconds?: number,
  ): RealtimeVoiceAllowanceStatus;
  extendRealtimeVoiceAllowance(
    scopeKey: string,
    dayKey: string,
    baseAllowanceSeconds: number,
    additionalSeconds: number,
    maximumAllowanceSeconds: number,
    updatedAt: string,
  ): RealtimeVoiceAllowanceStatus | null;
}

export const SHANNON_REALTIME_SESSION_RESERVATION_SECONDS = 10 * 60;
export const SHANNON_REALTIME_DEFAULT_DAILY_ALLOWANCE_SECONDS = 60 * 60;
export const SHANNON_REALTIME_ALLOWANCE_EXTENSION_SECONDS = 60 * 60;
export const SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS = 24 * 60 * 60;

export type RealtimeVoiceFailureCode =
  | 'VOICE_REALTIME_NOT_CONFIGURED'
  | 'VOICE_REALTIME_INVALID_SDP'
  | 'VOICE_REALTIME_UPSTREAM_FAILED';

export class RealtimeVoiceError extends Error {
  constructor(
    readonly code: RealtimeVoiceFailureCode,
    readonly upstreamStatus?: number,
    readonly upstreamCode?: string,
    readonly upstreamRequestId?: string,
    readonly upstreamDetail?: string,
  ) {
    super(code);
  }
}

interface OpenAIRealtimeVoiceGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
  transcriptionModel?: string;
  voice?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export class OpenAIRealtimeVoiceGateway {
  readonly engine = 'realtime' as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;
  private readonly transcriptionModel: string;
  readonly defaultVoice: string;
  private readonly reasoningEffort: 'low' | 'medium' | 'high';

  constructor(private readonly options: OpenAIRealtimeVoiceGatewayOptions) {
    if (!options.apiKey.trim()) throw new RealtimeVoiceError('VOICE_REALTIME_NOT_CONFIGURED');
    this.model = validIdentifier(options.model ?? 'gpt-realtime-2', 'SHANNON_VOICE_REALTIME_MODEL');
    this.transcriptionModel = validIdentifier(
      options.transcriptionModel ?? 'gpt-live-transcribe',
      'SHANNON_VOICE_REALTIME_TRANSCRIPTION_MODEL',
    );
    this.defaultVoice = validIdentifier(options.voice ?? 'marin', 'SHANNON_VOICE_REALTIME_VOICE');
    this.reasoningEffort = options.reasoningEffort ?? 'low';
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/realtime/calls';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = boundedInteger(options.timeoutMilliseconds, 5_000, 60_000, 30_000);
  }

  async createCall(request: RealtimeVoiceCallRequest): Promise<RealtimeVoiceCallResult> {
    // SDP is a line-oriented protocol. Preserve the offer byte-for-byte,
    // including its final CRLF, instead of trimming protocol-significant
    // line endings before the multipart upload.
    const sdp = request.sdp;
    if (!validSdp(sdp)) throw new RealtimeVoiceError('VOICE_REALTIME_INVALID_SDP');

    const session = {
      type: 'realtime',
      model: this.model,
      instructions: boundedInstructions(request.instructions),
      output_modalities: ['audio'],
      max_output_tokens: 700,
      reasoning: { effort: this.reasoningEffort },
      ...(request.enableClientTools ? {
        tools: [{
          type: 'function',
          name: 'consult_shannon_backend',
          description: 'Use for current web facts, exact time, device location, weather, transit, notes, tasks, relevant memory recall, explicit commitment changes, or note/task proposal requests. The backend validates separately supplied original user input. Never claim an external write succeeded without a receipt; proposals require the existing review/apply flow.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              request: { type: 'string', description: 'The complete user request in Japanese, including corrected names and constraints.' },
            },
            required: ['request'],
          },
        }],
        tool_choice: 'auto',
      } : {}),
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          transcription: {
            model: this.transcriptionModel,
            language: 'ja',
          },
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'medium',
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          voice: validIdentifier(request.voice ?? this.defaultVoice, 'voice'),
          speed: 1,
        },
      },
      tracing: null,
      truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
    };
    const multipart = new FormData();
    multipart.set('sdp', sdp);
    multipart.set('session', JSON.stringify(session));

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/sdp',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        // Let the platform encode FormData and its boundary exactly as OpenAI's
        // official Realtime proxy example does.
        body: multipart,
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      throw new RealtimeVoiceError('VOICE_REALTIME_UPSTREAM_FAILED');
    }

    const answerSdp = await response.text();
    if (!response.ok) {
      throw new RealtimeVoiceError(
        'VOICE_REALTIME_UPSTREAM_FAILED',
        response.status,
        safeUpstreamCode(answerSdp),
        safeRequestId(response.headers.get('x-request-id')),
        safeUpstreamDetail(answerSdp),
      );
    }
    if (!validSdp(answerSdp)) {
      throw new RealtimeVoiceError('VOICE_REALTIME_UPSTREAM_FAILED', response.status, 'INVALID_ANSWER_SDP');
    }

    return {
      answerSdp,
      model: this.model,
      engine: this.engine,
      ...(callIdFromLocation(response.headers.get('location')) ? {
        callId: callIdFromLocation(response.headers.get('location')),
      } : {}),
    };
  }
}

interface OpenAILiveVoiceGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
  voice?: string;
}

/**
 * Server-side broker for GPT-Live WebRTC sessions.
 *
 * The iPhone receives only the SDP answer and a restricted data channel. The
 * standard OpenAI key and the Live session policy remain on the server.
 */
export class OpenAILiveVoiceGateway implements ShannonVoiceSessionGateway {
  readonly engine = 'live' as const;
  readonly model: string;
  readonly defaultVoice: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: OpenAILiveVoiceGatewayOptions) {
    if (!options.apiKey.trim()) throw new RealtimeVoiceError('VOICE_REALTIME_NOT_CONFIGURED');
    this.model = validIdentifier(options.model ?? 'gpt-live-1', 'SHANNON_VOICE_LIVE_MODEL');
    this.defaultVoice = validIdentifier(options.voice ?? 'marin', 'SHANNON_VOICE_LIVE_VOICE');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/live/sessions';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = boundedInteger(options.timeoutMilliseconds, 5_000, 60_000, 30_000);
  }

  async createCall(request: RealtimeVoiceCallRequest): Promise<RealtimeVoiceCallResult> {
    const sdp = request.sdp;
    if (!validSdp(sdp)) throw new RealtimeVoiceError('VOICE_REALTIME_INVALID_SDP');

    const body = {
      session: {
        model: this.model,
        instructions: boundedInstructions(request.instructions),
        delegation: { type: 'client' },
        audio: {
          output: {
            voice: validIdentifier(request.voice ?? this.defaultVoice, 'voice'),
          },
        },
        client: {
          data_channel: {
            allowed_client_events: [
              'session.commentary.append',
              'session.thinking.append',
              'session.instructions.append',
              'session.close',
            ],
            allowed_server_events: [
              { type: 'session.started' },
              { type: 'session.input_transcript.delta' },
              { type: 'session.output_transcript.delta' },
              { type: 'session.delegation.created' },
              { type: 'session.usage.updated' },
              { type: 'session.commentary.appended' },
              { type: 'session.thinking.appended' },
              { type: 'session.instructions.appended' },
              { type: 'session.closed' },
              { type: 'error' },
              { type: 'info' },
            ],
          },
        },
        store: false,
      },
      transport: { type: 'webrtc', sdp },
    };

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      throw new RealtimeVoiceError('VOICE_REALTIME_UPSTREAM_FAILED');
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new RealtimeVoiceError(
        'VOICE_REALTIME_UPSTREAM_FAILED',
        response.status,
        safeUpstreamCode(raw),
        safeRequestId(response.headers.get('x-request-id')),
        safeUpstreamDetail(raw),
      );
    }
    const parsed = safeObject(raw);
    const session = objectValue(parsed?.session);
    const transport = objectValue(parsed?.transport);
    const answerSdp = typeof transport?.sdp === 'string' ? transport.sdp : '';
    if (!validSdp(answerSdp)) {
      throw new RealtimeVoiceError('VOICE_REALTIME_UPSTREAM_FAILED', response.status, 'INVALID_ANSWER_SDP');
    }
    const sessionId = typeof session?.id === 'string' ? safeSessionId(session.id) : undefined;
    return {
      answerSdp,
      model: this.model,
      engine: this.engine,
      ...(sessionId ? { callId: sessionId } : {}),
    };
  }
}

export function createConfiguredRealtimeVoiceGateway(
  environment: Readonly<Record<string, string | undefined>>,
): ShannonVoiceSessionGateway | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const engine = configuredVoiceEngine(environment);
  if (engine === 'live') {
    return new OpenAILiveVoiceGateway({
      apiKey,
      model: environment.SHANNON_VOICE_LIVE_MODEL,
      endpoint: environment.SHANNON_VOICE_LIVE_ENDPOINT,
      voice: environment.SHANNON_VOICE_LIVE_VOICE ?? environment.SHANNON_VOICE_REALTIME_VOICE,
      timeoutMilliseconds: optionalInteger(
        environment.SHANNON_VOICE_LIVE_TIMEOUT_MS ?? environment.SHANNON_VOICE_REALTIME_TIMEOUT_MS,
      ),
    });
  }
  return new OpenAIRealtimeVoiceGateway({
    apiKey,
    model: environment.SHANNON_VOICE_REALTIME_MODEL,
    endpoint: environment.SHANNON_VOICE_REALTIME_ENDPOINT,
    transcriptionModel: environment.SHANNON_VOICE_REALTIME_TRANSCRIPTION_MODEL,
    voice: environment.SHANNON_VOICE_REALTIME_VOICE,
    reasoningEffort: configuredReasoningEffort(environment.SHANNON_VOICE_REALTIME_REASONING_EFFORT),
    timeoutMilliseconds: optionalInteger(environment.SHANNON_VOICE_REALTIME_TIMEOUT_MS),
  });
}

function configuredReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'medium' || normalized === 'high' ? normalized : 'low';
}

export function configuredVoiceEngine(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ShannonVoiceEngine {
  return environment.SHANNON_VOICE_ENGINE?.trim().toLowerCase() === 'live' ? 'live' : 'realtime';
}

export function configuredRealtimeDailyAllowanceSeconds(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = environment.SHANNON_VOICE_REALTIME_DAILY_MINUTES?.trim();
  if (!value) return SHANNON_REALTIME_DEFAULT_DAILY_ALLOWANCE_SECONDS;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 24 * 60) {
    return SHANNON_REALTIME_DEFAULT_DAILY_ALLOWANCE_SECONDS;
  }
  return minutes * 60;
}

export function realtimeVoiceJapanDayKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function validSdp(value: string): boolean {
  return value.length >= 16 && value.length <= 128 * 1024 && value.startsWith('v=0');
}

function boundedInstructions(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 24_000 ? normalized : `${normalized.slice(0, 23_999).trimEnd()}…`;
}

function validIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(normalized)) throw new Error(`${name} is invalid`);
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

function callIdFromLocation(location: string | null): string | undefined {
  const match = location?.match(/\/realtime\/calls\/([A-Za-z0-9_-]{1,160})(?:$|[/?#])/u);
  return match?.[1];
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

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,160}$/u.test(value) ? value : undefined;
}

function safeUpstreamDetail(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
    const message = (error as Record<string, unknown>).message;
    if (typeof message !== 'string') return undefined;
    return message
      .slice(0, 500)
      .replace(/a=(?:ice-ufrag|ice-pwd|fingerprint|candidate):[^\r\n]*/giu, '[redacted-sdp-line]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[redacted-ip]')
      .replace(/\bsk-[A-Za-z0-9_-]+\b/gu, '[redacted-credential]');
  } catch {
    return undefined;
  }
}

function safeObject(value: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeSessionId(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,160}$/u.test(value) ? value : undefined;
}
