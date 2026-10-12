import type Anthropic from '@anthropic-ai/sdk';
import type { LlmUsageLane, LlmUsageStore } from '../llmUsage.js';
import { usesOneHourAnthropicCache } from '../anthropic/haikuConfig.js';

/**
 * Claude's prices and the usage a request books (Syzygy ADR-0009 stage 1, M3; `docs/haiku-model-cache-contract.md`).
 *
 * Haiku 5.5 first-party pricing (2026-10-08), including its 100k prompt threshold and separate cache TTLs. The existing
 * Sonnet 5.5 uses its first-party 2026-10-08 prices; older Sonnet overrides retain their conservative estimates.
 * Web search is 10 USD per thousand searches; unknown models stay priced high. Previously recorded spend is not rewritten.
 */
export interface AnthropicPrices {
  input: number;
  output: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheRead: number;
  searchUsd: number;
}

const HAIKU_PRICES: AnthropicPrices = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, searchUsd: 0.01 };
const HAIKU_LONG_PRICES: AnthropicPrices = { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheWrite1h: 1, cacheRead: 0.05, searchUsd: 0.01 };
// Sonnet 5.5 and the older Sonnet 5 share the published rates: cache reads are 10% of input ($0.20; ADR-0009 stage 1, quick fix 3).
const SONNET_PRICES: AnthropicPrices = { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, searchUsd: 0.01 };
const UNKNOWN_PRICES: AnthropicPrices = { input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1, searchUsd: 0.01 };

export function anthropicPrices(model: string, inputTokens = 0): AnthropicPrices {
  if (model === 'claude-haiku-5-5') return { ...(inputTokens > 100_000 ? HAIKU_LONG_PRICES : HAIKU_PRICES) };
  if (model.startsWith('claude-sonnet-5')) return { ...SONNET_PRICES };
  return { ...UNKNOWN_PRICES };
}

export interface AnthropicUsageCounts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  searches: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

function writeCost(model: string, usage: AnthropicUsageCounts, price: AnthropicPrices): number {
  const detailed = usage.cacheWrite5m !== undefined && usage.cacheWrite1h !== undefined
    && usage.cacheWrite5m >= 0 && usage.cacheWrite1h >= 0 && usage.cacheWrite5m + usage.cacheWrite1h === usage.cacheWrite;
  if (detailed) return usage.cacheWrite5m! * price.cacheWrite + usage.cacheWrite1h! * price.cacheWrite1h;
  return usage.cacheWrite * (model === 'claude-haiku-5-5' || model === 'claude-sonnet-5-5' ? price.cacheWrite1h : price.cacheWrite);
}

export function estimatedAnthropicCostUsd(model: string, usage: AnthropicUsageCounts): number {
  const price = anthropicPrices(model, usage.input + usage.cacheWrite + usage.cacheRead);
  const tokens = usage.input * price.input + writeCost(model, usage, price) + usage.cacheRead * price.cacheRead + usage.output * price.output;
  const usd = tokens / 1_000_000 + usage.searches * price.searchUsd;
  return Math.round(usd * 1e9) / 1e9;
}

/** A count the provider reported as a safe, nonnegative integer. */
export function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function knownCount(value: unknown): number {
  return tokenCount(value) ? value : 0;
}

/** All four counts the one-hour cache contract requires are known. */
export function nativeUsageComplete(usage: Anthropic.Message['usage'] | null | undefined): boolean {
  return [usage?.input_tokens, usage?.output_tokens, usage?.cache_creation_input_tokens, usage?.cache_read_input_tokens].every(tokenCount);
}

/** The three input counts of a receipt, when all three were reported (a stream reports them at `message_start`). */
export interface KnownInput {
  input: number;
  cacheWrite: number;
  cacheRead: number;
}

export function knownInput(usage: Partial<Anthropic.Message['usage']> | null | undefined): KnownInput | null {
  const input = usage?.input_tokens;
  const cacheWrite = usage?.cache_creation_input_tokens;
  const cacheRead = usage?.cache_read_input_tokens;
  if (!tokenCount(input) || !tokenCount(cacheWrite) || !tokenCount(cacheRead)) return null;
  return Number.isSafeInteger(input + cacheWrite + cacheRead) ? { input, cacheWrite, cacheRead } : null;
}

