import { estimatedOpenAICostUsd, type LlmUsageLane, type LlmUsageStore } from './llmUsage.js';
import { unknownCostUpperBound } from './claude/claudeUsage.js';
import { usesOneHourAnthropicCache } from './anthropic/haikuConfig.js';

/** Only the new FCA path rejects incomplete usage; known counts have already reached its existing ledger. */
export function requireBackgroundUsage(usage: unknown, signal?: AbortSignal, native = false): void {
  if (!signal) return;
  const row = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (!count(row.input_tokens) || !count(row.output_tokens) || row.usage_complete === false
    || (native && (!count(row.cache_creation_input_tokens) || !count(row.cache_read_input_tokens)))) {
    throw new Error('BACKGROUND_MODEL_USAGE_UNKNOWN');
  }
}

/** FCA-only accounting around existing one-call adapters. Legacy calls without a parent signal remain unchanged. */
export async function backgroundModelAttempt<T>(options: {
  model: string; scopeKey: string; lane: LlmUsageLane; maxOutputTokens: number;
  usageStore?: LlmUsageStore; signal?: AbortSignal; now?: () => string;
}, run: (accounted: () => void) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted();
  let recorded = false;
  try { return await run(() => { recorded = true; }); }
  catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    if (options.signal && !recorded && !(status >= 400 && status < 500)) {
      // A lost request has no trustworthy token count. Same full-context upper bound as the native FCA adapter.
      const estimatedCostUsd = usesOneHourAnthropicCache(options.model) ? unknownCostUpperBound(options.model, options.maxOutputTokens)
        : estimatedOpenAICostUsd(options.model, { inputTokens: 1_000_000, cachedInputTokens: 0,
          outputTokens: options.maxOutputTokens, totalTokens: 1_000_000 + options.maxOutputTokens });
      options.usageStore?.recordLlmUsage({ scopeKey: options.scopeKey, lane: options.lane, model: options.model,
        inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd,
        occurredAt: options.now?.() ?? new Date().toISOString() });
    }
    throw error;
  }
}
