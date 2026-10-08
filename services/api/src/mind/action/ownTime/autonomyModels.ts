import { estimatedOpenAICostUsd } from '../../../infra/models/llmUsage.js';
import { serverEnvironment } from '../../../infra/config/serverEnvironment.js';
import { estimatedAnthropicCostUsd } from '../../../infra/models/anthropic/anthropicConfig.js';
import { DEFAULT_HAIKU_MODEL, replacementModel } from '../../../infra/models/anthropic/haikuConfig.js';
import { HAIKU_PROTOCOL_PREFIX } from '../../../infra/models/anthropic/haikuCache.js';

/**
 * The models Shannon may choose for her own activity, per purpose (Syzygy ADR-0002).
 *
 * She picks; the owner recommends Gemini for Japanese prose (not evaluated in the ADR).
 * A model outside this registry has no known price, so the policy gate refuses to pay
 * for it. No model is called from this file.
 */
export type AutonomyModelPurpose = 'prose' | 'research_reading' | 'planning' | 'critique';

export const AUTONOMY_MODEL_PURPOSES: readonly { id: AutonomyModelPurpose; label: string }[] = Object.freeze([
  { id: 'prose', label: '日本語の文章' },
  { id: 'research_reading', label: '調べものを読む' },
  { id: 'planning', label: '計画を立てる' },
  { id: 'critique', label: '読み返して直す' },
]);

export interface AutonomyModel {
  id: string;
  provider: 'google' | 'openai' | 'anthropic';
  label: string;
  purposes: readonly AutonomyModelPurpose[];
  /**
   * USD per million tokens. `null` means the price is not recorded here: OpenAI ids use
   * the existing table in `llmUsage.ts`, Anthropic uses native cache pricing, and any other id is charged at the fail-safe
   * rate below until the owner sets it in `SHANNON_AUTONOMY_MODEL_PRICES_JSON`.
   */
  usdPerMillion: { input: number; output: number } | null;
}

/** Deliberately not optimistic, same as the unknown-model estimate in `llmUsage.ts`. */
export const AUTONOMY_FAIL_SAFE_USD_PER_MILLION = Object.freeze({ input: 5, output: 30 });

export const AUTONOMY_MODELS: readonly AutonomyModel[] = Object.freeze([
  { id: 'gemini-3.8-flash', provider: 'google', label: 'Gemini 3.8 Flash', purposes: ['prose', 'research_reading', 'planning', 'critique'], usdPerMillion: null },
  { id: DEFAULT_HAIKU_MODEL, provider: 'anthropic', label: 'Claude Haiku 5.5', purposes: ['research_reading', 'planning'], usdPerMillion: null },
  { id: 'gpt-5.6-terra', provider: 'openai', label: 'GPT-5.6 Terra', purposes: ['prose', 'planning', 'critique'], usdPerMillion: null },
  { id: 'gpt-5.6-sol', provider: 'openai', label: 'GPT-5.6 Sol', purposes: ['prose', 'critique'], usdPerMillion: null },
]);

/** Used until she stores a preference of her own. Prose follows the owner's recommendation. */
export const AUTONOMY_DEFAULT_MODEL: Readonly<Record<AutonomyModelPurpose, string>> = Object.freeze({
  prose: 'gemini-3.8-flash',
  research_reading: DEFAULT_HAIKU_MODEL,
  planning: DEFAULT_HAIKU_MODEL,
  critique: 'gpt-5.6-terra',
});

/**
 * The model that is shown the one frame of a look she takes in her own time. Fixed, because it
 * must accept an image and be reachable with the dedicated key; the API process calls it, and
 * the gate prices it like any step.
 */
export const AUTONOMY_ROOM_LOOK_MODEL = 'gemini-3.8-flash';
/** What the gate is asked to make room for: one frame of at most 960 by 1,920 pixels, and every output token the call may use (reasoning included). */
export const AUTONOMY_ROOM_LOOK_TOKENS = Object.freeze({ frame: 2_000, output: 1_000 });

export const AUTONOMY_MODEL_RECOMMENDATION: Readonly<Partial<Record<AutonomyModelPurpose, string>>> = Object.freeze({
  prose: '日本語の文章にはGeminiを勧める、というのが持ち主の推奨です（品質は未検証）。',
});

export function isAutonomyModelPurpose(value: unknown): value is AutonomyModelPurpose {
  return AUTONOMY_MODEL_PURPOSES.some(purpose => purpose.id === value);
}

export function autonomyModel(id: unknown): AutonomyModel | null {
  // Resolve old preferences at use time. The stored choice, its reason and date remain intact.
  return typeof id === 'string' && id.trim() ? AUTONOMY_MODELS.find(model => model.id === replacementModel(id)) ?? null : null;
}

export function autonomyModelAllowedFor(id: unknown, purpose: AutonomyModelPurpose): boolean {
  return autonomyModel(id)?.purposes.includes(purpose) ?? false;
}

export type AutonomyModelPrices = Readonly<Record<string, { input: number; output: number }>>;

