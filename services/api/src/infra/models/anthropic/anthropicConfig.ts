import { skillRoutingSwitches } from '@shannon/learning';
import { serverEnvironment } from '../../config/serverEnvironment.js';

/**
 * The Sonnet tier's settings (Syzygy ADR-0008 stage 2, step 5; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * Read from the environment it is handed, never printed:
 * - the key: `SHANNON_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY`;
 * - the model: `SHANNON_SONNET_MODEL` (default `claude-sonnet-5-5`);
 * - effort: `SHANNON_SONNET_EFFORT` (`low` default; `low` | `medium` | `high`);
 * - thinking on text: `SHANNON_SONNET_TEXT_THINKING` (`adaptive` default, or `between_tools`); on voice:
 *   `SHANNON_SONNET_VOICE_THINKING` (`between_tools` default, or `adaptive`). `between_tools` is accepted at effort `high`
 *   or below only, which is all this setting allows.
 *
 * Routing (owner answers I-1 and I-2): the `sonnet` tier is served only while the key is present **and**
 * `SHANNON_SONNET_ROUTING=on` (default off) and the difficulty policy is on (`skillRoutingSwitches`).
 */
export type SonnetEffort = 'low' | 'medium' | 'high';
export type SonnetThinking = 'adaptive' | 'between_tools';

export interface SonnetSettings {
  model: string;
  effort: SonnetEffort;
  textThinking: SonnetThinking;
  voiceThinking: SonnetThinking;
}

export const DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';

type Environment = Readonly<Record<string, string | undefined>>;

export function anthropicApiKey(environment: Environment = serverEnvironment()): string | null {
  return environment.SHANNON_ANTHROPIC_API_KEY?.trim() || environment.ANTHROPIC_API_KEY?.trim() || null;
}

export function sonnetSettings(environment: Environment = serverEnvironment()): SonnetSettings {
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
    const text = value?.trim().toLowerCase();
    return text && (allowed as readonly string[]).includes(text) ? text as T : fallback;
  };
  return Object.freeze({
    model: environment.SHANNON_SONNET_MODEL?.trim() || DEFAULT_SONNET_MODEL,
    effort: pick(environment.SHANNON_SONNET_EFFORT, ['low', 'medium', 'high'] as const, 'low'),
    textThinking: pick(environment.SHANNON_SONNET_TEXT_THINKING, ['adaptive', 'between_tools'] as const, 'adaptive'),
    voiceThinking: pick(environment.SHANNON_SONNET_VOICE_THINKING, ['adaptive', 'between_tools'] as const, 'between_tools'),
  });
}

/** Whether the `sonnet` tier may leave for Anthropic: the key, `SHANNON_SONNET_ROUTING=on`, and stage 2's difficulty on. */
export function sonnetRoutingAvailable(environment: Environment = serverEnvironment()): boolean {
  return anthropicApiKey(environment) !== null && skillRoutingSwitches(environment).sonnetRouting;
}

/**
 * Haiku 5.5 first-party pricing (2026-10-08), including its 100k prompt threshold and separate cache TTLs. The existing
 * Sonnet 5.5 uses its first-party 2026-10-08 prices; older Sonnet overrides retain their conservative estimates.
 * Web search is 10 USD per thousand searches; unknown models stay priced high. Previously recorded spend is not rewritten.
 */
export function anthropicPrices(model: string, inputTokens = 0): { input: number; output: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number; searchUsd: number } {
  if (model === 'claude-haiku-5-5') return inputTokens > 100_000
    ? { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheWrite1h: 1, cacheRead: 0.05, searchUsd: 0.01 }
    : { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, searchUsd: 0.01 };
  // Sonnet 5.5 and the older Sonnet 5 share the published rates: cache reads are 10% of input ($0.20; ADR-0009 stage 1, quick fix 3).
  if (model.startsWith('claude-sonnet-5')) return { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, searchUsd: 0.01 };
  return { input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1, searchUsd: 0.01 };
}

export interface AnthropicUsageCounts {
  input: number; cacheWrite: number; cacheRead: number; output: number; searches: number;
  cacheWrite5m?: number; cacheWrite1h?: number;
}

export function estimatedAnthropicCostUsd(model: string, usage: AnthropicUsageCounts): number {
  const price = anthropicPrices(model, usage.input + usage.cacheWrite + usage.cacheRead);
  const detailed = usage.cacheWrite5m !== undefined && usage.cacheWrite1h !== undefined
    && usage.cacheWrite5m >= 0 && usage.cacheWrite1h >= 0 && usage.cacheWrite5m + usage.cacheWrite1h === usage.cacheWrite;
  const writeCost = detailed ? usage.cacheWrite5m! * price.cacheWrite + usage.cacheWrite1h! * price.cacheWrite1h
    : usage.cacheWrite * (model === 'claude-haiku-5-5' || model === 'claude-sonnet-5-5' ? price.cacheWrite1h : price.cacheWrite);
  const usd = (usage.input * price.input + writeCost + usage.cacheRead * price.cacheRead + usage.output * price.output) / 1_000_000
    + usage.searches * price.searchUsd;
  return Math.round(usd * 1e9) / 1e9;
}
