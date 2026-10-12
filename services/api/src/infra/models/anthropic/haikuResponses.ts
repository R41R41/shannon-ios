import { observeSync } from '../../observer/observerContext.js';
import { observedAnthropicRequest, observedAnthropicResponse } from './observerProjection.js';
import Anthropic from '@anthropic-ai/sdk';
import { structuredSchema } from './anthropicSchema.js';
import { claudeClient } from '../claude/claudeClient.js';
import { sendClaudeOnce } from '../claude/claudeOnce.js';
import { knownInput, unknownCostUpperBound } from '../claude/claudeUsage.js';
import { cacheOneShotRequest, validateHaikuCacheUsage, type HaikuCacheUsage } from './haikuCache.js';
import { isHaikuModel, replacementModel } from './haikuConfig.js';

type Row = Record<string, unknown>;
type Block = Anthropic.ContentBlockParam;
const MAXIMUM_REQUEST_BYTES = 16 * 1024 * 1024;
const MAXIMUM_MESSAGES = 128;
const MAXIMUM_BLOCKS = 128;
const requestKeys = new Set(['model', 'instructions', 'input', 'reasoning', 'text', 'max_output_tokens', 'store',
  'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier']);

/** Background JSON/text only. Chat tools and streaming use their native Anthropic implementation. */
export function responseModelFetcher(options: { model: string; apiKey: string; fetcher?: typeof fetch; endpoint?: string }): typeof fetch {
  const fetcher = options.fetcher ?? fetch;
  if (!isHaikuModel(options.model)) return fetcher;
  if (!options.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY_REQUIRED');
  const endpoint = options.endpoint;
  if (endpoint) {
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      || url.username || url.password || url.hostname === 'api.openai.com') throw new Error('HAIKU_ENDPOINT_INVALID');
  }
  const client = claudeClient({ apiKey: options.apiKey, timeoutMilliseconds: 60_000, fetch: (input, init) => fetcher(endpoint ?? input, init) });
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method.toUpperCase() !== 'POST') throw new Error('HAIKU_RESPONSES_UNSUPPORTED_METHOD');
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAXIMUM_REQUEST_BYTES) throw new Error('HAIKU_RESPONSES_INVALID_BODY');
    const body = observeSync('native', { format: 'responses' }, () => requestBody(JSON.parse(raw), options.model), observedAnthropicRequest, { model: options.model });
    try {
      const { data: message, response } = await sendClaudeOnce({
        body, receipt: 'background', message: value => value.data,
        dispatch: () => client.messages.create(body, signal ? { signal } : {}).withResponse(),
        span: { handoff: { model: body.model }, input: { ...observedAnthropicRequest(body), round: 0, streaming: false },
          project: value => observedAnthropicResponse(value.data), model: body.model },
      });
      const headers = new Headers({ 'content-type': 'application/json' });
      const requestID = response.headers.get('request-id');
      if (requestID) headers.set('request-id', requestID);
      return new Response(JSON.stringify(responseEnvelope(message, body)), { status: 200, headers });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (error instanceof Anthropic.APIError && error.status !== undefined) {
        return new Response(JSON.stringify({ error: error.error ?? { type: 'api_error' } }), {
          status: error.status, headers: { 'content-type': 'application/json' },
        });
      }
      throw error;
    }
  }) as typeof fetch;
}

/** Raw provider cache counts remain in the envelope, separate from Responses' summed input count. Record first. */
export function validateResponseModelUsage(model: string, envelope: unknown): void {
  if (!isHaikuModel(model)) return;
  const value = row(envelope);
  validateHaikuCacheUsage(row(value.usage) as HaikuCacheUsage);
  const failure = object(value.error)?.code;
  if (typeof failure === 'string') throw new Error(failure);
}

