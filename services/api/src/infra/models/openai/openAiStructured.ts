import { createHash } from 'node:crypto';
import type { AnthropicFcaUsage } from '../anthropic/anthropicFcaModel.js';
import { structuredSchema } from '../anthropic/anthropicSchema.js';
import { FCA_MODEL_BILLING } from '../../../mind/action/fca/fcaProviderRetry.js';
import { openAiCostUsd, openAiCounts, openAiUnknownCostUsd } from './openAiFcaWire.js';
import { isOpenAiModel, type OpenAiEffort } from './openAiModels.js';
import { billingRefusal, OpenAiHttpError, postResponses } from './openAiResponsesTransport.js';

/**
 * One structured request on OpenAI's Responses API (`text.format` `json_schema`, strict): the summaries, the first plan, the plan made
 * again and the route plan of a Minecraft body task, when their model is OpenAI's (the Messages-API callers of the same roles are
 * `anthropicFcaSummary.ts`, `minecraftLlmcConfiguration.ts` and `minecraftRouteWiring.ts`). Its usage is charged to the task's step
 * through `recordUsage`, as the decisions' are, and a request that got no answer is booked at what it can have cost.
 */
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * A JSON schema in the strict subset: every object closed with every property required (a property the schema left optional is
 * allowed to be `null`: the answer is pruned of those, `prunedOptional`), limits said in words (`structuredSchema`).
 */
export function strictJsonSchema(schema: unknown): unknown {
  const close = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(close);
    const value = object(node);
    if (!value) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' && object(child)) {
        const required = new Set(Array.isArray(value.required) ? value.required.filter((name): name is string => typeof name === 'string') : []);
        out[key] = Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([name, property]) => {
          const closed = close(property);
          return [name, required.has(name) ? closed : { anyOf: [closed, { type: 'null' }] }];
        }));
      } else out[key] = close(child);
    }
    if (object(value.properties)) {
      out.required = Object.keys(value.properties as Record<string, unknown>);
      out.additionalProperties = false;
    }
    return out;
  };
  return close(structuredSchema(schema));
}

/** The answer without the `null` of a property the schema left optional (the schema as the caller wrote it). */
export function prunedOptional(value: unknown, schema: unknown): unknown {
  const node = object(schema);
  if (Array.isArray(value)) return value.map(item => prunedOptional(item, node?.items));
  const row = object(value);
  if (!row || !node) return value;
  const properties = object(node.properties) ?? {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row)) {
    if (item === null && properties[key] !== undefined && !required.has(key)) continue;
    out[key] = prunedOptional(item, properties[key]);
  }
  return out;
}

export interface OpenAiStructuredOptions {
  model: string;
  apiKey: string;
  effort: OpenAiEffort;
  maximumOutputTokens: number;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  endpoint?: string;
  recordUsage(usage: AnthropicFcaUsage): void | Promise<void>;
  /** The closed word of the role, for the error of an answer that is not whole (`MINECRAFT_<LABEL>_INCOMPLETE`) and the cache key. */
  label: string;
}

/** The parsed JSON of the structured answer, or throws: `OPENAI_HTTP_<status>`, `FCA_MODEL_BILLING`, `MINECRAFT_<LABEL>_INCOMPLETE`, `OPENAI_RESPONSE_NON_JSON`. */
export async function openAiStructured(options: OpenAiStructuredOptions, call: { system: string; input: string; schema: unknown; signal: AbortSignal }): Promise<unknown> {
  if (!isOpenAiModel(options.model)) throw new Error('OPENAI_MODEL_INVALID');
  const { model } = options;
  const body = { model, instructions: call.system, input: [{ role: 'user', content: call.input }], store: false,
    max_output_tokens: options.maximumOutputTokens, reasoning: { effort: options.effort },
    prompt_cache_key: `${options.label.replace(/\s+/gu, '-')}-${createHash('sha256').update(call.system).digest('hex').slice(0, 16)}`,
    text: { format: { type: 'json_schema', name: options.label.replace(/[^A-Za-z0-9_]/gu, '_'), schema: strictJsonSchema(call.schema), strict: true } } };
  const characters = call.system.length + call.input.length;
  // Japanese is about one token a character; the bound is the request as sent and its ceiling.
  const unknown = (): AnthropicFcaUsage => {
    const cost = openAiUnknownCostUsd(model, characters, options.maximumOutputTokens);
    return { model, usageComplete: false, inputTokens: characters, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: options.maximumOutputTokens,
      totalTokens: characters + options.maximumOutputTokens, estimatedCostUsd: cost };
  };
  const signal = AbortSignal.any([call.signal, AbortSignal.timeout(options.timeoutMilliseconds ?? 60_000)]);
  let answer: unknown;
  try {
    signal.throwIfAborted();
    answer = await postResponses({ apiKey: options.apiKey, body, signal, ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}) });
  } catch (error) {
    // An HTTP answer is a refusal that carried nothing (booked as nothing); anything else may have been processed and charged.
    if (error instanceof OpenAiHttpError) throw billingRefusal(error.code, error.type) ? new Error(FCA_MODEL_BILLING) : error;
    if (!(error instanceof TypeError && !signal.aborted && (error as { cause?: { code?: unknown } }).cause?.code === 'ECONNREFUSED')) void options.recordUsage(unknown());
    throw error;
  }
  const counts = openAiCounts(object(answer)?.usage);
  const known = counts.complete;
  await options.recordUsage(known ? { model, usageComplete: true, inputTokens: counts.input, cachedInputTokens: counts.cached, cacheCreationInputTokens: counts.cacheWrite,
    outputTokens: counts.output, totalTokens: counts.input + counts.output, estimatedCostUsd: openAiCostUsd(model, counts) } : unknown());
  const response = object(answer);
  const output = Array.isArray(response?.output) ? response!.output : [];
  const text = output.flatMap(item => object(item)?.type === 'message' ? (Array.isArray(object(item)!.content) ? object(item)!.content as unknown[] : []) : [])
    .flatMap(part => object(part)?.type === 'output_text' && typeof object(part)!.text === 'string' ? [object(part)!.text as string] : []).join('').trim();
  if (response?.status !== 'completed' || !text) throw new Error(`MINECRAFT_${options.label.toUpperCase().replace(/\s+/gu, '_')}_INCOMPLETE`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('OPENAI_RESPONSE_NON_JSON'); }
  return prunedOptional(value, call.schema);
}
