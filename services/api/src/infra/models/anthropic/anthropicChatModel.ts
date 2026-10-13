import { observeAsync, observeSync, observerHandoff } from '../../observer/observerContext.js';
import { observedAnthropicRequest } from './observerProjection.js';
import Anthropic from '@anthropic-ai/sdk';
import { PartialAnswerError, TurnDeadline, TEXT_TURN_DEADLINE, TURN_OUT_OF_TIME_LINE } from '../../../mind/action/respond/turnDeadline.js';
import { completeSpokenSentences } from '../../../surfaces/voice/spokenSentences.js';
import { ChatSentenceSplitter } from '../../../surfaces/text/chatSentenceSplitter.js';
import {
  VOICE_MAX_OUTPUT_TOKENS, type ShannonChatModel, type ShannonChatModelRequest, type ShannonChatModelResult, type ShannonVoiceModelRequest, type ShannonWebSource,
} from '../chatModel.js';
import { VOICE_TOOL_OUTPUT_TOKENS, voiceWaitingPhrase, type ShannonModelToolSession } from '../chatModelTools.js';
import { baseToolSession, withToolMenu } from '../../../mind/tools/shannonToolMenu.js';
import { providerToolName } from '../../../mind/tools/shannonTools.js';
import { chatTurnResult, offeredFeelingAnswered, offersTools, parsedChatTurn, type ParsedChatTurn } from '../chatModelTurn.js';
import type { LlmUsageStore } from '../llmUsage.js';
import type { ClaudeChatSettings } from './anthropicConfig.js';
import { claudeTextBody, claudeVoiceBody } from './anthropicRequest.js';
import { claudeToolLoop, type ClaudeToolLoopOptions, type ClaudeToolLoopResult } from '../claude/claudeToolLoop.js';
import { isAppendOnlyAnthropicModel, isHaikuModel, usesOneHourAnthropicCache } from './haikuConfig.js';
import { DEFAULT_VOICE_STREAM_BOUNDS, VOICE_WEB_FIRST_OUTPUT_MILLISECONDS, type VoiceStreamBounds } from '../chatModelVoiceStream.js';
import { webSearchContext, webSearchFailure, webSearchFailedTurn, type WebSearchOperation } from '../webSearch.js';
import { nativeWebSearchBody, nativeWebSearchResult, searchNeedsInput } from './anthropicWebSearch.js';
import { nativeWebReadBody, nativeWebReadResult } from './anthropicWebRead.js';
import { webReadUrl, type WebReadOperation } from '../webResearch.js';
import { turnCompletedWriteReceipts, turnWebSearchResult } from '../../../mind/tools/shannonToolSession.js';
import { claudeClient } from '../claude/claudeClient.js';
import { cachePlanApplies, exceptionTurn, plannedChatBody } from './anthropicCachePlan.js';
import { plannedVoiceBody, voicePlanApplies, voicePlanCovers } from './anthropicVoicePlan.js';
import { noteFeelingAnswer, notePlanEvent } from './cacheWarmTurns.js';
import {
  claudeConversationSender, type ClaudeConversationTransport, type ClaudeListener, type ClaudeSend, type ClaudeSendRequest,
} from '../claude/claudeTransport.js';