function requestBody(value: unknown, model: string): Anthropic.MessageCreateParamsNonStreaming {
  const body = row(value);
  if (Object.keys(body).some(key => !requestKeys.has(key)) || typeof body.model !== 'string' || replacementModel(body.model) !== model) {
    throw new Error('HAIKU_RESPONSES_UNSUPPORTED_SHAPE');
  }
  if (body.store !== undefined && body.store !== false) throw new Error('HAIKU_RESPONSES_UNSUPPORTED_STORE');
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new Error('HAIKU_RESPONSES_INVALID_INSTRUCTIONS');
  if (body.reasoning !== undefined) {
    const reasoning = row(body.reasoning);
    if (Object.keys(reasoning).some(key => key !== 'effort') || (reasoning.effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high'].includes(String(reasoning.effort)))) {
      throw new Error('HAIKU_RESPONSES_UNSUPPORTED_REASONING');
    }
  }
  const ceiling = body.max_output_tokens ?? 4_000;
  if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling <= 0 || ceiling > 128_000) throw new Error('HAIKU_RESPONSES_INVALID_TOKEN_LIMIT');
  const format = outputFormat(body.text);
  return cacheOneShotRequest({ model, max_tokens: Math.max(1_024, ceiling),
    ...(body.instructions ? { system: body.instructions as string } : {}), messages: inputMessages(body.input),
    thinking: { type: 'adaptive' }, output_config: { effort: requestedEffort(body.reasoning), ...(format ? { format } : {}) } });
}

