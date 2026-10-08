import { actionPermit, currentActionExecution } from '../../context/actionExecution.js';
import Anthropic from '@anthropic-ai/sdk';
import { PartialAnswerError, RoundTimer, TURN_OUT_OF_TIME_LINE, type RoundTime } from '../../../mind/action/respond/turnDeadline.js';
import { completeSpokenSentences } from '../../../surfaces/voice/spokenSentences.js';
import { ChatSentenceSplitter } from '../../../surfaces/text/chatSentenceSplitter.js';
import {
  VOICE_MAX_OUTPUT_TOKENS, type ShannonChatModel, type ShannonChatModelRequest, type ShannonChatModelResult, type ShannonVoiceModelRequest, type ShannonWebSource,
} from '../chatModel.js';
import { VOICE_TOOL_OUTPUT_TOKENS, voiceWaitingPhrase } from '../chatModelTools.js';
import { chatTurnResult, offersTools, parsedChatTurn } from '../chatModelTurn.js';
import { ChatReplyStreamDecoder } from '../chatReplyStreamDecoder.js';
import type { LlmUsageStore } from '../llmUsage.js';
import { estimatedAnthropicCostUsd, type SonnetSettings } from './anthropicConfig.js';
import { sonnetChatBody, sonnetVoiceBody } from './anthropicRequest.js';
import { sonnetToolRounds, type SonnetRoundResult } from './anthropicRounds.js';
import { isHaikuModel } from './haikuConfig.js';
import { cacheHaikuRequest, validateHaikuCacheUsage } from './haikuCache.js';
import { DEFAULT_VOICE_STREAM_BOUNDS, VOICE_RESPONSE_TIMEOUT_MILLISECONDS, VOICE_WEB_FIRST_OUTPUT_MILLISECONDS, type VoiceStreamBounds } from '../chatModelVoiceStream.js';

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
  settings: SonnetSettings;
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
}

export class AnthropicChatModel implements ShannonChatModel {
  readonly mode = 'anthropic' as const;
  readonly model: string;
  readonly firstTokenLatency = new FirstTokenLatency();
  readonly textFirstTokenLatency = new FirstTokenLatency();
  private readonly client: Anthropic;
  private readonly clock: () => number;

