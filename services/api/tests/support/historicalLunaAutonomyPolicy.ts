import type { AutonomyModelPrices, AutonomyModelUsage } from '../../src/mind/action/ownTime/autonomyModels.js';

type ModelPolicy = typeof import('../../src/mind/action/ownTime/autonomyModels.js');

/**
 * Historical byte proofs pin only the model policy that existed when their digests were recorded. The real loop, gate,
 * stores and feature wiring still run. Current native Haiku/cache/budget behavior is covered separately by autonomyHaiku.
 */
export function historicalLunaAutonomyPolicy(actual: ModelPolicy): ModelPolicy {
  const legacy = { id: 'gpt-5.6-luna', provider: 'openai' as const, label: 'GPT-5.6 Luna', purposes: ['research_reading', 'planning'] as const, usdPerMillion: null };
  const replacementId = actual.AUTONOMY_DEFAULT_MODEL.planning;
  return {
    ...actual,
    AUTONOMY_MODELS: actual.AUTONOMY_MODELS.map(model => model.provider === 'anthropic' ? legacy : model),
    AUTONOMY_DEFAULT_MODEL: { ...actual.AUTONOMY_DEFAULT_MODEL, research_reading: legacy.id, planning: legacy.id },
    autonomyModel: (id: unknown) => id === legacy.id ? legacy : actual.autonomyModel(id),
    autonomyInputTokensEstimate: (model: string, system: string, prompt: string) => model === legacy.id
      ? Math.ceil((system.length + prompt.length) * 1.5) + 64 : actual.autonomyInputTokensEstimate(model, system, prompt),
    autonomyModelCostUsd: (model: string, usage: AutonomyModelUsage, prices: AutonomyModelPrices = {}) => {
      if (model !== legacy.id) return actual.autonomyModelCostUsd(model, usage, prices);
      // Configuration parsing maps a stored Luna price key to its replacement. Retain that configured historical rate,
      // without native cache multipliers or the new stable prefix, for this explicit legacy profile only.
      const price = prices[legacy.id] ?? prices[replacementId] ?? { input: 0.2, output: 1.2 };
      return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
    },
  };
}
