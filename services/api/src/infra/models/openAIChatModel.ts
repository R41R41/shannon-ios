import { actionPermit, currentActionExecution } from '../context/actionExecution.js';
/** The conversation model's adapters: the OpenAI Responses adapter and the local stub (Syzygy ADR-0008 stage 3, S3: moved unchanged out of `chatModel.ts`, which re-exports them). */
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from './chatModelContract.js';
import { estimatedOpenAICostUsd, type LlmUsageStore, responseUsage } from './llmUsage.js';
import { DEFAULT_VOICE_STREAM_BOUNDS, reachedVoiceLengthLimit, streamedVoiceReply, VOICE_CONTENT_FILTERED, VOICE_RESPONSE_TIMEOUT_MILLISECONDS, VOICE_WEB_FIRST_OUTPUT_MILLISECONDS, voiceContentWithheld, type VoiceStreamBounds } from './chatModelVoiceStream.js';
import { errorDetail, extractOutputText, extractWebSources, parseJson, stableScopeIdentifier, validModel, WEB_SEARCH_INSTRUCTIONS } from './chatModelSupport.js';
import { PartialAnswerError, type RoundTime, RoundTimer } from '../../mind/action/respond/turnDeadline.js';
import { isOutOfTime, outOfTimeEnvelope, providerFunctionTools, type ShannonModelToolSession, tierEscalation, toolInstructions, TOOLS_WITHHELD_INSTRUCTIONS, TURN_OUT_OF_TIME_LINE, VOICE_TOOL_OUTPUT_TOKENS, withToolRounds } from './chatModelTools.js';
import { chatTurnRequestBody, chatTurnResult, offersTools, parsedChatTurn, precedingReplyMessage, turnContextMessage } from './chatModelTurn.js';
import { ChatSentenceSplitter } from '../../surfaces/text/chatSentenceSplitter.js';
import { streamedChatTurnEnvelope } from './chatModelStream.js';
import { completeSpokenSentences } from '../../surfaces/voice/spokenSentences.js';
import { streamedVoiceToolTurn } from './chatModelVoiceTools.js';
import { serverEnvironment } from '../config/serverEnvironment.js';
import { VOICE_REPLY_INSTRUCTIONS } from '../../mind/action/respond/respondInstructions.js';
import { AnthropicChatModel } from './anthropic/anthropicChatModel.js';
import { configuredResponseModel, isHaikuModel } from './anthropic/haikuConfig.js';
export { VOICE_REPLY_INSTRUCTIONS } from '../../mind/action/respond/respondInstructions.js';

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
  model: string;
  endpoint?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  usageStore?: LlmUsageStore;
  now?: () => string;
  agentHostHint?: string;
  /** Streamed voice replies: the wait for the first word and for each later piece (no total limit). */
  voiceStreamBounds?: Partial<VoiceStreamBounds>;
  /** A non-streaming voice reply (the body's `/delegations`): one total, room for the longest reply. */
  voiceResponseTimeoutMilliseconds?: number;
}

/**
 * Output ceilings of a voice reply. Everyday brevity comes from the instructions; the ceiling
 * only has to leave room for a long talk the owner asks for (about 1,200 tokens is several
 * minutes of Japanese speech). A reply that still reaches it ends at its last complete sentence.
 */
export const VOICE_MAX_OUTPUT_TOKENS: Readonly<Record<ShannonVoiceModelRequest['conversationClass'], number>> = Object.freeze({
  greeting: 180,
  direct: 1_200,
  skill_simple: 1_200,
  skill_complex: 1_600,
});

