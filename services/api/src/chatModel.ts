import type { PlaceSearchContext, ShannonPlace } from './placeDiscovery.js';
import {
  estimatedOpenAICostUsd,
  responseUsage,
  type LlmUsageStore,
} from './llmUsage.js';
import { responseSSEEvents, streamedChatTurnEnvelope } from './chatModelStream.js';
import { chatTurnRequestBody, chatTurnResult, parsedChatTurn } from './chatModelTurn.js';
import {
  WEB_SEARCH_INSTRUCTIONS,
  errorDetail,
  extractOutputText,
  extractWebSources,
  parseJson,
  stableScopeIdentifier,
  validModel,
} from './chatModelSupport.js';
export { AGENT_TASK_INSTRUCTIONS, agentTaskInstructions } from './chatModelSupport.js';

export type ShannonChatMode = 'openai' | 'local-stub';

export interface ShannonConversationItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ShannonChatAttachment {
  name: string;
  mimeType: string;
  text: string;
}

export interface ShannonChatModelRequest {
  generateThreadTitle?: boolean;
  priorThreadSummary?: string;
  scopeKey: string;
  systemPrompt: string;
  history: readonly ShannonConversationItem[];
  message: string;
  attachments?: readonly ShannonChatAttachment[];
  useWebSearch?: boolean;
  placeSearch?: PlaceSearchContext;
  /** The structured reply gets a `roomLook` field: she may choose one look at the room (`bodyLook.ts`). */
  offerRoomLook?: boolean;
  /** The structured reply gets an `appLook` field: she may choose one look through the camera of the owner's app (`appLook.ts`). */
  offerAppLook?: boolean;
}

export interface ShannonVoiceModelRequest {
  scopeKey: string;
  systemPrompt: string;
  history: readonly ShannonConversationItem[];
  message: string;
  useWebSearch: boolean;
  conversationClass: 'greeting' | 'direct' | 'skill_simple' | 'skill_complex';
}

export interface ShannonWebSource {
  title: string;
  url: string;
}

export interface ShannonGeneratedArtifact {
  name: string;
  mimeType: string;
  content: string;
  summary?: string;
}

export interface ShannonChatModelResult {
  threadTitle?: string;
  threadSummary?: string;
  mode: ShannonChatMode;
  model: string;
  reply: string;
  webSources?: ShannonWebSource[];
  places?: ShannonPlace[];
  roomLook?: 'asked' | 'curious';
  /** What she chose for the app's camera, as the structured reply carried it (`appLookContract.ts`). */
  appLook?: string;
  artifacts?: ShannonGeneratedArtifact[];
  taskProposal?: ShannonTaskProposal;
  taskDecision?: ShannonTaskDecision;
  intentPlan?: ShannonIntentPlan;
}

export interface ShannonIntentPlan {
  nextStep: string;
  steps: readonly string[];
}

export type ShannonTaskDisposition = 'none' | 'clarify' | 'propose';

export interface ShannonTaskDecision {
  disposition: ShannonTaskDisposition;
  reason: string;
}

export interface ShannonTaskProposal {
  title: string;
  goal: string;
  hostHint?: string;
  projectHint?: string;
  risk?: string;
}

