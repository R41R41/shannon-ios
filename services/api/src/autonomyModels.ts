import { estimatedOpenAICostUsd, type ResponseUsage } from './llmUsage.js';

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
  provider: 'google' | 'openai';
  label: string;
  purposes: readonly AutonomyModelPurpose[];
  /**
   * USD per million tokens. `null` means the price is not recorded here: OpenAI ids use
   * the existing table in `llmUsage.ts`, and any other id is charged at the fail-safe
   * rate below until the owner sets it in `SHANNON_AUTONOMY_MODEL_PRICES_JSON`.
   */
  usdPerMillion: { input: number; output: number } | null;
}

/** Deliberately not optimistic, same as the unknown-model estimate in `llmUsage.ts`. */
export const AUTONOMY_FAIL_SAFE_USD_PER_MILLION = Object.freeze({ input: 5, output: 30 });

export const AUTONOMY_MODELS: readonly AutonomyModel[] = Object.freeze([
  { id: 'gemini-3.8-flash', provider: 'google', label: 'Gemini 3.8 Flash', purposes: ['prose', 'research_reading', 'critique'], usdPerMillion: null },
  { id: 'gpt-5.6-luna', provider: 'openai', label: 'GPT-5.6 Luna', purposes: ['research_reading', 'planning'], usdPerMillion: null },
  { id: 'gpt-5.6-terra', provider: 'openai', label: 'GPT-5.6 Terra', purposes: ['prose', 'planning', 'critique'], usdPerMillion: null },
  { id: 'gpt-5.6-sol', provider: 'openai', label: 'GPT-5.6 Sol', purposes: ['prose', 'critique'], usdPerMillion: null },
]);

/** Used until she stores a preference of her own. Prose follows the owner's recommendation. */
export const AUTONOMY_DEFAULT_MODEL: Readonly<Record<AutonomyModelPurpose, string>> = Object.freeze({
  prose: 'gemini-3.8-flash',
  research_reading: 'gpt-5.6-luna',
  planning: 'gpt-5.6-luna',
  critique: 'gpt-5.6-terra',
});

export const AUTONOMY_MODEL_RECOMMENDATION: Readonly<Partial<Record<AutonomyModelPurpose, string>>> = Object.freeze({
  prose: '日本語の文章にはGeminiを勧める、というのが持ち主の推奨です（品質は未検証）。',
});

export function isAutonomyModelPurpose(value: unknown): value is AutonomyModelPurpose {
  return AUTONOMY_MODEL_PURPOSES.some(purpose => purpose.id === value);
}

export function autonomyModel(id: unknown): AutonomyModel | null {
  return AUTONOMY_MODELS.find(model => model.id === id) ?? null;
}

export function autonomyModelAllowedFor(id: unknown, purpose: AutonomyModelPurpose): boolean {
  return autonomyModel(id)?.purposes.includes(purpose) ?? false;
}

export type AutonomyModelPrices = Readonly<Record<string, { input: number; output: number }>>;

/** Owner-configured prices: `{"gemini-3.8-flash":{"input":0.3,"output":2.5}}` (USD per million tokens). */
export function configuredAutonomyModelPrices(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AutonomyModelPrices {
  const raw = environment.SHANNON_AUTONOMY_MODEL_PRICES_JSON?.trim();
  if (!raw) return Object.freeze({});
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze({});
    const prices: Record<string, { input: number; output: number }> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!autonomyModel(id) || !value || typeof value !== 'object') continue;
      const { input, output } = value as { input?: unknown; output?: unknown };
      if (validPrice(input) && validPrice(output)) prices[id] = { input, output };
    }
    return Object.freeze(prices);
  } catch {
    return Object.freeze({});
  }
}

/**
 * Estimated cost of one call in USD, or null for a model outside the registry.
 * Cached input is charged at the full input price, as in `estimatedOpenAICostUsd`.
 */
export function autonomyModelCostUsd(
  modelId: string,
  usage: Pick<ResponseUsage, 'inputTokens' | 'outputTokens'>,
  prices: AutonomyModelPrices = {},
): number | null {
  const model = autonomyModel(modelId);
  if (!model) return null;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const configured = prices[model.id] ?? model.usdPerMillion;
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