/**
 * The Sonnet tier (Syzygy ADR-0008 stage 2, step 5; `docs/skill-and-routing-contract.md`), as a `ShannonChatModel` over the
 * official SDK (`@anthropic-ai/sdk`, owner answer I-6). Core: response path. It is reached only through `TieredChatModel`,
 * for a turn the difficulty policy gave `sonnet` while routing is on; its own failures before any word make that model
 * answer with luna instead.
 *
 * - Text: the structured turn (`output_config.format`), read like luna's (`parsedChatTurn`, `chatTurnResult`); streamed, the
 *   `reply` field goes out as it is written (`ChatReplyStreamDecoder`).
 * - Voice: the spoken text; streamed, every word as it comes, with her fixed waiting phrase when a round calls a tool before
 *   she has said anything.
 * - Usage: one `chat` row per response (input = uncached + cache write + cache read; cached = cache read), priced by
 *   `estimatedAnthropicCostUsd` (web searches included).
 * - First-token latency (`firstTokenLatency`): time from a turn's first request to its first word or tool call on a streamed
 *   voice turn; the rolling measurement the voice policy reads (owner answer I-2). Text turns are measured apart
 *   (`textFirstTokenLatency`), so they never move the voice estimate (review H3).
 * - First-token watchdog (review H3): a request with `firstTokenBudgetMs` (a voice turn routed to Sonnet) is aborted when no word
 *   and no tool call came within it (`SonnetFirstTokenTimeout`), before anything was said or run, so luna can answer instead;
 *   on voice a round that ran out of time before any tool ran fails the same way instead of asking Sonnet again.
 */
export class SonnetFirstTokenTimeout extends Error {
  constructor() {
    super('SONNET_FIRST_TOKEN_TIMEOUT');
    this.name = 'SonnetFirstTokenTimeout';
  }
}

export class FirstTokenLatency {
  private readonly samples: number[] = [];

  constructor(private readonly window = 20, private readonly minimum = 3) {}

  record(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.samples.push(milliseconds);
    if (this.samples.length > this.window) this.samples.shift();
  }

  /** The 80th percentile of the recent samples; null until there are enough. */
  estimate(): number | null {
    if (this.samples.length < this.minimum) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.8) - 1)]!;
  }
}

export interface AnthropicChatModelOptions {
  apiKey: string;
  settings: ClaudeChatSettings;
  /** The client's fetch (tests: recorded responses). */
  fetch?: typeof fetch;
  usageStore?: LlmUsageStore;
  now?: () => string;
  agentHostHint?: string;
  /** A turn without tools: its whole time (the turn deadline bounds a turn with tools). */
  timeoutMilliseconds?: number;
  clock?: () => number;
  voiceStreamBounds?: Partial<VoiceStreamBounds>;
  voiceResponseTimeoutMilliseconds?: number;
  /** Sonnet's external read uses the configured auxiliary Haiku client/key. */
  webSearch?: WebSearchOperation;
  /** The pause before the one transient retry (tests: no real timer). */
  retryWait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Text turns follow the foreground cache plan (`anthropicCachePlan.ts`); unset: `SHANNON_CLAUDE_CACHE_PLAN`. Native 5.5 only. */
  cachePlan?: boolean;
  /** Voice turns follow it (`anthropicVoicePlan.ts`); unset: `SHANNON_CLAUDE_CACHE_PLAN_VOICE`. Native 5.5 only. */
  voiceCachePlan?: boolean;
}

export class AnthropicChatModel implements ShannonChatModel {
  readonly mode = 'anthropic' as const;
  readonly model: string;
  readonly firstTokenLatency = new FirstTokenLatency();
  readonly textFirstTokenLatency = new FirstTokenLatency();
  private readonly clock: () => number;
  private readonly transport: ClaudeConversationTransport;
  private readonly cachePlan: boolean;
  private readonly voicePlan: boolean;

