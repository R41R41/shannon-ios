import Anthropic from '@anthropic-ai/sdk';
import { setTimeout as wait } from 'node:timers/promises';
import { actionPermit, currentActionExecution } from '../../context/actionExecution.js';
import { observeAsync, observerHandoff } from '../../observer/observerContext.js';
import { PartialAnswerError, RoundTimer, type RoundTime } from '../../../mind/action/respond/turnDeadline.js';
import { ChatReplyStreamDecoder } from '../chatReplyStreamDecoder.js';
import { VOICE_RESPONSE_TIMEOUT_MILLISECONDS, type VoiceStreamBounds } from '../chatModelVoiceStream.js';
import type { LlmUsageStore } from '../llmUsage.js';
import { recordCacheReceipt, type CacheRoute, type CacheTurn } from '../anthropic/cacheReceipts.js';
import { cachePlanRequest, wordsIndex } from '../anthropic/cachePlanMarkers.js';
import { isPlannedBody, planSchemaOf } from '../anthropic/anthropicCachePlan.js';
import { observedAnthropicRequest, observedAnthropicResponse } from '../anthropic/observerProjection.js';
import {
  AnthropicUsageEvidenceError, cacheHaikuRequest, serverSearchCacheStart, settledServerSearchUsage, validateHaikuCacheUsage,
  type HaikuCacheUsage, type ServerSearchCacheStart,
} from '../anthropic/haikuCache.js';
import { isAppendOnlyAnthropicModel, isHaikuModel, usesOneHourAnthropicCache } from '../anthropic/haikuConfig.js';
import { bookConversationUsage, knownCount, nativeUsageComplete } from './claudeUsage.js';

/**
 * The way a conversation request reaches Claude (Syzygy ADR-0009 stage 1, M3; `docs/haiku-model-cache-contract.md`): text,
 * voice and the native web search, created or streamed. Request builders, the tool loop and the reading of the answer stay
 * with the conversation model; this module sends what it is handed, byte for byte, and owns what happens around the send:
 * the action permit, the round deadline and abort signals, the voice stream's first-output and silence bounds, first-token
 * timing, usage capture from the stream and its booking, the cache receipt, the cache-evidence check, the observer's span,
 * and the one bounded transient retry. One-shot callers send through `claudeOnce.ts`, which loads none of the conversation.
 */
type Message = Anthropic.Message;
type Body = Anthropic.MessageCreateParamsNonStreaming;
type Usage = Message['usage'];

// --- The transient retry -----------------------------------------------------------------------------------------------------

export const TRANSIENT_RETRY = Object.freeze({ defaultWaitMs: 1_000, maximumWaitMs: 3_000 });

/**
 * A provider refusal that says "try again shortly" and proves nothing ran: 429, 529, any 5xx, or an overloaded/api error
 * delivered before the response began. Connection failures and aborts are not included: whether such a request was
 * processed is unknown, and an unknown paid call is never retried.
 */
export function transientProviderFailure(error: unknown): string | null {
  if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIUserAbortError) return null;
  const status = error.status;
  if (status === 429 || status === 529 || (status !== undefined && status >= 500 && status < 600)) return String(status);
  if (status === undefined && (error.type === 'overloaded_error' || error.type === 'api_error')) return error.type;
  return null;
}

/** The provider's `retry-after-ms` / `retry-after` (seconds or a date), else one second; never more than three seconds. */
export function transientRetryWaitMs(error: unknown, now = Date.now()): number {
  const headers = error instanceof Anthropic.APIError ? error.headers : undefined;
  const raw = headers?.get('retry-after-ms');
  let pause = raw ? Number(raw) : Number.NaN;
  const after = headers?.get('retry-after');
  if (Number.isNaN(pause) && after) {
    const seconds = Number(after);
    pause = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(after) - now;
  }
  if (!Number.isFinite(pause)) pause = TRANSIENT_RETRY.defaultWaitMs;
  return Math.min(TRANSIENT_RETRY.maximumWaitMs, Math.max(0, pause));
}

export function defaultRetryWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return wait(milliseconds, undefined, signal ? { signal } : {});
}

// --- Conversation requests ---------------------------------------------------------------------------------------------------

/** One request of a turn; `time` is the round's share of the turn deadline, absent for a request without tools. */
export type ClaudeSend = (body: Body, time: RoundTime | null, round: number) => Promise<Message>;

/** A delta of reply text handed to the caller: the visible text it accepted (a promise), or null when it took none. */
export type ClaudeListener = (delta: string, decoder: ChatReplyStreamDecoder) => Promise<string> | null;

