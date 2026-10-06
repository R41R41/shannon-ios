import {
  errorDetail,
  extractOutputText,
  parseJson,
  stableScopeIdentifier,
  validModel,
} from '../../chatModelSupport.js';

export type ShannonVisionMimeType = 'image/jpeg' | 'image/png';

export interface VoiceVisionRequest {
  scopeKey: string;
  image: Uint8Array;
  mimeType: ShannonVisionMimeType;
  conversationContext: string;
}

export interface VoiceVisionResult {
  description: string;
  model: string;
}

export interface VoiceVisionGateway {
  analyze(request: VoiceVisionRequest): Promise<VoiceVisionResult>;
}

interface OpenAIVoiceVisionGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
}

export class OpenAIVoiceVisionGateway implements VoiceVisionGateway {
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIVoiceVisionGatewayOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model ?? 'gpt-5.6-luna');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.timeoutMilliseconds = boundedTimeout(options.timeoutMilliseconds);
    this.fetcher = options.fetcher ?? fetch;
  }

  async analyze(request: VoiceVisionRequest): Promise<VoiceVisionResult> {
    if (request.image.byteLength < 64 || request.image.byteLength > 3 * 1_024 * 1_024
      || !validImageSignature(request.image, request.mimeType)) {
      throw new VoiceVisionError('VOICE_VISION_INVALID_IMAGE');
    }
    const imageURL = `data:${request.mimeType};base64,${Buffer.from(request.image).toString('base64')}`;
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
          instructions: [
            request.conversationContext,
            '[One user-approved photo from camera or photo library; capture time is unknown]',
            'Describe only what is reasonably visible. Distinguish observation from uncertainty.',
            'Answer in concise natural Japanese for Shannon to paraphrase aloud.',
            'Do not identify an unknown person, infer sensitive traits, or claim that an external action occurred.',
          ].join('\n\n'),
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: 'いま共有された1枚の写真を見て、会話に役立つ内容を説明してください。' },
              { type: 'input_image', image_url: imageURL, detail: 'low' },
            ],
          }],
          reasoning: { effort: 'none' },
          text: { verbosity: 'low' },
          max_output_tokens: 350,
          store: false,
          prompt_cache_key: stableScopeIdentifier(request.scopeKey),
          safety_identifier: stableScopeIdentifier(request.scopeKey),
        }),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      throw new VoiceVisionError('VOICE_VISION_UPSTREAM_FAILED');
    }

    const raw = await response.text();
    const parsed = parseJson(raw);
    if (!response.ok) {
      throw new VoiceVisionError('VOICE_VISION_UPSTREAM_FAILED', response.status, errorDetail(parsed));
    }
    const description = extractOutputText(parsed);
    if (!description) throw new VoiceVisionError('VOICE_VISION_UPSTREAM_FAILED', response.status, 'empty response');
    return { description, model: this.model };
  }
}

export class VoiceVisionError extends Error {
  constructor(
    readonly code: 'VOICE_VISION_INVALID_IMAGE' | 'VOICE_VISION_UPSTREAM_FAILED',
    readonly upstreamStatus?: number,
    readonly safeDetail?: string,
  ) {
    super(code);
  }
}

export function createConfiguredVoiceVisionGateway(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): VoiceVisionGateway | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAIVoiceVisionGateway({
    apiKey,
    model: environment.SHANNON_VISION_MODEL?.trim() || environment.SHANNON_LLM_MODEL?.trim(),
    endpoint: environment.SHANNON_VISION_ENDPOINT,
    timeoutMilliseconds: optionalInteger(environment.SHANNON_VISION_TIMEOUT_MS),
  });
}

function optionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function boundedTimeout(value: number | undefined): number {
  return Number.isInteger(value) && Number(value) >= 5_000 && Number(value) <= 60_000
    ? Number(value)
    : 30_000;
}

function validImageSignature(image: Uint8Array, mimeType: ShannonVisionMimeType): boolean {
  if (mimeType === 'image/jpeg') return image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  return image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47
    && image[4] === 0x0d && image[5] === 0x0a && image[6] === 0x1a && image[7] === 0x0a;
}
