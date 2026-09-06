import { randomUUID } from 'node:crypto';

export interface RealtimeVoiceCallRequest {
  sdp: string;
  instructions: string;
}

export interface RealtimeVoiceCallResult {
  answerSdp: string;
  callId?: string;
  model: string;
}

export type RealtimeVoiceFailureCode =
  | 'VOICE_REALTIME_NOT_CONFIGURED'
  | 'VOICE_REALTIME_INVALID_SDP'
  | 'VOICE_REALTIME_UPSTREAM_FAILED';

export class RealtimeVoiceError extends Error {
  constructor(
    readonly code: RealtimeVoiceFailureCode,
    readonly upstreamStatus?: number,
    readonly upstreamCode?: string,
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
}

export class OpenAIRealtimeVoiceGateway {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;
  private readonly transcriptionModel: string;
  private readonly voice: string;

  constructor(private readonly options: OpenAIRealtimeVoiceGatewayOptions) {
    if (!options.apiKey.trim()) throw new RealtimeVoiceError('VOICE_REALTIME_NOT_CONFIGURED');
    this.model = validIdentifier(options.model ?? 'gpt-realtime-2.1-mini', 'SHANNON_VOICE_REALTIME_MODEL');
    this.transcriptionModel = validIdentifier(
      options.transcriptionModel ?? 'gpt-live-transcribe',
      'SHANNON_VOICE_REALTIME_TRANSCRIPTION_MODEL',
    );
    this.voice = validIdentifier(options.voice ?? 'marin', 'SHANNON_VOICE_REALTIME_VOICE');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/realtime/calls';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = boundedInteger(options.timeoutMilliseconds, 5_000, 60_000, 30_000);
  }

  async createCall(request: RealtimeVoiceCallRequest): Promise<RealtimeVoiceCallResult> {
    const sdp = request.sdp.trim();
    if (!validSdp(sdp)) throw new RealtimeVoiceError('VOICE_REALTIME_INVALID_SDP');

    const session = {
      type: 'realtime',
      model: this.model,
      instructions: boundedInstructions(request.instructions),
      output_modalities: ['audio'],
      max_output_tokens: 700,
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
          voice: this.voice,
          speed: 1,
        },
      },
      tracing: null,
      truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
    };
    const multipart = realtimeCallMultipartBody(sdp, session);

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/sdp',
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': multipart.contentType,
        },
        body: multipart.body,
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
      );
    }
    if (!validSdp(answerSdp)) {
      throw new RealtimeVoiceError('VOICE_REALTIME_UPSTREAM_FAILED', response.status, 'INVALID_ANSWER_SDP');
    }

    return {
      answerSdp,
      model: this.model,
      ...(callIdFromLocation(response.headers.get('location')) ? {
        callId: callIdFromLocation(response.headers.get('location')),
      } : {}),
    };
  }
}

function realtimeCallMultipartBody(
  sdp: string,
  session: Readonly<Record<string, unknown>>,
): { body: Blob; contentType: string } {
  const boundary = `----shannon-realtime-${randomUUID().replaceAll('-', '')}`;
  const body = new Blob([
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="sdp"\r\n',
    'Content-Type: application/sdp\r\n\r\n',
    sdp,
    `\r\n--${boundary}\r\n`,
    'Content-Disposition: form-data; name="session"\r\n',
    'Content-Type: application/json\r\n\r\n',
    JSON.stringify(session),
    `\r\n--${boundary}--\r\n`,
  ]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function createConfiguredRealtimeVoiceGateway(
  environment: Readonly<Record<string, string | undefined>>,
): OpenAIRealtimeVoiceGateway | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAIRealtimeVoiceGateway({
    apiKey,
    model: environment.SHANNON_VOICE_REALTIME_MODEL,
    endpoint: environment.SHANNON_VOICE_REALTIME_ENDPOINT,
    transcriptionModel: environment.SHANNON_VOICE_REALTIME_TRANSCRIPTION_MODEL,
    voice: environment.SHANNON_VOICE_REALTIME_VOICE,
    timeoutMilliseconds: optionalInteger(environment.SHANNON_VOICE_REALTIME_TIMEOUT_MS),
  });
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
