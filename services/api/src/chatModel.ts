import { createHash } from 'node:crypto';

export type ShannonChatMode = 'openai' | 'local-stub';

export interface ShannonConversationItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ShannonChatModelRequest {
  scopeKey: string;
  systemPrompt: string;
  history: readonly ShannonConversationItem[];
  message: string;
}

export interface ShannonChatModelResult {
  mode: ShannonChatMode;
  model: string;
  reply: string;
}

export interface ShannonChatModel {
  readonly mode: ShannonChatMode;
  readonly model: string;
  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult>;
}

const LOCAL_REPLY = 'うん、聞いてるよ。LLMの鍵を設定すると、ここからShannonとして会話できるようになる。';

export class LocalStubChatModel implements ShannonChatModel {
  readonly mode = 'local-stub' as const;
  readonly model = 'local-stub';

  async generate(): Promise<ShannonChatModelResult> {
    return { mode: this.mode, model: this.model, reply: LOCAL_REPLY };
  }
}

export interface OpenAIResponsesModelOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
}

export class OpenAIResponsesChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIResponsesModelOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model ?? 'gpt-5.6-luna');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions: request.systemPrompt,
        input: [
          ...request.history.map(item => ({ role: item.role, content: item.content })),
          { role: 'user', content: request.message },
        ],
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
        max_output_tokens: 700,
        store: false,
        prompt_cache_key: stableScopeIdentifier(request.scopeKey),
        safety_identifier: stableScopeIdentifier(request.scopeKey),
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });

    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) {
      throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(json)}`);
    }
    const reply = extractOutputText(json);
    if (!reply) throw new Error('OPENAI_RESPONSE_EMPTY');
    return { mode: this.mode, model: this.model, reply };
  }
}

export function createConfiguredChatModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ShannonChatModel {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return new LocalStubChatModel();
  return new OpenAIResponsesChatModel({
    apiKey,
    model: environment.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna',
  });
}

function validModel(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(value)) throw new Error('SHANNON_LLM_MODEL is invalid');
  return value;
}

function stableScopeIdentifier(scopeKey: string): string {
  return `shannon_${createHash('sha256').update(scopeKey).digest('hex').slice(0, 32)}`;
}

function parseJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('OPENAI_RESPONSE_NON_JSON');
  }
}

function errorDetail(value: unknown): string {
  if (!value || typeof value !== 'object') return 'request failed';
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return 'request failed';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message.slice(0, 240) : 'request failed';
}

function extractOutputText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const direct = (value as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const output = (value as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as { type?: unknown; text?: unknown };
      if (row.type === 'output_text' && typeof row.text === 'string') parts.push(row.text);
    }
  }
  return parts.join('').trim();
}
