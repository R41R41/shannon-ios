import { createHash } from 'node:crypto';
import { normalizedThreadTitle } from './threadTitle.js';
import { placeSearchInstructions, placeSearchSchema, type PlaceSearchContext, type ShannonPlace } from './placeDiscovery.js';
import {
  estimatedOpenAICostUsd,
  responseUsage,
  type LlmUsageStore,
} from './llmUsage.js';

import {
  ATTACHMENT_SAFETY_INSTRUCTIONS,
  GENERATED_ARTIFACT_INSTRUCTIONS,
  INTENT_PLAN_INSTRUCTIONS,
  SHANNON_PERSONA_INSTRUCTIONS,
  SHANNON_RESPONSE_STYLE_INSTRUCTIONS,
  THREAD_SUMMARY_INSTRUCTIONS,
  THREAD_TITLE_INSTRUCTIONS,
  WEB_SEARCH_INSTRUCTIONS,
  agentTaskInstructions,
  attachmentProjection,
  errorDetail,
  extractOutputText,
  extractWebSources,
  parseJson,
  parseStructuredTurn,
  priorThreadSummaryInstructions,
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
  generateVoice?(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult>;
  generateVoiceStreaming?(
    request: ShannonVoiceModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ShannonChatModelResult>;
}

const LOCAL_REPLY = 'うん、聞いてるよ。LLMの鍵を設定すると、ここからShannonとして会話できるようになる。';

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
      body: JSON.stringify({
        model: this.model,
        instructions: [request.systemPrompt, SHANNON_PERSONA_INSTRUCTIONS, SHANNON_RESPONSE_STYLE_INSTRUCTIONS,
          ...(request.attachments?.length ? [ATTACHMENT_SAFETY_INSTRUCTIONS] : []),
          ...(request.useWebSearch || request.placeSearch ? [WEB_SEARCH_INSTRUCTIONS] : []),
          ...(request.placeSearch ? [placeSearchInstructions(request.placeSearch)] : []),
          GENERATED_ARTIFACT_INSTRUCTIONS,
          INTENT_PLAN_INSTRUCTIONS,
          agentTaskInstructions(this.options.agentHostHint),
          ...(request.priorThreadSummary ? [priorThreadSummaryInstructions(request.priorThreadSummary)] : []),
          THREAD_SUMMARY_INSTRUCTIONS,
          ...(request.generateThreadTitle ? [THREAD_TITLE_INSTRUCTIONS] : []),
        ].join('\n\n'),
        input: [
          ...request.history.map(item => ({ role: item.role, content: item.content })),
          {
            role: 'user',
            content: request.attachments?.length
              ? [
                { type: 'input_text', text: request.message },
                { type: 'input_text', text: attachmentProjection(request.attachments) },
              ]
              : request.message,
          },
        ],
        reasoning: { effort: 'none' },
        text: {
          verbosity: 'medium',
          format: {
            type: 'json_schema',
            name: 'shannon_chat_turn',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reply: { type: 'string', description: 'ユーザーに見せる自然な日本語の返答' },
                threadSummary: {
                  type: ['string', 'null'],
                  description: 'この返答までのトークの目的、決定、現在地、未決事項を短く表すナビゲーション要約',
                },
                ...(request.generateThreadTitle ? {
                  threadTitle: { type: ['string', 'null'], description: '最初のユーザー発言とシャノン側のreplyの話題を表す短いトークタイトル' },
                } : {}),
                taskDecision: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    disposition: { type: 'string', enum: ['none', 'clarify', 'propose'] },
                    reason: { type: 'string', description: '判定理由。内部監査用に短く具体的に書く' },
                  },
                  required: ['disposition', 'reason'],
                },
                taskProposal: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        title: { type: 'string' },
                        goal: { type: 'string' },
                        hostHint: { type: ['string', 'null'] },
                        projectHint: { type: ['string', 'null'] },
                        risk: { type: ['string', 'null'] },
                      },
                      required: ['title', 'goal', 'hostHint', 'projectHint', 'risk'],
                    },
                  ],
                },
                intentPlan: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        nextStep: { type: 'string', description: '目的に対する直近の具体的な一手' },
                        steps: {
                          type: 'array', minItems: 1, maxItems: 5,
                          items: { type: 'string', description: '短く検証可能な計画段階' },
                        },
                      },
                      required: ['nextStep', 'steps'],
                    },
                  ],
                },
                artifacts: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'array',
                      maxItems: 2,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          name: { type: 'string', description: '拡張子を含む安全で短いファイル名' },
                          mimeType: {
                            type: 'string',
                            enum: ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/x-source-code'],
                          },
                          content: { type: 'string', description: 'ユーザーが保存できるUTF-8テキスト生成物' },
                          summary: { type: ['string', 'null'], description: '生成物の内容を表す短い説明' },
                        },
                        required: ['name', 'mimeType', 'content', 'summary'],
                      },
                    },
                  ],
                },
                ...(request.placeSearch ? { places: placeSearchSchema } : {}),
              },
              required: ['reply', 'threadSummary', 'taskDecision', 'taskProposal', 'intentPlan', 'artifacts', ...(request.placeSearch ? ['places'] : []), ...(request.generateThreadTitle ? ['threadTitle'] : [])],
            },
          },
        },
        max_output_tokens: 2_200,
        ...(request.useWebSearch || request.placeSearch ? {
          tools: [{ type: 'web_search', search_context_size: 'medium' }],
          tool_choice: { type: 'web_search' },
          include: ['web_search_call.action.sources'],
          max_tool_calls: 3,
        } : {}),
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
    const structured = parseStructuredTurn(extractOutputText(json));
    const usage = responseUsage(json);
    this.options.usageStore?.recordLlmUsage({
      scopeKey: request.scopeKey,
      lane: 'chat',
      model: this.model,
      ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
    });
    const webSources = request.useWebSearch || request.placeSearch ? extractWebSources(json) : [];
    return {
      mode: this.mode,
      model: this.model,
      reply: structured.reply,
      ...(structured.threadSummary ? { threadSummary: structured.threadSummary } : {}),
      ...(webSources.length ? { webSources } : {}),
      ...(structured.places.length ? { places: structured.places } : {}),
      ...(structured.artifacts.length ? { artifacts: structured.artifacts } : {}),
      ...(request.generateThreadTitle && structured.threadTitle ? { threadTitle: structured.threadTitle } : {}),
      taskDecision: structured.taskDecision,
      ...(structured.intentPlan ? { intentPlan: structured.intentPlan } : {}),
      ...(structured.taskProposal ? { taskProposal: structured.taskProposal } : {}),
    };
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
        SHANNON_PERSONA_INSTRUCTIONS,
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

async function* responseSSEEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const blocks = pending.split(/\r?\n\r?\n/u);
      pending = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = block.split(/\r?\n/u)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        yield parseJson(data);
      }
      if (done) break;
    }
    const data = pending.split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (data && data !== '[DONE]') yield parseJson(data);
  } finally {
    reader.releaseLock();
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