export interface ClaudeConversationTransport {
  readonly client: Anthropic;
  readonly clock: () => number;
  readonly usageStore?: LlmUsageStore;
  readonly now?: () => string;
  /** A Haiku request with no round time and no voice bounds: its whole time (30 s by default). */
  readonly timeoutMilliseconds?: number;
  readonly voiceResponseTimeoutMilliseconds?: number;
  /** The pause before the one transient retry (tests: no real timer). */
  readonly retryWait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface ClaudeSendRequest {
  /**
   * `thread`: the Talk the turn belongs to, kept in the cache receipt only as a short hash. Whether a request follows the
   * foreground cache plan is the body's own mark (`isPlannedBody`), so a plan turn's fallback to the shape without it is sent
   * with the one-hour cache of every other request.
   */
  target: { scopeKey: string; route: CacheRoute; thread?: string };
  /** Streamed when present: each text delta goes through it in order. */
  listen: ClaudeListener | null;
  caller?: AbortSignal;
  /** Where the first word or call of a turn's first request is measured. */
  latency: { record(milliseconds: number): void };
  onFirst?: () => void;
  voiceBounds?: VoiceStreamBounds;
}

interface StreamWatch {
  signal: AbortSignal;
  clear(): void;
  pause(): void;
  event(): void;
  output(): void;
}

interface Attempt {
  readonly transport: ClaudeConversationTransport;
  readonly request: ClaudeSendRequest;
  readonly body: Body;
  readonly prepared: Body;
  readonly round: number;
  readonly timer: RoundTimer | null;
  readonly bounds: StreamWatch | null;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
  sent: string;
  observedUsage: Usage | null;
  searchCacheStart: ServerSearchCacheStart | null;
  explicitSearchTtl: HaikuCacheUsage['cache_creation'] | undefined;
  receivedUsage: boolean;
  usageRecorded: boolean;
  firstVisibleOutputAfterMs?: number;
  finalUsageAfterMs?: number;
  /** The turn's first word or call, from the start of its first request (round 0 of a streamed request only). */
  firstTokenMs?: number;
}

interface StreamProgress {
  first: boolean;
  readonly streamStarted: number;
}

/**
 * The send of a conversation's requests: streamed when there is a listener (its first word or call measured on the turn's
 * first round, its words handed on in order), else not. A stream that fails or is refused after words went out is a
 * `PartialAnswerError`. Haiku alone gets one bounded retry of a transient refusal of a turn's first request.
 */
export function claudeConversationSender(transport: ClaudeConversationTransport, request: ClaudeSendRequest): ClaudeSend {
  // Failures that provably reached nothing: no usage, no word handed out. Only these may be retried.
  const clean = new WeakSet<object>();
  const attempt: ClaudeSend = (body, time, round) => attemptOnce(transport, request, { body, time, round }, clean);
  return async (body, time, round) => {
    try {
      return await attempt(body, time, round);
    } catch (error) {
      return retriedOnce(transport, request, { body, round, error, clean }, () => attempt(body, time, round));
    }
  };
}

/** Haiku: one bounded retry of a transient refusal, only on a turn's first request (no tool has run) and only when nothing was billed or said. */
async function retriedOnce(transport: ClaudeConversationTransport, request: ClaudeSendRequest,
  failed: { body: Body; round: number; error: unknown; clean: WeakSet<object> }, again: () => Promise<Message>): Promise<Message> {
  const { error } = failed;
  const clean = failed.round === 0 && isHaikuModel(failed.body.model) && error && typeof error === 'object' && failed.clean.has(error);
  const transient = clean ? transientProviderFailure(error) : null;
  const stop = [request.caller, currentActionExecution()?.signal].filter((value): value is AbortSignal => Boolean(value));
  if (!transient || stop.some(signal => signal.aborted)) throw error;
  const pause = transientRetryWaitMs(error);
  console.log(`Shannon model transient failure: ${transient}, retrying once after ${pause} ms`);
  await (transport.retryWait ?? defaultRetryWait)(pause, stop.length ? AbortSignal.any(stop) : undefined);
  return again();
}

async function attemptOnce(transport: ClaudeConversationTransport, request: ClaudeSendRequest,
  send: { body: Body; time: RoundTime | null; round: number }, clean: WeakSet<object>): Promise<Message> {
  await actionPermit();
  const attempt = openAttempt(transport, request, send);
  const model = attempt.prepared.model;
  observerHandoff('native', 'llm', { model, round: send.round });
  try {
    const input = { ...observedAnthropicRequest(attempt.prepared), round: send.round, streaming: request.listen !== null };
    const listen = request.listen;
    const work = () => listen ? streamed(attempt, listen) : created(attempt);
    return await observeAsync('llm', input, work, message => observedAttempt(attempt, message), { model });
  } catch (error) {
    throw failedAttempt(attempt, error, clean);
  } finally {
    attempt.timer?.clear();
    attempt.bounds?.clear();
  }
}

function openAttempt(transport: ClaudeConversationTransport, request: ClaudeSendRequest,
  send: { body: Body; time: RoundTime | null; round: number }): Attempt {
  const { body, time, round } = send;
  const timer = time ? new RoundTimer(time) : null;
  const bounds = isHaikuModel(body.model) && request.voiceBounds && request.listen ? streamWatch(request.voiceBounds) : null;
  const signal = attemptSignal(transport, request, send, { timer, bounds });
  const started = transport.clock();
  const prepared = preparedBody(body);
  return {
    transport, request, body, prepared, round, timer, bounds, signal, started, sent: '', observedUsage: null, searchCacheStart: null,
    explicitSearchTtl: undefined, receivedUsage: false, usageRecorded: false,
  };
}

/** The request as it leaves: the cache plan's breakpoints, or the one-hour cache every other native 5.5 request gets. */
function preparedBody(body: Body): Body {
  if (!usesOneHourAnthropicCache(body.model)) return body;
  return isPlannedBody(body) ? cachePlanRequest(body) : cacheHaikuRequest(body);
}

function attemptSignal(transport: ClaudeConversationTransport, request: ClaudeSendRequest, send: { body: Body; time: RoundTime | null },
  controls: { timer: RoundTimer | null; bounds: StreamWatch | null }): AbortSignal | undefined {
  const { timer, bounds } = controls;
  const voiceTimeout = transport.voiceResponseTimeoutMilliseconds ?? VOICE_RESPONSE_TIMEOUT_MILLISECONDS;
  const whole = request.voiceBounds ? voiceTimeout : transport.timeoutMilliseconds ?? 30_000;
  const total = isHaikuModel(send.body.model) && !send.time && !bounds ? AbortSignal.timeout(whole) : undefined;
  const signals = [request.caller, timer?.signal, currentActionExecution()?.signal, bounds?.signal, total];
  const present = signals.filter((value): value is AbortSignal => Boolean(value));
  return present.length ? AbortSignal.any(present) : undefined;
}

function inlineTools(body: Body): { headers?: Record<string, string> } {
  return isAppendOnlyAnthropicModel(body.model) ? { headers: { 'anthropic-beta': 'inline-tools-2026-09-15' } } : {};
}

function signalOption(attempt: Attempt): { signal?: AbortSignal } {
  return attempt.signal ? { signal: attempt.signal } : {};
}

async function created(attempt: Attempt): Promise<Message> {
  const { transport, request, body } = attempt;
  const voiceTimeout = isHaikuModel(body.model) && request.voiceBounds
    ? { timeout: transport.voiceResponseTimeoutMilliseconds ?? VOICE_RESPONSE_TIMEOUT_MILLISECONDS } : {};
  const message = await transport.client.messages.create(attempt.prepared, { ...inlineTools(body), ...signalOption(attempt), ...voiceTimeout });
  // Not streamed: the first response is the first token.
  if (attempt.round === 0) request.onFirst?.();
  settle(attempt, message);
  return message;
}

async function streamed(attempt: Attempt, listen: ClaudeListener): Promise<Message> {
  const { transport, prepared } = attempt;
  const decoder = new ChatReplyStreamDecoder();
  const progress: StreamProgress = { first: false, streamStarted: transport.clock() };
  const stream = transport.client.messages.stream(prepared, { ...inlineTools(attempt.body), ...signalOption(attempt) });
  for await (const event of stream) {
    const handed = streamEvent(attempt, { listen, decoder, progress }, event);
    if (handed) await acceptHanded(attempt, progress, handed);
  }
  const completed = await stream.finalMessage();
  attempt.finalUsageAfterMs = Math.max(0, transport.clock() - progress.streamStarted);
  const message = settledServerSearchUsage(completed, attempt.searchCacheStart, attempt.explicitSearchTtl, prepared.messages);
  settle(attempt, message);
  if (message.stop_reason === 'refusal' && attempt.sent) throw new PartialAnswerError(attempt.sent);
  return message;
}

function streamEvent(attempt: Attempt, reading: { listen: ClaudeListener; decoder: ChatReplyStreamDecoder; progress: StreamProgress },
  event: Anthropic.MessageStreamEvent): Promise<string> | null {
  attempt.bounds?.event();
  captureUsage(attempt, event);
  const text = event.type === 'content_block_delta' && event.delta.type === 'text_delta' ? event.delta.text : null;
  noteFirst(attempt, reading.progress, event, text);
  if (event.type === 'content_block_start' && event.content_block.type === 'tool_use'
    || event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') attempt.bounds?.output();
  if (text === null) return null;
  return reading.listen(text, reading.decoder);
}

function noteFirst(attempt: Attempt, progress: StreamProgress, event: Anthropic.MessageStreamEvent, text: string | null): void {
  const toolCall = event.type === 'content_block_start' && event.content_block.type === 'tool_use';
  if (progress.first || attempt.round !== 0 || (text === null && !toolCall)) return;
  progress.first = true;
  attempt.request.onFirst?.();
  attempt.firstTokenMs = attempt.transport.clock() - attempt.started;
  attempt.request.latency.record(attempt.firstTokenMs);
}

function captureUsage(attempt: Attempt, event: Anthropic.MessageStreamEvent): void {
  if (event.type === 'message_start') {
    startUsage(attempt, event.message.usage);
    return;
  }
  if (event.type !== 'message_delta' || !attempt.observedUsage) return;
  attempt.observedUsage = mergeUsage(attempt.observedUsage, event.usage);
  if (Object.hasOwn(event.usage, 'cache_creation')) attempt.explicitSearchTtl = (event.usage as HaikuCacheUsage).cache_creation;
}

function startUsage(attempt: Attempt, usage: Usage): void {
  const { body, prepared } = attempt;
  attempt.receivedUsage = true;
  attempt.observedUsage = usage;
  if (onlyServerWebTools(prepared)) attempt.searchCacheStart = serverSearchCacheStart(usage);
  // Haiku's unconfirmed cache is logged once, at the end.
  if (usesOneHourAnthropicCache(body.model)) validateNativeUsage(usage, isHaikuModel(body.model) ? () => {} : undefined);
}

async function acceptHanded(attempt: Attempt, progress: StreamProgress, handed: Promise<string>): Promise<void> {
  attempt.timer?.answering();
  attempt.bounds?.pause();
  const visible = await handed;
  // Only decoded text accepted by the reply callback, never JSON syntax, thinking or a tool call. This is server handoff
  // latency, not proof of device display/playback or a provider prefill/queue breakdown.
  if (visible && attempt.firstVisibleOutputAfterMs === undefined) {
    attempt.firstVisibleOutputAfterMs = Math.max(0, attempt.transport.clock() - progress.streamStarted);
  }
  attempt.sent += visible;
  attempt.signal?.throwIfAborted();
  attempt.bounds?.output();
}

/** The response's usage booked, its cache receipt left, then its cache evidence checked. */
function settle(attempt: Attempt, message: Message): void {
  book(attempt, message.usage, true);
  recordCacheReceipt(attempt.request.target.route, attempt.prepared, message.usage, attempt.round, undefined, cacheTurn(attempt));
  attempt.usageRecorded = true;
  if (usesOneHourAnthropicCache(attempt.body.model)) validateNativeUsage(message.usage, unconfirmed(attempt.body.model, message.usage));
}

/** What the receipt keeps of the turn: only for a request that names its Talk (none of the one-shot or background callers). */
function cacheTurn(attempt: Attempt): CacheTurn | undefined {
  const { thread } = attempt.request.target;
  if (thread === undefined) return undefined;
  const first = attempt.firstTokenMs === undefined ? {} : { firstTokenMs: attempt.firstTokenMs };
  const schema = planSchemaOf(attempt.body);
  const lane = schema === null ? { cachePlan: false } : { cachePlan: true, planSchema: schema };
  return { thread, ...lane, historyMessages: Math.max(0, wordsIndex(attempt.body.messages)), ...first };
}

function book(attempt: Attempt, usage: Usage | null | undefined, finalUsage: boolean): void {
  const { transport, body } = attempt;
  bookConversationUsage(transport.usageStore, {
    scopeKey: attempt.request.target.scopeKey, model: body.model, usage, maximumOutputTokens: attempt.prepared.max_tokens, finalUsage,
    maximumSearches: searchAllowance(body), at: () => transport.now?.() ?? new Date().toISOString(),
  });
}

function observedAttempt(attempt: Attempt, message: Message) {
  const { firstVisibleOutputAfterMs, finalUsageAfterMs } = attempt;
  return { ...observedAnthropicResponse(message),
    ...(firstVisibleOutputAfterMs !== undefined ? { firstVisibleOutputAfterMs } : {}),
    ...(finalUsageAfterMs !== undefined ? { finalUsageAfterMs } : {}) };
}

function clientRefusal(error: unknown): boolean {
  return error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 400 && error.status < 500;
}

/** What a failed attempt throws; message_start/delta counts are lower bounds until finalMessage, so they are booked as such. */
function failedAttempt(attempt: Attempt, failure: unknown, clean: WeakSet<object>): unknown {
  const { caller } = attempt.request;
  if (attempt.receivedUsage && !attempt.usageRecorded) book(attempt, attempt.observedUsage, false);
  else if (!attempt.usageRecorded && searchAllowance(attempt.body) && !clientRefusal(failure)) book(attempt, undefined, false);
  const error = attempt.bounds?.signal.aborted && !caller?.aborted ? attempt.bounds.signal.reason as unknown : failure;
  if (attempt.sent && !(error instanceof PartialAnswerError) && !caller?.aborted) return new PartialAnswerError(attempt.sent);
  if (!attempt.receivedUsage && !attempt.usageRecorded && error && typeof error === 'object') clean.add(error);
  return error;
}

/** Stream deltas may omit input counts with null: retain the counts reported at message_start. */
function mergeUsage(previous: Usage, delta: unknown): Usage {
  const reported = Object.entries(delta as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined);
  return { ...previous, ...Object.fromEntries(reported) };
}

/**
 * Malformed or incomplete counts still fail closed (the bill is not known). For Haiku, zero cache read and write on an
 * otherwise complete response is different: the answer is valid and already paid, and its usage was booked at the measured
 * uncached price before this check, so the anomaly is logged (`onUnconfirmed`) and the answer kept. Sonnet keeps failing
 * closed: its turn falls back to Haiku before any word, and an uncached Sonnet round is the expensive case the guard limits.
 */
function validateNativeUsage(usage: Usage | null | undefined, onUnconfirmed?: () => void): void {
  try {
    validateHaikuCacheUsage(usage);
  } catch (error) {
    if (!onUnconfirmed || !(error instanceof AnthropicUsageEvidenceError) || error.code !== 'HAIKU_CACHE_UNCONFIRMED') throw error;
    onUnconfirmed();
  }
  if (!nativeUsageComplete(usage)) throw new AnthropicUsageEvidenceError('HAIKU_RESPONSE_USAGE_INVALID');
}

function unconfirmed(model: string, usage: Usage): (() => void) | undefined {
  if (!isHaikuModel(model)) return undefined;
  const counts = `input=${knownCount(usage?.input_tokens)} output=${knownCount(usage?.output_tokens)}`;
  return () => console.log(`Shannon model cache unconfirmed: model=${model} ${counts}`);
}

/** The base lane keeps the existing first-output and provider-silence bounds, with no total speech limit. */
function streamWatch(bounds: VoiceStreamBounds): StreamWatch {
  const controller = new AbortController();
  let first = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => clearTimeout(timer);
  const arm = (milliseconds: number, code: string) => {
    clear();
    timer = setTimeout(() => controller.abort(new Error(code)), milliseconds);
  };
  const idle = () => arm(bounds.idleMilliseconds, 'ANTHROPIC_RESPONSE_IDLE_TIMEOUT');
  arm(bounds.firstOutputMilliseconds, 'ANTHROPIC_RESPONSE_FIRST_OUTPUT_TIMEOUT');
  const output = () => {
    first = true;
    idle();
  };
  return { signal: controller.signal, clear, pause: clear, event: () => first && idle(), output };
}

/** A request whose only tool is one native web server tool (search, or a page read's fetch). */
function onlyServerWebTools(body: Body): boolean {
  const tool = body.tools?.length === 1 ? body.tools[0] : undefined;
  return Boolean(tool && 'name' in tool && (tool.name === 'web_search' && searchAllowance(body) || tool.name === 'web_fetch' && 'max_uses' in tool));
}

/** Missing search counts reserve the full per-request allowance, never a zero search charge. */
function searchAllowance(body: Body): number {
  const uses = (tool: Anthropic.ToolUnion) => 'name' in tool && tool.name === 'web_search' && 'max_uses' in tool ? tool.max_uses ?? 3 : 0;
  return body.tools?.reduce((sum, tool) => sum + uses(tool), 0) ?? 0;
}