/** The Responses effort a caller asked for, on the native scale; nothing below `low` exists there (ADR-0009 stage 1, quick fix 4). */
const NATIVE_EFFORT = Object.freeze({ none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high' } as const);

function requestedEffort(reasoning: unknown): (typeof NATIVE_EFFORT)[keyof typeof NATIVE_EFFORT] {
  const effort = reasoning === undefined ? undefined : row(reasoning).effort;
  if (typeof effort !== 'string' || !Object.hasOwn(NATIVE_EFFORT, effort)) return 'low';
  return NATIVE_EFFORT[effort as keyof typeof NATIVE_EFFORT];
}

function outputFormat(value: unknown): Anthropic.JSONOutputFormat | undefined {
  if (value === undefined) return undefined;
  const text = row(value);
  if (Object.keys(text).some(key => key !== 'format' && key !== 'verbosity')) throw new Error('HAIKU_RESPONSES_UNSUPPORTED_TEXT');
  if (text.verbosity !== undefined && !['low', 'medium', 'high'].includes(String(text.verbosity))) throw new Error('HAIKU_RESPONSES_UNSUPPORTED_TEXT');
  if (text.format === undefined) return undefined;
  const format = row(text.format);
  if (format.type !== 'json_schema' || Object.keys(format).some(key => !['type', 'name', 'strict', 'schema'].includes(key)) || !object(format.schema)) {
    throw new Error('HAIKU_RESPONSES_UNSUPPORTED_FORMAT');
  }
  if ((format.strict !== undefined && typeof format.strict !== 'boolean') || (format.name !== undefined && typeof format.name !== 'string')) throw new Error('HAIKU_RESPONSES_UNSUPPORTED_FORMAT');
  return { type: 'json_schema', schema: structuredSchema(format.schema) as Row };
}

function inputMessages(input: unknown): Anthropic.MessageParam[] {
  if (typeof input === 'string' && input.length) return [{ role: 'user', content: input }];
  if (!Array.isArray(input) || !input.length || input.length > MAXIMUM_MESSAGES) throw new Error('HAIKU_RESPONSES_INVALID_INPUT');
  const messages: Anthropic.MessageParam[] = input.map(item => {
    const value = row(item);
    if (Object.keys(value).some(key => !['type', 'role', 'content'].includes(key)) || (value.type !== undefined && value.type !== 'message')) {
      throw new Error('HAIKU_RESPONSES_UNSUPPORTED_MESSAGE');
    }
    if (!['user', 'assistant', 'developer', 'system'].includes(String(value.role))) throw new Error('HAIKU_RESPONSES_UNSUPPORTED_ROLE');
    const role = value.role === 'developer' || value.role === 'system' ? 'system' : value.role as 'user' | 'assistant';
    if (typeof value.content === 'string' && value.content.length) return { role, content: value.content };
    if (!Array.isArray(value.content) || !value.content.length || value.content.length > MAXIMUM_BLOCKS) throw new Error('HAIKU_RESPONSES_INVALID_CONTENT');
    return { role, content: value.content.map(part => contentBlock(part, role)) };
  });
  // These are background inputs, including an extraction history ending in a reply, never an assistant continuation.
  if (messages.at(-1)?.role === 'assistant') messages.push({ role: 'user', content: '[Apply the current application task instructions to the input above and return the required result.]' });
  if (messages[0]?.role === 'assistant' || messages[0]?.role === 'system') messages.unshift({ role: 'user', content: '[Conversation history follows; the current task input is later in this request.]' });
  return messages;
}

function contentBlock(value: unknown, role: string): Block {
  const part = row(value);
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    if (Object.keys(part).some(key => !['type', 'text'].includes(key)) || typeof part.text !== 'string' || !part.text.length) throw new Error('HAIKU_RESPONSES_INVALID_TEXT_BLOCK');
    return { type: 'text', text: part.text };
  }
  if (part.type !== 'input_image' || role !== 'user' || Object.keys(part).some(key => !['type', 'image_url', 'detail'].includes(key))
    || typeof part.image_url !== 'string' || (part.detail !== undefined && !['auto', 'low', 'high'].includes(String(part.detail)))) {
    throw new Error('HAIKU_RESPONSES_UNSUPPORTED_CONTENT');
  }
  const image = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(part.image_url);
  if (image) return { type: 'image', source: { type: 'base64', media_type: image[1] as Anthropic.Base64ImageSource['media_type'], data: image[2]! } };
  const url = new URL(part.image_url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('HAIKU_RESPONSES_INVALID_IMAGE');
  return { type: 'image', source: { type: 'url', url: part.image_url } };
}

function responseEnvelope(message: Anthropic.Message, request: Anthropic.MessageCreateParamsNonStreaming): Row {
  const usage = object(message.usage) ?? {};
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const inputCounts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens];
  const knownInputCounts = inputCounts.filter(count);
  const inputSum = knownInputCounts.reduce((sum, value) => sum + value, 0);
  const input = knownInputCounts.length && Number.isSafeInteger(inputSum) ? inputSum : null;
  const output = count(usage.output_tokens) ? usage.output_tokens : null;
  const valid = inputCounts.every(count) && input !== null && output !== null && Number.isSafeInteger(input + output);
  const unknownUpperBound = unknownCostUpperBound(request.model, request.max_tokens, 0, knownInput(message.usage));
  const mappedUsage = { input_tokens: input, output_tokens: output, total_tokens: input !== null && output !== null ? input + output : null,
    input_tokens_details: { cached_tokens: usage.cache_read_input_tokens }, uncached_input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation: usage.cache_creation, usage_complete: valid,
    ...(!valid ? { unknown_cost_upper_bound_usd: unknownUpperBound } : {}) };
  let failure: string | undefined; let cacheConfirmed = false;
  try { validateHaikuCacheUsage(usage as HaikuCacheUsage); cacheConfirmed = true; } catch (error) { failure = error instanceof Error ? error.message : 'HAIKU_CACHE_USAGE_INVALID'; }
  if (!valid) failure = 'HAIKU_RESPONSE_USAGE_INVALID';
  if (message.stop_reason !== 'end_turn') failure = message.stop_reason === 'refusal' ? 'HAIKU_RESPONSE_REFUSAL' : 'HAIKU_RESPONSE_INCOMPLETE';
  const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
  if (!Array.isArray(message.content) || blocks.some(block => !block || !['text', 'thinking', 'redacted_thinking'].includes(String(block.type)))) failure = 'HAIKU_RESPONSE_UNSUPPORTED_BLOCK';
  const text = blocks.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('');
  if (!text && !failure) failure = 'HAIKU_RESPONSE_EMPTY';
  return { id: message.id, model: message.model, object: 'response', status: failure ? 'failed' : 'completed',
    output_text: failure ? '' : text, output: failure ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: mappedUsage, haiku_cache: { confirmed: cacheConfirmed }, ...(failure ? { error: { code: failure } } : {}) };
}

function object(value: unknown): Row | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null; }
function row(value: unknown): Row { const result = object(value); if (!result) throw new Error('HAIKU_RESPONSES_INVALID_OBJECT'); return result; }