export class OpenAIResponsesChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;
  private readonly voiceStreamBounds: VoiceStreamBounds;

  constructor(private readonly options: OpenAIResponsesModelOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model);
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    const transport=options.fetcher ?? fetch;
    this.fetcher=async(input,init)=>{
      await actionPermit();
      const active=currentActionExecution();
      const existing=init?.signal ?? (input instanceof Request ? input.signal : null);
      const signal=active ? existing ? AbortSignal.any([existing,active.signal]) : active.signal : existing;
      return transport(input,{...init,...(signal?{signal}:{})});
    };
    this.voiceStreamBounds = { ...DEFAULT_VOICE_STREAM_BOUNDS, ...options.voiceStreamBounds };
  }

  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    const send = async (body: Record<string, unknown>, time?: RoundTime) => {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // Nothing of a non-streaming round arrives before it is complete, so its step time is its whole time.
        signal: AbortSignal.timeout(time?.milliseconds ?? this.timeoutMilliseconds),
      });
      const raw = await response.text();
      const json = parseJson(raw);
      if (!response.ok) {
        throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(json)}`);
      }
      return json;
    };
    const escalation = tierEscalation(request);
    const json = await withToolRounds(chatTurnRequestBody(this.model, request, this.options.agentHostHint), offersTools(request) ? request.tools : undefined, send,
      { ...this.chatRounds(request, () => ''), ...(escalation ? { escalate: escalation.option } : {}) });
    return escalation?.happened() ? { ...this.completedChatTurn(request, json), escalated: true } : this.completedChatTurn(request, json);
  }

  /**
   * How a text turn's tool rounds end and are accounted: a round whose text is the whole structured turn is the answer.
   * A provider that refuses the request offering her tools is asked once more without them.
   */
  private chatRounds(request: ShannonChatModelRequest, sentInLastRound: () => string) {
    const usable = (envelope: unknown) => { try { parsedChatTurn(envelope); return true; } catch { return false; } };
    return {
      isAnswer: usable, isUsable: usable,
      onSpent: (envelope: unknown) => this.recordChatUsage(request.scopeKey, envelope),
      plainBody: chatTurnRequestBody(this.model, { ...request, tools: undefined }, this.options.agentHostHint),
      // When the turn's deadline leaves no time to answer: her fixed line, as a whole structured turn, so it is saved.
      // What a streamed answer already sent stands, cut where its sentences were sent, and the line follows.
      outOfTime: (sent?: string) => outOfTimeEnvelope(JSON.stringify({
        reply: `${new ChatSentenceSplitter().append(sent ?? sentInLastRound()).join('')}${TURN_OUT_OF_TIME_LINE}`, threadSummary: null, taskDecision: { disposition: 'none', reason: '時間が足りなかった' },
        taskProposal: null, intentPlan: null, artifacts: null,
      })),
    };
  }

  /**
   * The same request with `stream: true`. `onReplyText` receives the reply as it is written;
   * the returned turn is parsed, checked and accounted exactly as `generate` does it.
   */
  async generateStreaming(
    request: ShannonChatModelRequest,
    onReplyText: (text: string) => void | Promise<void>,
  ): Promise<ShannonChatModelResult> {
    // Each tool round streams on its own; a round that only calls tools writes no reply text. A round that writes reply
    // text is the answer: it gets the answer's time, and if it fails after all, what it sent stands (`PartialAnswerError`).
    let written = '';
    const escalation = tierEscalation(request);
    const envelope = await withToolRounds(chatTurnRequestBody(this.model, request, this.options.agentHostHint), offersTools(request) ? request.tools : undefined,
      async (body, time) => {
        const timer = time ? new RoundTimer(time) : undefined;
        written = '';
        try {
          return await streamedChatTurnEnvelope({
            fetcher: this.fetcher, endpoint: this.endpoint, apiKey: this.options.apiKey,
            timeoutMilliseconds: this.timeoutMilliseconds, body, ...(timer ? { signal: timer.signal } : {}),
          }, async text => { timer?.answering(); written += text; await onReplyText(text); }, failed => {
            // A failed response is recorded only when the provider reported what it used.
            if (responseUsage(failed).totalTokens > 0) this.recordChatUsage(request.scopeKey, failed);
          });
        } catch (error) {
          if (timer && written) throw new PartialAnswerError(written);
          throw error;
        } finally { timer?.clear(); }
      }, { ...this.chatRounds(request, () => written), ...(escalation ? { escalate: { ...escalation.option, allowed: () => written === '' } } : {}) });
    return escalation?.happened() ? { ...this.completedChatTurn(request, envelope), escalated: true } : this.completedChatTurn(request, envelope);
  }

  /** Parse, then account, then build the result: the order `generate` has always used. */
  private completedChatTurn(request: ShannonChatModelRequest, envelope: unknown): ShannonChatModelResult {
    const structured = parsedChatTurn(envelope);
    this.recordChatUsage(request.scopeKey, envelope);
    const result = chatTurnResult(this.model, request, envelope, structured);
    // Her fixed out-of-time line stands alone: nothing (no list of sources) is added to it.
    return isOutOfTime(envelope) ? { ...result, outOfTime: true } : result;
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
    // Words of a round that called tools (a short waiting phrase) come before the words of the answer.
    const said: string[] = [];
    const voiceEscalation = tierEscalation(request, true);
    const json = await withToolRounds(this.voiceRequestPayload(request), this.voiceTools(request), async (body, time) => {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        // With tools, every round's time comes from the turn's deadline; without, this is a total sized for the longest reply.
        signal: AbortSignal.timeout(time?.milliseconds ?? this.options.voiceResponseTimeoutMilliseconds ?? VOICE_RESPONSE_TIMEOUT_MILLISECONDS),
      });
      const raw = await response.text();
      const value = parseJson(raw);
      if (!response.ok) throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(value)}`);
      return value;
    }, {
      ...(voiceEscalation ? { escalate: voiceEscalation.option } : {}),
      isAnswer: () => false, plainBody: this.voiceRequestPayload({ ...request, tools: undefined }), outOfTime: () => outOfTimeEnvelope(TURN_OUT_OF_TIME_LINE),
      // After a tool ran, an empty answer is the fixed line, so the turn is still saved.
      isUsable: envelope => extractOutputText(envelope).trim().length > 0,
      onSpent: envelope => { said.push(extractOutputText(envelope).trim()); this.recordChatUsage(request.scopeKey, envelope); },
    });
    if (voiceContentWithheld(json)) {
      this.recordSpentVoiceUsage(request.scopeKey, json);
      throw new Error(VOICE_CONTENT_FILTERED);
    }
    const written = [...said, extractOutputText(json).trim()].filter(Boolean).join('');
    // A reply cut at its output limit ends at its last complete sentence, as in the stream.
    const truncated = reachedVoiceLengthLimit(json);
    const reply = truncated ? completeSpokenSentences(written) || written : written;
    if (!reply) {
      this.recordSpentVoiceUsage(request.scopeKey, json);
      throw new Error('OPENAI_RESPONSE_EMPTY');
    }
    const result = this.voiceResult(request, json, reply, truncated);
    return voiceEscalation?.happened() ? { ...result, escalated: true } : result;
  }

  async generateVoiceStreaming(
    request: ShannonVoiceModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<ShannonChatModelResult> {
    const bounds = request.useWebSearch ? {
      ...this.voiceStreamBounds,
      firstOutputMilliseconds: Math.max(this.voiceStreamBounds.firstOutputMilliseconds, VOICE_WEB_FIRST_OUTPUT_MILLISECONDS),
    } : this.voiceStreamBounds;
    const tools = this.voiceTools(request);
    if (tools) {
      // Her tools: waiting phrases, the turn's deadline, and the out-of-time line (`chatModelVoiceTools.ts`).
      const escalation = tierEscalation(request, true);
      const turn = await streamedVoiceToolTurn({
        ...(escalation ? { escalate: escalation.option } : {}),
        fetcher: this.fetcher, endpoint: this.endpoint, apiKey: this.options.apiKey, body: this.voiceRequestPayload(request),
        plainBody: this.voiceRequestPayload({ ...request, tools: undefined }), tools, bounds, ...(signal ? { signal } : {}), onTextDelta,
        onSpent: envelope => this.recordChatUsage(request.scopeKey, envelope),
        onSpentWithoutReply: envelope => this.recordSpentVoiceUsage(request.scopeKey, envelope),
      });
      const result = this.voiceResult(request, turn.envelope, turn.reply, turn.truncated);
      return escalation?.happened() ? { ...result, escalated: true } : result;
    }
    const outcome = await streamedVoiceReply({
      fetcher: this.fetcher, endpoint: this.endpoint, apiKey: this.options.apiKey,
      body: this.voiceRequestPayload(request), bounds, ...(signal ? { signal } : {}),
      onSpentWithoutReply: envelope => this.recordSpentVoiceUsage(request.scopeKey, envelope),
    }, onTextDelta);
    return this.voiceResult(request, outcome.envelope, outcome.reply, outcome.truncated);
  }

  /** A voice response that used tokens but gave no usable reply is still accounted. */
  private recordSpentVoiceUsage(scopeKey: string, envelope: unknown): void {
    if (responseUsage(envelope).totalTokens > 0) this.recordChatUsage(scopeKey, envelope);
  }

  /** Accounts a finished voice reply and builds its result. */
  private voiceResult(
    request: ShannonVoiceModelRequest,
    envelope: unknown,
    reply: string,
    truncated: boolean,
  ): ShannonChatModelResult {
    this.recordChatUsage(request.scopeKey, envelope);
    const webSources = request.useWebSearch ? extractWebSources(envelope) : [];
    return {
      mode: this.mode,
      model: this.model,
      reply,
      ...(webSources.length ? { webSources } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** A voice turn offers her registry tools unless it searches the web. */
  private voiceTools(request: ShannonVoiceModelRequest): ShannonModelToolSession | undefined {
    return request.tools?.definitions.length && !request.useWebSearch ? request.tools : undefined;
  }

  private voiceRequestPayload(request: ShannonVoiceModelRequest): Record<string, unknown> {
    const complex = request.conversationClass === 'skill_complex';
    const maximumOutputTokens = VOICE_MAX_OUTPUT_TOKENS[request.conversationClass];
    const tools = this.voiceTools(request);
    return {
      model: this.model,
      // Fixed first, what changes last (`ShannonPromptLayers`): the turn's blocks follow the history, as in text chat.
      instructions: [
        request.systemPrompt,
        VOICE_REPLY_INSTRUCTIONS,
        ...(tools ? [toolInstructions(tools, true)] : request.toolsWithheld ? [TOOLS_WITHHELD_INSTRUCTIONS] : []),
        ...(request.profilePrompt ? [request.profilePrompt] : []),
      ].join('\n\n'),
      input: [
        ...request.history.map(item => ({ role: item.role, content: item.content })),
        ...turnContextMessage([...(request.turnContext ? [request.turnContext] : []), ...(request.useWebSearch ? [WEB_SEARCH_INSTRUCTIONS] : [])]),
        ...precedingReplyMessage(request),
        { role: 'user', content: request.message },
      ],
      // Stage 2: `luna_plus` thinks one step longer.
      reasoning: { effort: request.tier === 'luna_plus' ? (complex ? 'medium' : 'low') : complex ? 'low' : 'none' },
      text: { verbosity: complex ? 'medium' : 'low' },
      // A turn with her tools may write a whole story in one call; how long she speaks is still the instructions'.
      max_output_tokens: tools ? Math.max(maximumOutputTokens, VOICE_TOOL_OUTPUT_TOKENS) : maximumOutputTokens,
      ...(request.useWebSearch ? {
        tools: [{ type: 'web_search', search_context_size: complex ? 'medium' : 'low' }],
        tool_choice: { type: 'web_search' },
        include: ['web_search_call.action.sources'],
        max_tool_calls: complex ? 3 : 2,
      } : {}),
      // Voice still asks for one call at a time (ADR-0003 stage 5 widens stage 4 to voice once its speed is measured).
      ...(tools ? { tools: providerFunctionTools(tools.definitions), tool_choice: 'auto', parallel_tool_calls: false } : {}),
      store: false,
      prompt_cache_key: stableScopeIdentifier(request.scopeKey),
      safety_identifier: stableScopeIdentifier(request.scopeKey),
    };
  }
}

export function createConfiguredChatModel(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
  usageStore?: LlmUsageStore,
): ShannonChatModel {
  const configured = configuredResponseModel(environment, 'SHANNON_LLM_MODEL');
  if (!configured) return new LocalStubChatModel();
  const { apiKey, model } = configured;
  if (isHaikuModel(model)) return new AnthropicChatModel({
    apiKey, settings: { model, effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' },
    agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac', usageStore,
  });
  return new OpenAIResponsesChatModel({
    apiKey,
    model,
    agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac',
    usageStore,
  });
}
