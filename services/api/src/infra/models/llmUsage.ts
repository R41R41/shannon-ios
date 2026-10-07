import { serverEnvironment } from '../config/serverEnvironment.js';
/**
 * `memory` is response-path recall; `memory_background` shares the monthly background budget with `sleep`. `jev` is only a row
 * of the summary, counted from the decision traces (Syzygy ADR-0008 stage 1): `llm_usage_events` and its CHECK never hold it,
 * so the `voice` lane the transcription cap counts is untouched.
 */
export type LlmUsageLane = 'chat' | 'sleep' | 'voice' | 'memory' | 'memory_background' | 'jev';

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
  /** `jev` only: some calls have no price (`SHANNON_JEV_USD_PER_CALL` unset), so the cost is 未設定 and `estimatedCostUsd` is the known part. */
  costUnknown?: true;
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
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
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

/**
 * Assumed share of the input price that the provider charges for input read from its prompt cache, when
 * `SHANNON_LLM_CACHED_INPUT_USD_PER_MILLION` does not set the price itself (the GPT-5 family charges a tenth).
 */
export const CACHED_INPUT_PRICE_SHARE = 0.1;

/**
 * The cost of a call with the provider's discount for cached input applied, for reports that compare the two
 * (`reachConversation.ts`). Nothing that guards a budget uses it: `estimatedOpenAICostUsd` stays at the full price.
 */
export function estimatedOpenAICostWithCacheUsd(
  model: string,
  usage: ResponseUsage,
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): number {
  const full = estimatedOpenAICostUsd(model, { ...usage, inputTokens: 1_000_000, outputTokens: 0 }, environment);
  const cachedPrice = positiveNumber(environment.SHANNON_LLM_CACHED_INPUT_USD_PER_MILLION) ?? full * CACHED_INPUT_PRICE_SHARE;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  return roundUsd(estimatedOpenAICostUsd(model, { ...usage, inputTokens: usage.inputTokens - cached }, environment) + cached * cachedPrice / 1_000_000);
}

export function utcMonthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function configuredBackgroundBudgetUsd(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): number {
  const value = positiveNumber(environment.SHANNON_BACKGROUND_LLM_MONTHLY_BUDGET_USD);
  return value ?? 0.5;
}

/**
 * Review M4: the skill sleep's own monthly budget (USD, owner decision: 5), never the shared background budget's: its maintainer
 * and proposer calls are checked against it before each call, and their spend is kept apart (`shannon_skill_sleep_usage`).
 */
export function configuredSkillBudgetUsd(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): number {
  return positiveNumber(environment.SHANNON_SKILL_MONTHLY_BUDGET_USD) ?? 5;
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