  constructor(private readonly options: AnthropicChatModelOptions) {
    if (!options.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY is required');
    this.model = options.settings.model;
    this.clock = options.clock ?? (() => performance.now());
    // No retries of its own: the turn's deadline bounds it, and a failure before any word is luna's turn.
    this.client = new Anthropic({ apiKey: options.apiKey, authToken: null, webhookKey: null, baseURL: 'https://api.anthropic.com', logLevel: 'off',
      maxRetries: 0, timeout: options.timeoutMilliseconds ?? 45_000, ...(options.fetch ? { fetch: options.fetch } : {}) });
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

  private async text(request: ShannonChatModelRequest, onReplyText: ((text: string) => void | Promise<void>) | null): Promise<ShannonChatModelResult> {
    const body = sonnetChatBody(this.options.settings, request, this.options.agentHostHint);
    let written = '';
    const escalation = this.escalation(request, () => written === '');
    const watch = watchdog(request.firstTokenBudgetMs);
    const send = this.sender(request.scopeKey, onReplyText ? (delta, decoder) => {
      const text = decoder.push(delta);
      if (!text) return null;
      written += text;
      return Promise.resolve(onReplyText(text)).then(() => text);
    } : null, watch?.signal, this.textFirstTokenLatency, watch?.first);
    const usable = (message: Anthropic.Message) => { try { parsedChatTurn({ output_text: textOf(message) }); return true; } catch { return false; } };
    let result: SonnetRoundResult;
    try {
      result = await sonnetToolRounds(body, { session: offersTools(request) ? request.tools : undefined, send, isAnswer: usable,
        ...(isHaikuModel(this.model) ? { plainBody: sonnetChatBody(this.options.settings, { ...request, tools: undefined }, this.options.agentHostHint) } : {}),
        ...(escalation ? { escalate: escalation.option } : {}), ...(watch ? { signal: watch.signal, timedOutRound: 'fail' as const } : {}) });
    } catch (error) { throw watch?.timedOut() ? new SonnetFirstTokenTimeout() : error; } finally { watch?.clear(); }
    const outOfTime = (sent?: string): ShannonChatModelResult => ({ ...this.outOfTimeTurn(request, sent ?? written), ...(escalation?.happened() ? { escalated: true } : {}) });
    if (result.outOfTime || !result.final) return outOfTime(result.outOfTime?.sent);
    let structured: ReturnType<typeof parsedChatTurn>;
    try { structured = parsedChatTurn({ output_text: textOf(result.final) }); } catch (error) {
      // Before any tool ran or word went out, the turn is luna's; after, her fixed line.
      if (result.used === 0 && !written) throw error;
      return outOfTime();
    }
    const turn = chatTurnResult(this.model, request, { output_text: textOf(result.final) }, structured);
    const webSources = webSourcesOf(result);
    const { webSources: _luna, ...rest } = turn;
    return { ...rest, mode: this.mode, model: this.model, ...(webSources.length ? { webSources } : {}), ...(escalation?.happened() ? { escalated: true } : {}) };
  }

  /** Her fixed line after what was already written (also the tiered model's answer when a fallback would repeat a word or a tool). */
  outOfTimeTurn(request: ShannonChatModelRequest, sent: string): ShannonChatModelResult {
    const reply = `${new ChatSentenceSplitter().append(sent).join('')}${TURN_OUT_OF_TIME_LINE}`;
    const structured = parsedChatTurn({ output_text: JSON.stringify({ reply, threadSummary: null, taskDecision: { disposition: 'none', reason: '時間が足りなかった' },
      taskProposal: null, intentPlan: null, artifacts: null }) });
    return { ...chatTurnResult(this.model, request, { output_text: '' }, structured), mode: this.mode, model: this.model, reply, outOfTime: true };
  }

  private async voice(request: ShannonVoiceModelRequest, onTextDelta: ((delta: string) => void | Promise<void>) | null, signal?: AbortSignal): Promise<ShannonChatModelResult> {
    const tools = request.tools?.definitions.length && !request.useWebSearch ? request.tools : undefined;
    const ceiling = tools ? Math.max(VOICE_MAX_OUTPUT_TOKENS[request.conversationClass], VOICE_TOOL_OUTPUT_TOKENS) : VOICE_MAX_OUTPUT_TOKENS[request.conversationClass];
    const body = sonnetVoiceBody(this.options.settings, request, ceiling);
    let spoken = '';
    let replyStarted = false;
    const escalation = this.escalation(request, () => !replyStarted);
    const speak = async (text: string) => { spoken += text; await onTextDelta?.(text); };
    const watch = watchdog(request.firstTokenBudgetMs);
    const stop = watch ? (signal ? AbortSignal.any([signal, watch.signal]) : watch.signal) : signal;
    const bounds = { ...DEFAULT_VOICE_STREAM_BOUNDS, ...this.options.voiceStreamBounds };
    if (request.useWebSearch) bounds.firstOutputMilliseconds = Math.max(bounds.firstOutputMilliseconds, VOICE_WEB_FIRST_OUTPUT_MILLISECONDS);
    const send = this.sender(request.scopeKey, onTextDelta ? delta => { replyStarted = true; return speak(delta).then(() => delta); } : null,
      stop, this.firstTokenLatency, watch?.first, bounds);
    let result: SonnetRoundResult;
    try {
      result = await sonnetToolRounds(body, {
        session: tools, send, isAnswer: () => false, ...(stop ? { signal: stop } : {}), timedOutRound: isHaikuModel(this.model) ? 'answer' : 'fail',
        ...(isHaikuModel(this.model) ? { plainBody: sonnetVoiceBody(this.options.settings, { ...request, tools: undefined }, ceiling) } : {}),
        ...(escalation ? { escalate: escalation.option } : {}),
        // Nothing is heard while a tool runs: before the first call of a turn in which she said nothing, her waiting phrase.
        onCalls: async names => { watch?.first(); if (onTextDelta && !spoken && names[0]) await speak(voiceWaitingPhrase(names[0])); },
      });
    } catch (error) { throw watch?.timedOut() && !signal?.aborted ? new SonnetFirstTokenTimeout() : error; } finally { watch?.clear(); }
    if (result.outOfTime || !result.final) {
      const standing = completeSpokenSentences(spoken.trim()) || '';
      if (onTextDelta) await speak(TURN_OUT_OF_TIME_LINE);
      return { mode: this.mode, model: this.model, reply: `${standing}${TURN_OUT_OF_TIME_LINE}`, outOfTime: true, ...(escalation?.happened() ? { escalated: true } : {}) };
    }
    const said = (onTextDelta ? spoken : result.turns.map(textOf).filter(Boolean).join('')).trim();
    const truncated = result.final.stop_reason === 'max_tokens';
    const reply = truncated ? completeSpokenSentences(said) || said : said;
    if (!reply) throw new Error('ANTHROPIC_RESPONSE_EMPTY');
    const webSources = webSourcesOf(result);
    return { mode: this.mode, model: this.model, reply, ...(webSources.length ? { webSources } : {}), ...(truncated ? { truncated: true } : {}), ...(escalation?.happened() ? { escalated: true } : {}) };
  }

  private escalation(request: ShannonChatModelRequest | ShannonVoiceModelRequest, allowed: () => boolean) {
    if (!isHaikuModel(this.model) || !request.escalation || request.tier === 'luna_plus') return null;
    let happened = false;
    return { happened: () => happened, option: { allowed, onEscalated: () => { happened = true; } } };
  }

  /**
   * One request: streamed when there is a listener (its first word or call measured on the turn's first round, its words
   * handed on in order), else not. A stream that fails or is refused after words went out is a `PartialAnswerError`.
   */
  private sender(scopeKey: string, listen: ((delta: string, decoder: ChatReplyStreamDecoder) => Promise<string> | null) | null, caller?: AbortSignal,
    latency: FirstTokenLatency = this.firstTokenLatency, onFirst?: () => void, voiceBounds?: VoiceStreamBounds) {
    return async (body: Anthropic.MessageCreateParamsNonStreaming, time: RoundTime | null, round: number): Promise<Anthropic.Message> => {
      await actionPermit();
      const timer = time ? new RoundTimer(time) : null;
      const bounds = isHaikuModel(this.model) && voiceBounds && listen ? streamWatch(voiceBounds) : null;
      const total = isHaikuModel(this.model) && !time && !bounds
        ? AbortSignal.timeout(voiceBounds ? this.options.voiceResponseTimeoutMilliseconds ?? VOICE_RESPONSE_TIMEOUT_MILLISECONDS : this.options.timeoutMilliseconds ?? 30_000) : undefined;
      const signals = [caller, timer?.signal, currentActionExecution()?.signal, bounds?.signal, total].filter((value): value is AbortSignal => Boolean(value));
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const started = this.clock();
      let sent = '';
      const prepared = isHaikuModel(this.model) ? cacheHaikuRequest(body) : body;
      let observedUsage: Anthropic.Message['usage'] | null = null;
      let receivedUsage = false;
      let usageRecorded = false;
      try {
        if (!listen) {
          const message = await this.client.messages.create(prepared, { ...(signal ? { signal } : {}),
            ...(isHaikuModel(this.model) && voiceBounds ? { timeout: this.options.voiceResponseTimeoutMilliseconds ?? VOICE_RESPONSE_TIMEOUT_MILLISECONDS } : {}) });
          // Not streamed: the first response is the first token.
          if (round === 0) onFirst?.();
          this.recordUsage(scopeKey, message, prepared.max_tokens);
          usageRecorded = true;
          if (isHaikuModel(this.model)) validateNativeUsage(message.usage);
          return message;
        }
        const decoder = new ChatReplyStreamDecoder();
        let first = false;
        const stream = this.client.messages.stream(prepared, signal ? { signal } : {});
        for await (const event of stream) {
          bounds?.event();
          if (event.type === 'message_start') {
            receivedUsage = true;
            observedUsage = event.message.usage;
            if (isHaikuModel(this.model)) validateNativeUsage(observedUsage);
          } else if (event.type === 'message_delta' && observedUsage) {
            observedUsage = mergeUsage(observedUsage, event.usage);
          }
          const text = event.type === 'content_block_delta' && event.delta.type === 'text_delta' ? event.delta.text : null;
          if (!first && round === 0 && (text !== null || (event.type === 'content_block_start' && event.content_block.type === 'tool_use'))) {
            first = true;
            onFirst?.();
            latency.record(this.clock() - started);
          }
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use'
            || event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') bounds?.output();
          if (text === null) continue;
          const handed = listen(text, decoder);
          if (handed) { timer?.answering(); bounds?.pause(); sent += await handed; signal?.throwIfAborted(); bounds?.output(); }
        }
        const message = await stream.finalMessage();
        this.recordUsage(scopeKey, message, prepared.max_tokens);
        usageRecorded = true;
        if (isHaikuModel(this.model)) validateNativeUsage(message.usage);
        if (message.stop_reason === 'refusal' && sent) throw new PartialAnswerError(sent);
        return message;
      } catch (error) {
        if (receivedUsage && !usageRecorded) this.recordUsage(scopeKey, { usage: observedUsage }, prepared.max_tokens);
        if (bounds?.signal.aborted && !caller?.aborted) error = bounds.signal.reason;
        if (sent && !(error instanceof PartialAnswerError) && !caller?.aborted) throw new PartialAnswerError(sent);
        throw error;
      } finally { timer?.clear(); bounds?.clear(); }
    };
  }

  private recordUsage(scopeKey: string, message: { usage?: Anthropic.Message['usage'] | null }, maximumOutputTokens = 16_000): void {
    const usage = message.usage;
    const counts = {
      input: knownCount(usage?.input_tokens), cacheWrite: knownCount(usage?.cache_creation_input_tokens), cacheRead: knownCount(usage?.cache_read_input_tokens),
      output: knownCount(usage?.output_tokens), searches: knownCount(usage?.server_tool_use?.web_search_requests),
      cacheWrite5m: knownCount(usage?.cache_creation?.ephemeral_5m_input_tokens),
      cacheWrite1h: knownCount(usage?.cache_creation?.ephemeral_1h_input_tokens),
    };
    const input = counts.input + counts.cacheWrite + counts.cacheRead;
    this.options.usageStore?.recordLlmUsage({
      scopeKey, lane: 'chat', model: this.model, inputTokens: input, cachedInputTokens: counts.cacheRead, outputTokens: counts.output,
      totalTokens: input + counts.output, estimatedCostUsd: Math.max(estimatedAnthropicCostUsd(this.model, counts),
        isHaikuModel(this.model) && !nativeUsageComplete(usage) ? 1 + maximumOutputTokens * 2.5 / 1_000_000 : 0),
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
    });
  }
}

/** Stream deltas may omit input counts with null: retain the counts reported at message_start. */
function mergeUsage(previous: Anthropic.Message['usage'], delta: unknown): Anthropic.Message['usage'] {
  return { ...previous, ...Object.fromEntries(Object.entries(delta as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined)) };
}

function knownCount(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function nativeUsageComplete(usage: Anthropic.Message['usage'] | null | undefined): boolean {
  return [usage?.input_tokens, usage?.output_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens]
    .every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function validateNativeUsage(usage: Anthropic.Message['usage'] | null | undefined): void {
  validateHaikuCacheUsage(usage);
  if (!nativeUsageComplete(usage)) throw new Error('HAIKU_RESPONSE_USAGE_INVALID');
}

/** The base lane keeps the existing first-output and provider-silence bounds, with no total speech limit. */
function streamWatch(bounds: VoiceStreamBounds) {
  const controller = new AbortController();
  let first = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => clearTimeout(timer);
  const arm = (milliseconds: number, code: string) => { clear(); timer = setTimeout(() => controller.abort(new Error(code)), milliseconds); };
  const idle = () => arm(bounds.idleMilliseconds, 'ANTHROPIC_RESPONSE_IDLE_TIMEOUT');
  arm(bounds.firstOutputMilliseconds, 'ANTHROPIC_RESPONSE_FIRST_OUTPUT_TIMEOUT');
  return { signal: controller.signal, clear, pause: clear, event: () => { if (first) idle(); }, output: () => { first = true; idle(); } };
}

/** The text of a response's `text` blocks, in order (thinking blocks and tool calls are not text). */
export function textOf(message: Anthropic.Message): string {
  return message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map(block => block.text).join('');
}

/** The pages her web searches found in the turn, without duplicates, at most eight. */
export function webSourcesOf(result: Pick<SonnetRoundResult, 'turns'>): ShannonWebSource[] {
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
