import Anthropic from '@anthropic-ai/sdk';
import { observeSync } from '../../observer/observerContext.js';
import { structuredSchema } from '../anthropic/anthropicSchema.js';
import { cacheOneShotRequest, validateHaikuCacheUsage } from '../anthropic/haikuCache.js';
import { isHaikuModel } from '../anthropic/haikuConfig.js';
import { observedAnthropicRequest, observedAnthropicResponse } from '../anthropic/observerProjection.js';
import type { LlmUsageLane, LlmUsageStore } from '../llmUsage.js';
import { claudeClient } from './claudeClient.js';
import { sendClaudeOnce } from './claudeOnce.js';
import { bookBackgroundUsage, closedUsage } from './claudeUsage.js';

/**
 * The background route (Syzygy ADR-0009 stage 1, M8; `docs/haiku-model-cache-contract.md`): one native Messages request of a
 * background caller (memory, sleep, the summaries, the looks, the voice router, the turn checker…), typed by its caller and
 * sent through the one-shot transport (`claudeOnce.ts`). It replaces the OpenAI Responses shim these callers sent through.
 *
 * - The request: the fixed transport protocol (one 1h breakpoint, no automatic marker on the unique tail: `cacheOneShotRequest`),
 *   the caller's instructions, its input, adaptive thinking at the caller's effort (`none`/`minimal` → `low`), its JSON schema in
 *   the supported subset (`structuredSchema`), and an output ceiling of at least 1,024 tokens.
 * - Usage: one row in the route's lane, booked before anything is checked (`bookBackgroundUsage`), a cache receipt (`background`).
 * - A provider refusal with a status returns `{ ok: false, status }` and books nothing, so the caller keeps its own error.
 * - A response that is not a whole answer throws its closed code after its usage was booked: missing cache evidence
 *   (`HAIKU_CACHE_*`), incomplete usage, a refusal, a cut-off, a block that is not text or thinking, or no text.
 *
 * It imports nothing of the conversation, so a worker that loads it loads no turn deadline, stream decoder or tool loop.
 */
export const BACKGROUND_ROUTES = Object.freeze({
  turn_check: 'chat', spoken_report: 'chat', organize: 'chat', touch: 'chat', room_look: 'chat', voice_photo: 'chat',
  voice_router: 'voice', memory_rewrite: 'memory', memory_rerank: 'memory', memory_sections: 'memory',
  replay_summary: 'memory_background', replay_template: 'memory_background', person_facts: 'memory_background',
  impressions: 'memory_background', platform_summary: 'memory_background', knowledge: 'memory_background',
  skill_sleep: 'memory_background', sleep: 'sleep', daily_mind: 'sleep', commitment_line: 'sleep',
} as const satisfies Readonly<Record<string, LlmUsageLane>>);

export type BackgroundRoute = keyof typeof BACKGROUND_ROUTES;