/** Owner-configured prices: `{"gemini-3.8-flash":{"input":0.3,"output":2.5}}` (USD per million tokens). */
export function configuredAutonomyModelPrices(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): AutonomyModelPrices {
  const raw = environment.SHANNON_AUTONOMY_MODEL_PRICES_JSON?.trim();
  if (!raw) return Object.freeze({});
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze({});
    const prices: Record<string, { input: number; output: number }> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const model = autonomyModel(id);
      if (!model || !value || typeof value !== 'object') continue;
      const { input, output } = value as { input?: unknown; output?: unknown };
      // An explicit current-model price wins over a retained old Luna setting, in either JSON order.
      if (validPrice(input) && validPrice(output) && (id === model.id || !prices[model.id])) prices[model.id] = { input, output };
    }
    return Object.freeze(prices);
  } catch {
    return Object.freeze({});
  }
}

/** Total input includes ordinary input, cache creation and cache reads; output includes thinking. */
export interface AutonomyModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Present, even when zero, only when Anthropic reported the cache accounting for a closed call. */
  cacheCreationInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
}

/** Japanese is estimated high; include the native cache protocol actually added to every Haiku request. */
export function autonomyInputTokensEstimate(modelId: string, system: string, prompt: string): number {
  const prefix = autonomyModel(modelId)?.provider === 'anthropic' ? HAIKU_PROTOCOL_PREFIX.length : 0;
  return Math.ceil((system.length + prompt.length + prefix) * 1.5) + 64;
}

/**
 * Cost of a call, or null outside the registry. A Haiku estimate without reported cache creation reserves every input
 * token at the worst 1-hour write rate. A closed response charges its ordinary, creation and read tokens separately.
 * Existing Google/OpenAI cache accounting keeps its conservative full input rate.
 */
export function autonomyModelCostUsd(
  modelId: string,
  usage: AutonomyModelUsage,
  prices: AutonomyModelPrices = {},
): number | null {
  const model = autonomyModel(modelId);
  if (!model) return null;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const configured = prices[model.id] ?? prices[modelId] ?? model.usdPerMillion;
  if (model.provider === 'anthropic') {
    const reported = usage.cacheCreationInputTokens !== undefined;
    const cacheWrite = reported ? tokenCount(usage.cacheCreationInputTokens!) : inputTokens;
    const cacheRead = reported ? tokenCount(usage.cachedInputTokens ?? 0) : 0;
    // An inconsistent caller must never discount ordinary input or use a cheaper context tier.
    const totalInput = Math.max(inputTokens, cacheWrite + cacheRead);
    const ordinaryInput = totalInput - cacheWrite - cacheRead;
    const five = tokenCount(usage.cacheCreation5mInputTokens ?? 0);
    const hour = tokenCount(usage.cacheCreation1hInputTokens ?? 0);
    const knownTtl = reported && usage.cacheCreation5mInputTokens !== undefined && usage.cacheCreation1hInputTokens !== undefined && five + hour === cacheWrite;
    if (configured) {
      const tier = totalInput > 100_000 ? 5 : 1;
      const written = knownTtl ? 1.25 * five + 2 * hour : 2 * cacheWrite;
      return ((ordinaryInput + written + 0.1 * cacheRead) * configured.input + outputTokens * configured.output) * tier / 1_000_000;
    }
    return estimatedAnthropicCostUsd(model.id, { input: ordinaryInput, cacheWrite, cacheRead, output: outputTokens, searches: 0,
      ...(knownTtl ? { cacheWrite5m: five, cacheWrite1h: hour } : {}),
    });
  }
  if (configured) return (inputTokens * configured.input + outputTokens * configured.output) / 1_000_000;
  if (model.provider === 'openai') {
    return estimatedOpenAICostUsd(model.id, {
      inputTokens, outputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens,
    }, {});
  }
  return (inputTokens * AUTONOMY_FAIL_SAFE_USD_PER_MILLION.input + outputTokens * AUTONOMY_FAIL_SAFE_USD_PER_MILLION.output) / 1_000_000;
}

export interface AutonomyModelChoice {
  purpose: AutonomyModelPurpose;
  purposeLabel: string;
  modelId: string;
  modelLabel: string;
  /** Whether she chose it or it is the default. */
  chosenBy: 'shannon' | 'default';
  reason?: string;
  recommendation?: string;
  updatedAt?: string;
}

export function autonomyModelChoices(
  preferences: readonly { purpose: string; modelId: string; reason: string; updatedAt: string }[],
): readonly AutonomyModelChoice[] {
  return AUTONOMY_MODEL_PURPOSES.map(purpose => {
    const preference = preferences.find(item => item.purpose === purpose.id && autonomyModelAllowedFor(item.modelId, purpose.id));
    const model = autonomyModel(preference?.modelId ?? AUTONOMY_DEFAULT_MODEL[purpose.id])!;
    const recommendation = AUTONOMY_MODEL_RECOMMENDATION[purpose.id];
    return Object.freeze({
      purpose: purpose.id,
      purposeLabel: purpose.label,
      modelId: model.id,
      modelLabel: model.label,
      chosenBy: preference ? 'shannon' as const : 'default' as const,
      ...(preference ? { reason: preference.reason, updatedAt: preference.updatedAt } : {}),
      ...(recommendation ? { recommendation } : {}),
    });
  });
}

function validPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000;
}

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
