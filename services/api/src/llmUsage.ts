/** `memory` is response-path recall; `memory_background` shares the monthly background budget with `sleep`. */
export type LlmUsageLane = 'chat' | 'sleep' | 'voice' | 'memory' | 'memory_background';

export interface LlmUsageEvent {
  scopeKey: string;
  lane: LlmUsageLane;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  occurredAt: string;
}

export interface LlmUsageStore {
  recordLlmUsage(event: LlmUsageEvent): void;
  backgroundLlmCostUsd(monthKey: string): number;
  voiceLlmCostUsdForDay?(scopeKey: string, dayKey: string): number;
}

export interface LlmUsageSummaryRow {
  lane: LlmUsageLane;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface LlmUsageReader {
  llmUsageSummary(scopeKey: string, monthKey: string): readonly LlmUsageSummaryRow[];
  backgroundLlmCostUsd(monthKey: string): number;
  backgroundLlmCostUsdForDay?(dayKey: string): number;
}

export interface ResponseUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function responseUsage(value: unknown): ResponseUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyUsage();
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return emptyUsage();
  const row = usage as Record<string, unknown>;
  const inputDetails = object(row.input_tokens_details);
  const inputTokens = integer(row.input_tokens);
  const outputTokens = integer(row.output_tokens);
  return Object.freeze({
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, integer(inputDetails?.cached_tokens)),
    outputTokens,
    totalTokens: integer(row.total_tokens) || inputTokens + outputTokens,
  });
}

export function estimatedOpenAICostUsd(
  model: string,
  usage: ResponseUsage,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configuredInput = positiveNumber(environment.SHANNON_LLM_INPUT_USD_PER_MILLION);
  const configuredOutput = positiveNumber(environment.SHANNON_LLM_OUTPUT_USD_PER_MILLION);
  const prices = configuredInput !== null && configuredOutput !== null
    ? { input: configuredInput, output: configuredOutput }
    : modelPrices(model);
  // Cached input is intentionally charged at the full input price here. This
  // makes the local budget breaker conservative if provider discounts change.
  return roundUsd((usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000);
}

export function utcMonthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function configuredBackgroundBudgetUsd(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = positiveNumber(environment.SHANNON_BACKGROUND_LLM_MONTHLY_BUDGET_USD);
  return value ?? 0.5;
}

function modelPrices(model: string): { input: number; output: number } {
  if (model.startsWith('gpt-5.6-luna')) return { input: 0.2, output: 1.2 };
  if (model.startsWith('text-embedding-3-small')) return { input: 0.02, output: 0 };
  if (model.startsWith('text-embedding-3-large')) return { input: 0.13, output: 0 };
  if (model.startsWith('gpt-5.6-terra')) return { input: 2, output: 12 };
  if (model.startsWith('gpt-5.6-sol')) return { input: 4, output: 20 };
  // Fail-safe estimate for unknown future models; deliberately not optimistic.
  return { input: 5, output: 30 };
}

function emptyUsage(): ResponseUsage {
  return Object.freeze({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function positiveNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