  constructor(private readonly options: AnthropicChatModelOptions) {
    if (!options.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY is required');
    this.model = options.settings.model;
    this.cachePlan = options.cachePlan === undefined ? cachePlanApplies(this.model) : options.cachePlan && isAppendOnlyAnthropicModel(this.model);
    const voicePlan = options.voiceCachePlan;
    this.voicePlan = voicePlan === undefined ? voicePlanApplies(this.model) : voicePlan && isAppendOnlyAnthropicModel(this.model);
    this.clock = options.clock ?? (() => performance.now());
    // No SDK retries: the turn's deadline bounds it. The transport alone adds one bounded transient retry for Haiku.
    const client = claudeClient({ apiKey: options.apiKey, timeoutMilliseconds: options.timeoutMilliseconds ?? 45_000, fetch: options.fetch });
    this.transport = { client, clock: this.clock, usageStore: options.usageStore, now: options.now, timeoutMilliseconds: options.timeoutMilliseconds,
      voiceResponseTimeoutMilliseconds: options.voiceResponseTimeoutMilliseconds, retryWait: options.retryWait };
  }

  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    return this.text(request, null);
  }

  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    return this.text(request, onReplyText);
  }

  async generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
    return this.voice(request, null);
  }

  async generateVoiceStreaming(request: ShannonVoiceModelRequest, onTextDelta: (delta: string) => void | Promise<void>, signal?: AbortSignal): Promise<ShannonChatModelResult> {
    return this.voice(request, onTextDelta, signal);
  }

  readonly searchWeb: WebSearchOperation = async input => {
    if (this.options.webSearch) return this.options.webSearch(input);
    input.signal?.throwIfAborted();
    const milliseconds = Math.min(30_000, Math.max(0, input.milliseconds ?? 30_000));
    if (milliseconds < 1_000) return webSearchFailure('unavailable');
    const signal = AbortSignal.any([AbortSignal.timeout(milliseconds), ...(input.signal ? [input.signal] : [])]);
    const maximumUses = Number.isSafeInteger(input.maxUses) ? Math.min(3, Math.max(1, input.maxUses!)) : 3;
    const body = nativeWebSearchBody(input.query.slice(0, 2_000), maximumUses, input.filters);
    const send = this.sender({ scopeKey: input.scopeKey, route: 'web_search' }, () => null, signal);
    try {
      // At most the existing three pause continuations: <= 4 requests * maxUses searches, never a retry of unknown work.
      return nativeWebSearchResult(await serverToolRounds(body, send, signal), maximumUses);
    } catch { input.signal?.throwIfAborted(); return webSearchFailure('unknown'); }
  };

  /** Deep research: one page read with the native fetch tool (`anthropicWebRead.ts`), through the same transport and booking. */
  readonly readWeb: WebReadOperation = async input => {
    input.signal?.throwIfAborted();
    const milliseconds = Math.min(45_000, Math.max(0, input.milliseconds ?? 45_000));
    const url = webReadUrl(input.url);
    if (!url || milliseconds < 1_000) return webSearchFailure(url ? 'unavailable' : 'not_searched');
    const signal = AbortSignal.any([AbortSignal.timeout(milliseconds), ...(input.signal ? [input.signal] : [])]);
    const body = nativeWebReadBody(url, (input.focus ?? '').slice(0, 500));
    const send = this.sender({ scopeKey: input.scopeKey, route: 'web_search' }, () => null, signal);
    try {
      return nativeWebReadResult(await serverToolRounds(body, send, signal));
    } catch {
      input.signal?.throwIfAborted();
      return webSearchFailure('unknown');
    }
  };

  private async text(request: ShannonChatModelRequest, onReplyText: ((text: string) => void | Promise<void>) | null): Promise<ShannonChatModelResult> {
    const searchDeadline = request.tools?.deadline ?? new TurnDeadline(TEXT_TURN_DEADLINE, this.clock);
    // The explicit app button keeps its intent while letting the primary form a query from this conversation.
    if (request.useWebSearch && !request.placeSearch && request.tools && baseToolSession(request.tools).definitions.some(tool => tool.name === 'web.search')) {
      request = { ...request, useWebSearch: false, requireWebSearch: true };
    }
    let searched: Awaited<ReturnType<WebSearchOperation>> | undefined;
    if (request.useWebSearch || request.placeSearch) {
      const location = request.placeSearch;
      const query = `${request.message}${location?.latitude !== undefined && location.longitude !== undefined ? `\n今回だけ許可された現在地: ${location.latitude}, ${location.longitude}` : ''}`;
      searched = await this.searchWeb({ scopeKey: request.scopeKey, query, milliseconds: searchDeadline.forStep(30_000) });
      if (searched.status !== 'results') return { mode: this.mode, model: this.model, reply: searched.text };
      if (searchDeadline.forAnswer() < 2_000) return this.outOfTimeTurn(request, '');
      request = { ...request, turnContext: [request.turnContext, webSearchContext(searched)].filter(Boolean).join('\n\n') };
    }
    request = this.boundedToolMenu(request);
    observerHandoff('context', 'native', { surface: 'text', model: this.model });
    const body = observeSync('native', { surface: 'text' }, () => this.textBody(request), observedAnthropicRequest, { model: this.model });
    let written = '';
    let searchRequested = request.requireWebSearch === true;
    const watch = watchdog(request.firstTokenBudgetMs);
    const send = this.sender(this.textTarget(request), onReplyText ? (delta, decoder) => {
      const text = decoder.push(delta);
      if (!text) return null;
      const read = turnWebSearchResult(request.tools);
      if ((read && read.status !== 'results') || (searchRequested && !searched && !read)) return null;
      written += text;
      return Promise.resolve(onReplyText(text)).then(() => text);
    } : null, watch?.signal, this.textFirstTokenLatency, watch?.first);
    const usable = (message: Anthropic.Message) => { try { parsedChatTurn({ output_text: textOf(message) }); return true; } catch { return false; } };
    const plan = this.planTurn(request);
    let result: ClaudeToolLoopResult;
    try {
      result = await claudeToolLoop(body, { session: offersTools(request) ? request.tools : undefined,
        send: async (body, time, round) => {
          const message = await send(body, time ?? (searched ? { milliseconds: Math.max(1, searchDeadline.forAnswer()), answer: () => searchDeadline.forAnswer() } : null), round);
          // Provider attempts also include calls skipped before the session by time/call ceilings. This grants no authority.
          if (message.content.some(block => block.type === 'tool_use' && block.name === 'web_search')) searchRequested = true;
          return message;
        }, isAnswer: usable,
        missingRequiredRead: message => searchRequested && !searched && !turnWebSearchResult(request.tools) && !searchNeedsInput(message),
        ...(usesOneHourAnthropicCache(this.model) ? { plainBody: this.textBody({ ...request, tools: undefined }, false) } : {}),
        ...(watch ? { signal: watch.signal, timedOutRound: 'fail' as const } : {}), ...plan.rounds });
    } catch (error) { throw watch?.timedOut() ? new SonnetFirstTokenTimeout() : error; } finally { watch?.clear(); }
    const outOfTime = (sent?: string): ShannonChatModelResult => this.outOfTimeTurn(request, sent ?? written);
    if (result.outOfTime || !result.final) return outOfTime(result.outOfTime?.sent);
    let structured: ReturnType<typeof parsedChatTurn>;
    try {
      observerHandoff('llm', 'decode', { surface: 'text' });
      structured = observeSync('decode', { surface: 'text' }, () => parsedChatTurn({ output_text: textOf(result.final!) }),
        value => ({ reply: value.reply.slice(0, 4_000) }));
    } catch (error) {
      // Before any tool ran or word went out, the turn is luna's; after, her fixed line.
      if (result.used === 0 && !written) throw error;
      return outOfTime();
    }
    plan.answered(structured);
    const read = turnWebSearchResult(request.tools);
    const turn = { ...chatTurnResult(this.model, request, { output_text: textOf(result.final) }, structured), mode: this.mode };
    if (searchRequested && !searched && !read && !searchNeedsInput(result.final)) return webSearchFailedTurn(turn, webSearchFailure('not_searched'), turnCompletedWriteReceipts(request.tools));
    if (read && read.status !== 'results') return webSearchFailedTurn(turn, read, turnCompletedWriteReceipts(request.tools));
    const webSources = searched?.sources ?? read?.sources ?? webSourcesOf(result);
    const { webSources: _luna, ...rest } = turn;
    return { ...rest, mode: this.mode, model: this.model, ...(webSources.length ? { webSources } : {}) };
  }

  /** Her fixed line after what was already written (also the tiered model's answer when a fallback would repeat a word or a tool). */
  outOfTimeTurn(request: ShannonChatModelRequest, sent: string): ShannonChatModelResult {
    const reply = `${new ChatSentenceSplitter().append(sent).join('')}${TURN_OUT_OF_TIME_LINE}`;
    const structured = parsedChatTurn({ output_text: JSON.stringify({ reply, threadSummary: null, taskDecision: { disposition: 'none', reason: '時間が足りなかった' },
      taskProposal: null, intentPlan: null, artifacts: null }) });
    return { ...chatTurnResult(this.model, request, { output_text: '' }, structured), mode: this.mode, model: this.model, reply, outOfTime: true };
  }

  private async voice(request: ShannonVoiceModelRequest, onTextDelta: ((delta: string) => void | Promise<void>) | null, signal?: AbortSignal): Promise<ShannonChatModelResult> {
    request = this.boundedToolMenu(request);
    const tools = request.tools?.definitions.length && !request.useWebSearch ? request.tools : undefined;
    const ceiling = tools ? Math.max(VOICE_MAX_OUTPUT_TOKENS[request.conversationClass], VOICE_TOOL_OUTPUT_TOKENS) : VOICE_MAX_OUTPUT_TOKENS[request.conversationClass];
    observerHandoff('context', 'native', { surface: 'voice', model: this.model });
    const plan = this.voicePlanTurn(request, ceiling);
    const body = observeSync('native', { surface: 'voice' }, () => this.voiceBody(request, ceiling, plan.planned), observedAnthropicRequest, { model: this.model });
    let spoken = '';
    let voiceRequests = 0;
    const speak = async (text: string) => { spoken += text; if (!request.useWebSearch) await onTextDelta?.(text); };
    const watch = watchdog(request.firstTokenBudgetMs);
    const stop = watch ? (signal ? AbortSignal.any([signal, watch.signal]) : watch.signal) : signal;
    const bounds = { ...DEFAULT_VOICE_STREAM_BOUNDS, ...this.options.voiceStreamBounds };
    if (request.useWebSearch) bounds.firstOutputMilliseconds = Math.max(bounds.firstOutputMilliseconds, VOICE_WEB_FIRST_OUTPUT_MILLISECONDS);
    const listen = onTextDelta ? (delta: string) => speak(delta).then(() => request.useWebSearch ? '' : delta) : null;
    const target = { scopeKey: request.scopeKey, route: 'voice' as const, ...(request.threadKey === undefined ? {} : { thread: request.threadKey }) };
    const send = this.sender(target, listen, stop, this.firstTokenLatency, watch?.first, bounds);
    let result: ClaudeToolLoopResult;
    try {
      result = await claudeToolLoop(body, {
        session: tools, send: (body, time, round) => { voiceRequests++; return send(body, time, round); }, isAnswer: () => false, ...(stop ? { signal: stop } : {}), timedOutRound: isHaikuModel(this.model) ? 'answer' : 'fail',
        ...(usesOneHourAnthropicCache(this.model) ? { plainBody: claudeVoiceBody(this.options.settings, { ...request, tools: undefined }, ceiling) } : {}),
        // Nothing is heard while a tool runs: before the first call of a turn in which she said nothing, her waiting phrase.
        onCalls: async names => { watch?.first(); if (onTextDelta && !spoken && names[0]) await speak(voiceWaitingPhrase(names[0])); },
        ...plan.rounds,
      });
    } catch (error) {
      const declinedBeforeWork = voiceRequests === 1 && error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status);
      if (request.useWebSearch && !signal?.aborted && !declinedBeforeWork) { const failed = webSearchFailure('unknown'); await onTextDelta?.(failed.text); return { mode: this.mode, model: this.model, reply: failed.text }; }
      throw watch?.timedOut() && !signal?.aborted ? new SonnetFirstTokenTimeout() : error;
    } finally { watch?.clear(); }
    if (result.outOfTime || !result.final) {
      const standing = request.useWebSearch ? '' : completeSpokenSentences(spoken.trim()) || '';
      if (onTextDelta) { if (request.useWebSearch) await onTextDelta(TURN_OUT_OF_TIME_LINE); else await speak(TURN_OUT_OF_TIME_LINE); }
      return { mode: this.mode, model: this.model, reply: `${standing}${TURN_OUT_OF_TIME_LINE}`, outOfTime: true };
    }
    observerHandoff('llm', 'decode', { surface: 'voice' });
    return observeAsync('decode', { surface: 'voice' }, async () => {
    const said = (onTextDelta ? spoken : result.turns.map(textOf).filter(Boolean).join('')).trim();
    if (request.useWebSearch) {
      const evidence = nativeWebSearchResult(result.turns, request.conversationClass === 'skill_complex' ? 3 : 2);
      if (evidence.status !== 'results') { await onTextDelta?.(evidence.text); return { mode: this.mode, model: this.model, reply: evidence.text }; }
    }
    const truncated = result.final!.stop_reason === 'max_tokens';
    const reply = truncated ? completeSpokenSentences(said) || said : said;
    if (request.useWebSearch) await onTextDelta?.(reply);
    if (!reply) throw new Error('ANTHROPIC_RESPONSE_EMPTY');
    const webSources = webSourcesOf(result);
    return { mode: this.mode, model: this.model, reply, ...(webSources.length ? { webSources } : {}), ...(truncated ? { truncated: true } : {}) };
    }, value => ({ reply: value.reply.slice(0, 4_000), truncated: value.truncated === true }));
  }

  /** The text turn's request: the cache plan's (`anthropicCachePlan.ts`) or the one before it, byte for byte. */
  private textBody(request: ShannonChatModelRequest, plan = this.cachePlan): Anthropic.MessageCreateParamsNonStreaming {
    const build = plan ? plannedChatBody : claudeTextBody;
    return build(this.options.settings, request, this.options.agentHostHint);
  }

  /** The voice turn's request: the voice plan's (`anthropicVoicePlan.ts`) or the one before it, byte for byte. */
  private voiceBody(request: ShannonVoiceModelRequest, ceiling: number, plan: boolean): Anthropic.MessageCreateParamsNonStreaming {
    return (plan ? plannedVoiceBody : claudeVoiceBody)(this.options.settings, request, ceiling);
  }

  /**
   * What the voice plan adds to a voice turn's rounds, as for text (`planTurn`): a call in a turn without tools is declined once,
   * and a refused first request is asked again in the shape without the plan. A turn with a native web search keeps that shape
   * (`voice:web_exception`). Nothing here adds a request to an ordinary turn.
   */
  private voicePlanTurn(request: ShannonVoiceModelRequest, ceiling: number): { planned: boolean; rounds: Partial<ClaudeToolLoopOptions> } {
    if (!this.voicePlan) return { planned: false, rounds: {} };
    if (!voicePlanCovers(request)) {
      notePlanEvent('voice', 'web_exception');
      return { planned: false, rounds: {} };
    }
    notePlanEvent('voice', 'plan_turn');
    const onPlanEvent = (event: string) => notePlanEvent('voice', event);
    return { planned: true, rounds: { declineUnofferedCalls: true, planFallback: this.voiceBody(request, ceiling, false), onPlanEvent } };
  }

  /** Where a text turn's requests go: its Talk, for the receipts only. */
  private textTarget(request: ShannonChatModelRequest): ClaudeSendRequest['target'] {
    const thread = request.threadKey === undefined ? {} : { thread: request.threadKey };
    return { scopeKey: request.scopeKey, route: 'text', ...thread };
  }

  /**
   * What the cache plan adds to a text turn's rounds (review F1, F2): a call in a turn without tools is declined once, a refused
   * first request falls back to the shape without the plan, and what happened is counted; and, with or without the plan, whether
   * an offered feeling was answered (F4).
   */
  private planTurn(request: ShannonChatModelRequest): { rounds: Partial<ClaudeToolLoopOptions>; answered(structured: ParsedChatTurn): void } {
    let rejected = false;
    const answered = (structured: ParsedChatTurn) => {
      const feeling = offeredFeelingAnswered(request, structured);
      if (feeling !== null) noteFeelingAnswer(this.cachePlan, feeling);
      if (rejected) notePlanEvent('text', 'recovered');
    };
    if (!this.cachePlan) return { rounds: {}, answered };
    notePlanEvent('text', exceptionTurn(request) ? 'schema_exception' : 'schema_common');
    const onPlanEvent = (event: string) => {
      rejected ||= event !== 'declined';
      notePlanEvent('text', event);
    };
    return { rounds: { declineUnofferedCalls: true, planFallback: this.textBody(request, false), onPlanEvent }, answered };
  }

  /** Normalize discovery before building the body. The native adapter budgets actual schemas, including JSON output. */
  private boundedToolMenu<T extends { tools?: ShannonModelToolSession }>(request: T): T {
    if (!isAppendOnlyAnthropicModel(this.model) || !request.tools || !request.tools.definitions.length) return request;
    if (request.tools.menu && request.tools.definitions.length <= 20) return request;
    // Build before the body so the same session supplies full discovery instructions, always-loaded controls,
    // lazy visibility and the native rounds. Opening still delegates to the original deadline/audience/gate/runner.
    const chosen = request.tools.definitions.length < 20 ? request.tools.definitions.map(tool => providerToolName(tool.name)) : [];
    return { ...request, tools: withToolMenu(baseToolSession(request.tools), chosen) };
  }

  /** One request of a turn, through the one transport (`claudeTransport.ts`). */
  private sender(target: ClaudeSendRequest['target'], listen: ClaudeListener | null,
    caller?: AbortSignal, latency: FirstTokenLatency = this.firstTokenLatency, onFirst?: () => void, voiceBounds?: VoiceStreamBounds): ClaudeSend {
    return claudeConversationSender(this.transport, { target, listen, caller, latency, onFirst, voiceBounds });
  }
}