export interface ShannonChatModel {
  readonly mode: ShannonChatMode;
  readonly model: string;
  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult>;
  /** `generate` with the reply reported while it is written. The pieces are a prefix of the returned `reply`. */
  generateStreaming?(
    request: ShannonChatModelRequest,
    onReplyText: (text: string) => void | Promise<void>,
  ): Promise<ShannonChatModelResult>;
  generateVoice?(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult>;
  generateVoiceStreaming?(
    request: ShannonVoiceModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ShannonChatModelResult>;
}

const LOCAL_REPLY = 'はい、聞こえています。LLMの鍵を設定すると、ここからボクが会話できるようになります。';

export class LocalStubChatModel implements ShannonChatModel {
  readonly mode = 'local-stub' as const;
  readonly model = 'local-stub';

  async generate(): Promise<ShannonChatModelResult> {
    return { mode: this.mode, model: this.model, reply: LOCAL_REPLY };
  }

  async generateVoice(): Promise<ShannonChatModelResult> {
    return { mode: this.mode, model: this.model, reply: LOCAL_REPLY };
  }
}

export interface OpenAIResponsesModelOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  usageStore?: LlmUsageStore;
  now?: () => string;
  agentHostHint?: string;
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
      body: JSON.stringify(chatTurnRequestBody(this.model, request, this.options.agentHostHint)),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });

    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) {
      throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(json)}`);
    }
    return this.completedChatTurn(request, json);
  }

  /**
   * The same request with `stream: true`. `onReplyText` receives the reply as it is written;
   * the returned turn is parsed, checked and accounted exactly as `generate` does it.
   */
  async generateStreaming(
    request: ShannonChatModelRequest,
    onReplyText: (text: string) => void | Promise<void>,
  ): Promise<ShannonChatModelResult> {
    const envelope = await streamedChatTurnEnvelope({
      fetcher: this.fetcher, endpoint: this.endpoint, apiKey: this.options.apiKey,
      timeoutMilliseconds: this.timeoutMilliseconds,
      body: chatTurnRequestBody(this.model, request, this.options.agentHostHint),
    }, onReplyText, failed => {
      // A failed response is recorded only when the provider reported what it used.
      if (responseUsage(failed).totalTokens > 0) this.recordChatUsage(request.scopeKey, failed);
    });
    return this.completedChatTurn(request, envelope);
  }

  /** Parse, then account, then build the result: the order `generate` has always used. */
  private completedChatTurn(request: ShannonChatModelRequest, envelope: unknown): ShannonChatModelResult {
    const structured = parsedChatTurn(envelope);
    this.recordChatUsage(request.scopeKey, envelope);
    return chatTurnResult(this.model, request, envelope, structured);
  }

  private recordChatUsage(scopeKey: string, envelope: unknown): void {
    const usage = responseUsage(envelope);
    this.options.usageStore?.recordLlmUsage({
      scopeKey,
      lane: 'chat',
      model: this.model,
      ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
    });
  }

  async generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.voiceRequestPayload(request)),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(json)}`);
    const reply = extractOutputText(json).trim();
    if (!reply) throw new Error('OPENAI_RESPONSE_EMPTY');
    const usage = responseUsage(json);
    this.options.usageStore?.recordLlmUsage({
      scopeKey: request.scopeKey,
      lane: 'chat',
      model: this.model,
      ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
    });
    const webSources = request.useWebSearch ? extractWebSources(json) : [];
    return {
      mode: this.mode,
      model: this.model,
      reply,
      ...(webSources.length ? { webSources } : {}),
    };
  }

  async generateVoiceStreaming(
    request: ShannonVoiceModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ShannonChatModelResult> {
    const timeout = AbortSignal.timeout(this.timeoutMilliseconds);
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...this.voiceRequestPayload(request), stream: true }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body) {
      const raw = await response.text();
      throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(parseJson(raw))}`);
    }

    let reply = '';
    let completedEnvelope: unknown;
    for await (const event of responseSSEEvents(response.body)) {
      const value = event && typeof event === 'object' && !Array.isArray(event)
        ? event as Record<string, unknown>
        : {};
      if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') {
        reply += value.delta;
        await onTextDelta(value.delta);
      } else if (value.type === 'response.output_text.done' && !reply && typeof value.text === 'string') {
        reply = value.text;
        await onTextDelta(value.text);
      } else if (value.type === 'response.completed') {
        completedEnvelope = value.response;
      } else if (value.type === 'error' || value.type === 'response.failed') {
        throw new Error('OPENAI_RESPONSE_STREAM_FAILED');
      }
    }
    reply = reply.trim();
    if (!reply || !completedEnvelope) throw new Error('OPENAI_RESPONSE_STREAM_INCOMPLETE');
    const usage = responseUsage(completedEnvelope);
    this.options.usageStore?.recordLlmUsage({
      scopeKey: request.scopeKey,
      lane: 'chat',
      model: this.model,
      ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
    });
    const webSources = request.useWebSearch ? extractWebSources(completedEnvelope) : [];
    return {
      mode: this.mode,
      model: this.model,
      reply,
      ...(webSources.length ? { webSources } : {}),
    };
  }

  private voiceRequestPayload(request: ShannonVoiceModelRequest): Record<string, unknown> {
    const complex = request.conversationClass === 'skill_complex';
    const maximumOutputTokens = request.conversationClass === 'greeting' ? 180
      : request.conversationClass === 'direct' ? 320
        : complex ? 900 : 480;
    return {
      model: this.model,
      instructions: [
        request.systemPrompt,
              '[音声専用の返答]\n自然な日本語の話し言葉で、最初に答えを置く。挨拶と通常会話は1〜2文、複雑な回答でも原則3文に収める。Markdown、URL一覧、内部処理の説明、JSONは使わない。聞き取りやすい短い文にし、必要がなければ末尾に質問を足さない。',
        ...(request.useWebSearch ? [WEB_SEARCH_INSTRUCTIONS] : []),
      ].join('\n\n'),
      input: [
        ...request.history.map(item => ({ role: item.role, content: item.content })),
        { role: 'user', content: request.message },
      ],
      reasoning: { effort: complex ? 'low' : 'none' },
      text: { verbosity: complex ? 'medium' : 'low' },
      max_output_tokens: maximumOutputTokens,
      ...(request.useWebSearch ? {
        tools: [{ type: 'web_search', search_context_size: complex ? 'medium' : 'low' }],
        tool_choice: { type: 'web_search' },
        include: ['web_search_call.action.sources'],
        max_tool_calls: complex ? 3 : 2,
      } : {}),
      store: false,
      prompt_cache_key: stableScopeIdentifier(request.scopeKey),
      safety_identifier: stableScopeIdentifier(request.scopeKey),
    };
  }
}

export function createConfiguredChatModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  usageStore?: LlmUsageStore,
): ShannonChatModel {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return new LocalStubChatModel();
  return new OpenAIResponsesChatModel({
    apiKey,
    model: environment.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna',
    agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac',
    usageStore,
  });
}