/**
 * What a request whose bill is unknown may have cost: its whole output ceiling and every allowed search, and for the input the
 * counts the provider already reported (every write at the one-hour price), or, when none were reported, a full-context
 * one-hour write. A caller passes known input only for a request whose input cannot grow after it was counted (no server
 * tool: a web search adds its results to the input later in the same request).
 */
export function unknownCostUpperBound(model: string, maximumOutputTokens: number, searches = 0, input: KnownInput | null = null): number {
  if (!input) {
    const price = anthropicPrices(model, 1_000_000);
    return price.cacheWrite1h + maximumOutputTokens * price.output / 1_000_000 + searches * price.searchUsd;
  }
  const price = anthropicPrices(model, input.input + input.cacheWrite + input.cacheRead);
  const tokens = input.input * price.input + input.cacheWrite * price.cacheWrite1h + input.cacheRead * price.cacheRead
    + maximumOutputTokens * price.output;
  return Math.round((tokens / 1_000_000 + searches * price.searchUsd) * 1e9) / 1e9;
}

export interface ClaudeUsageRow {
  scopeKey: string;
  lane: LlmUsageLane;
  model: string;
  counts: AnthropicUsageCounts;
  estimatedCostUsd: number;
  /** Read only when a store takes the row. */
  at: () => string;
}

/** One usage row: input = uncached + cache write + cache read; cached = cache read. */
export function bookClaudeUsage(store: LlmUsageStore | undefined, row: ClaudeUsageRow): void {
  const { counts } = row;
  const input = counts.input + counts.cacheWrite + counts.cacheRead;
  store?.recordLlmUsage({
    scopeKey: row.scopeKey, lane: row.lane, model: row.model, inputTokens: input, cachedInputTokens: counts.cacheRead,
    outputTokens: counts.output, totalTokens: input + counts.output, estimatedCostUsd: row.estimatedCostUsd, occurredAt: row.at(),
  });
}

export interface ConversationUsage {
  scopeKey: string;
  model: string;
  usage: Anthropic.Message['usage'] | null | undefined;
  maximumOutputTokens: number;
  /** False for counts taken from a stream that never finished: lower bounds, not the bill. */
  finalUsage: boolean;
  /** The searches the request allowed: charged in full when the count is missing. */
  maximumSearches: number;
  at: () => string;
}

function searchCount(entry: ConversationUsage): number {
  const reported = entry.usage?.server_tool_use?.web_search_requests;
  if (!entry.finalUsage) return Math.max(entry.maximumSearches, knownCount(reported));
  return Number.isSafeInteger(reported) && reported! >= 0 ? reported! : entry.maximumSearches;
}

/** A conversation response's counts, each unknown count taken as zero. */
export function conversationCounts(entry: ConversationUsage): AnthropicUsageCounts {
  const usage = entry.usage;
  return {
    input: knownCount(usage?.input_tokens), cacheWrite: knownCount(usage?.cache_creation_input_tokens),
    cacheRead: knownCount(usage?.cache_read_input_tokens), output: knownCount(usage?.output_tokens), searches: searchCount(entry),
    cacheWrite5m: knownCount(usage?.cache_creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: knownCount(usage?.cache_creation?.ephemeral_1h_input_tokens),
  };
}

/**
 * The conversation lane's row (`chat`): the measured cost, and for a one-hour-cache model whose bill is not known (a stream
 * that never finished, or incomplete counts) at least the unknown-cost bound, so a malformed receipt cannot free budget.
 */
export function bookConversationUsage(store: LlmUsageStore | undefined, entry: ConversationUsage): void {
  const counts = conversationCounts(entry);
  const unknownBill = usesOneHourAnthropicCache(entry.model) && (!entry.finalUsage || !nativeUsageComplete(entry.usage));
  const input = entry.maximumSearches === 0 ? knownInput(entry.usage) : null;
  const bound = unknownBill ? unknownCostUpperBound(entry.model, entry.maximumOutputTokens, counts.searches, input) : 0;
  const estimatedCostUsd = Math.max(estimatedAnthropicCostUsd(entry.model, counts), bound);
  bookClaudeUsage(store, { scopeKey: entry.scopeKey, lane: 'chat', model: entry.model, counts, estimatedCostUsd, at: entry.at });
}