/**
 * A server-tool request (a web search, a page read) through the one tool loop: at most three pause continuations, the signed
 * content appended whole, tools/system never changed; the caller reads a refusal itself.
 */
async function serverToolRounds(body: Anthropic.MessageCreateParamsNonStreaming, send: ClaudeSend,
  signal: AbortSignal): Promise<readonly Anthropic.Message[]> {
  const stopped: ClaudeSend = async (request, time, round) => {
    signal.throwIfAborted();
    const message = await send(request, time, round);
    signal.throwIfAborted();
    return message;
  };
  return (await claudeToolLoop(body, { session: undefined, send: stopped, isAnswer: () => true, refusal: 'final' })).turns;
}

/** The text of a response's `text` blocks, in order (thinking blocks and tool calls are not text). */
export function textOf(message: Anthropic.Message): string {
  return message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map(block => block.text).join('');
}

/** The pages her web searches found in the turn, without duplicates, at most eight. */
export function webSourcesOf(result: Pick<ClaudeToolLoopResult, 'turns'>): ShannonWebSource[] {
  const seen = new Set<string>();
  const sources: ShannonWebSource[] = [];
  for (const message of result.turns) {
    for (const block of message.content) {
      if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
      for (const hit of block.content) {
        if (hit.type !== 'web_search_result' || seen.has(hit.url)) continue;
        seen.add(hit.url);
        sources.push({ title: hit.title || hit.url, url: hit.url });
      }
    }
  }
  return sources.slice(0, 8);
}

/** The first-token watchdog of a request with a budget: aborts unless `first` was called in time. */
function watchdog(budgetMs: number | undefined): { signal: AbortSignal; first(): void; clear(): void; timedOut(): boolean } | null {
  if (budgetMs === undefined || !Number.isFinite(budgetMs)) return null;
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => { fired = true; controller.abort(new SonnetFirstTokenTimeout()); }, Math.max(0, budgetMs));
  timer.unref?.();
  return { signal: controller.signal, first: () => clearTimeout(timer), clear: () => clearTimeout(timer), timedOut: () => fired };
}