/** The effort a caller asks for, on the native scale: nothing below `low` exists there (ADR-0009 stage 1, quick fix 4). */
export type BackgroundEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
const NATIVE_EFFORT = Object.freeze({ none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high' } as const);

/** One text, or messages of the user and of her (text and image blocks). */
export type StructuredInput = string | readonly Anthropic.MessageParam[];
export type StructuredSchema = Readonly<Record<string, unknown>>;

export interface ClaudeBackground {
  readonly model: string;
  readonly client: Anthropic;
  readonly usageStore?: Pick<LlmUsageStore, 'recordLlmUsage'>;
  readonly now?: () => string;
}

export interface ClaudeBackgroundOptions {
  apiKey: string;
  /** Tests: recorded responses. */
  fetcher?: typeof fetch;
  /** Where every request goes instead of the API origin (https, or http on the loopback host). */
  endpoint?: string;
  usageStore?: Pick<LlmUsageStore, 'recordLlmUsage'>;
  now?: () => string;
}

/** The background route of a configured model, or null for a model that is not Claude (it keeps its own provider's request). */
export function claudeBackground(model: string, options: ClaudeBackgroundOptions): ClaudeBackground | null {
  if (!isHaikuModel(model)) return null;
  if (!options.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY_REQUIRED');
  const endpoint = options.endpoint;
  if (endpoint && !validEndpoint(new URL(endpoint))) throw new Error('HAIKU_ENDPOINT_INVALID');
  const fetcher = options.fetcher ?? fetch;
  const client = claudeClient({ apiKey: options.apiKey, timeoutMilliseconds: 60_000, fetch: (input, init) => fetcher(endpoint ?? input, init) });
  return { model, client, ...(options.usageStore ? { usageStore: options.usageStore } : {}), ...(options.now ? { now: options.now } : {}) };
}

function validEndpoint(url: URL): boolean {
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return (url.protocol === 'https:' || loopback) && !url.username && !url.password && url.hostname !== 'api.openai.com';
}

export interface StructuredOptions<T = unknown> {
  claude: ClaudeBackground;
  scopeKey: string;
  maximumOutputTokens: number;
  effort: BackgroundEffort;
  signal?: AbortSignal;
  /** Right after the usage row was booked (an FCA-accounted caller's `accounted`). */
  onBooked?: () => void;
  /** An FCA-accounted call: a response whose bill is not known throws `BACKGROUND_MODEL_USAGE_UNKNOWN` before anything else. */
  requireUsage?: boolean;
  /** How the caller reads the answer's text; unset: the parsed JSON with a schema, the text without one. */
  read?: (text: string) => T;
  /** The usage row's time, when the caller's clock is not the route's (`ClaudeBackground.now`). */
  at?: () => string;
  /** What a request that got no answer throws (stopped, or no status); unset: the error itself, or the signal's reason. */
  unsent?: (error: unknown) => unknown;
}

/** A provider refusal carries its status and the provider's error body (data, never logged here). */
export type StructuredAnswer<T> = { ok: true; value: T } | { ok: false; status: number; body: unknown };

/**
 * The caller's answer: with a schema the parsed JSON (`OPENAI_RESPONSE_NON_JSON` when it is not), without one the text, trimmed
 * of surrounding whitespace; or what the caller's `read` makes of that text.
 */
export async function completeStructured<T = unknown>(route: BackgroundRoute, system: string, input: StructuredInput,
  schema: StructuredSchema | null, options: StructuredOptions<T>): Promise<StructuredAnswer<T>> {
  const { claude, signal } = options;
  const unsent = options.unsent ?? ((error: unknown) => error);
  if (signal?.aborted) throw unsent(stopped(signal));
  const body = observeSync('native', { route }, () => structuredBody(claude.model, system, input, schema, options.effort, options.maximumOutputTokens),
    observedAnthropicRequest, { model: claude.model });
  let message: Anthropic.Message;
  try {
    message = await sendClaudeOnce({
      body, receipt: 'background', message: value => value,
      dispatch: () => claude.client.messages.create(body, signal ? { signal } : {}),
      span: { handoff: { model: body.model }, input: { ...observedAnthropicRequest(body), round: 0, streaming: false },
        project: observedAnthropicResponse, model: body.model },
    });
  } catch (error) {
    if (signal?.aborted) throw unsent(stopped(signal));
    if (error instanceof Anthropic.APIError && error.status !== undefined) return { ok: false, status: error.status, body: error.error };
    throw unsent(error);
  }
  const text = settled(route, message, body, options);
  if (options.read) return { ok: true, value: options.read(text) };
  return { ok: true, value: (schema ? jsonOf(text) : text) as T };
}

/** The answer as JSON: an empty text is an empty object, anything else that does not parse is `OPENAI_RESPONSE_NON_JSON` (as before). */
function jsonOf(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('OPENAI_RESPONSE_NON_JSON');
  }
}

function stopped(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** The request as it leaves: the protocol prefix (`cacheOneShotRequest`), the instructions, the input and the format. */
export function structuredBody(model: string, system: string, input: StructuredInput, schema: StructuredSchema | null,
  effort: BackgroundEffort, maximumOutputTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  const format = schema ? { format: { type: 'json_schema' as const, schema: structuredSchema(schema) as Record<string, unknown> } } : {};
  return cacheOneShotRequest({
    model, max_tokens: Math.max(1_024, maximumOutputTokens), ...(system ? { system } : {}), messages: structuredMessages(input),
    thinking: { type: 'adaptive' }, output_config: { effort: NATIVE_EFFORT[effort], ...format },
  });
}

/**
 * The input as native messages. These are background inputs, including an extraction history ending in a reply, never an
 * assistant continuation: a history that ends with her turn is followed by the task's user turn, and one that begins with her
 * turn is preceded by a marker.
 */
export function structuredMessages(input: StructuredInput): Anthropic.MessageParam[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  const messages = [...input];
  if (messages.at(-1)?.role === 'assistant') {
    messages.push({ role: 'user', content: '[Apply the current application task instructions to the input above and return the required result.]' });
  }
  if (messages[0]?.role === 'assistant') {
    messages.unshift({ role: 'user', content: '[Conversation history follows; the current task input is later in this request.]' });
  }
  return messages;
}

/** The usage booked, then the answer checked; the trimmed text of a whole answer. */
function settled<T>(route: BackgroundRoute, message: Anthropic.Message, body: Anthropic.MessageCreateParamsNonStreaming,
  options: StructuredOptions<T>): string {
  const { claude } = options;
  bookBackgroundUsage(claude.usageStore, {
    scopeKey: options.scopeKey, lane: BACKGROUND_ROUTES[route], model: claude.model, usage: message.usage,
    maximumOutputTokens: body.max_tokens, at: options.at ?? (() => claude.now?.() ?? new Date().toISOString()),
  });
  options.onBooked?.();
  if (options.requireUsage && !closedUsage(message.usage)) throw new Error('BACKGROUND_MODEL_USAGE_UNKNOWN');
  validateHaikuCacheUsage(message.usage);
  const { text, failure } = answerOf(message);
  if (failure) throw new Error(failure);
  return text;
}

const ANSWER_BLOCKS: readonly string[] = ['text', 'thinking', 'redacted_thinking'];

/** The text of the response, and the closed code of what makes it not a whole answer (the last that applies). */
function answerOf(message: Anthropic.Message): { text: string; failure?: string } {
  let failure: string | undefined = closedUsage(message.usage) ? undefined : 'HAIKU_RESPONSE_USAGE_INVALID';
  if (message.stop_reason !== 'end_turn') failure = message.stop_reason === 'refusal' ? 'HAIKU_RESPONSE_REFUSAL' : 'HAIKU_RESPONSE_INCOMPLETE';
  const content: readonly unknown[] = Array.isArray(message.content) ? message.content : [];
  const blocks = content.map(block => block && typeof block === 'object' ? block as { type?: unknown; text?: unknown } : null);
  const unsupported = blocks.some(block => !block || !ANSWER_BLOCKS.includes(String(block.type)));
  if (!Array.isArray(message.content) || unsupported) failure = 'HAIKU_RESPONSE_UNSUPPORTED_BLOCK';
  const text = blocks.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('');
  if (!text && !failure) failure = 'HAIKU_RESPONSE_EMPTY';
  return { text: text.trim(), ...(failure ? { failure } : {}) };
}

const BASE64_IMAGE = /^(image\/(?:jpeg|png|gif|webp))$/u;
const BASE64_DATA = /^[A-Za-z0-9+/]+={0,2}$/u;

/** An image as a native block, or null for a media type or data the provider does not take (the caller's own failure). */
export function base64Image(mediaType: string, base64: string): Anthropic.ImageBlockParam | null {
  if (!BASE64_IMAGE.test(mediaType) || !BASE64_DATA.test(base64)) return null;
  return { type: 'image', source: { type: 'base64', media_type: mediaType as Anthropic.Base64ImageSource['media_type'], data: base64 } };
}
