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
 * Anthropic's first-party prices per million tokens for the Sonnet tier (cached 2026-09-25): input 2, output 10, cache write
 * 1.25 × input, cache read 0.20; web search 10 USD per thousand searches. An unknown model is priced high on purpose.
 */
export function anthropicPrices(model: string): { input: number; output: number; cacheWrite: number; cacheRead: number; searchUsd: number } {
  if (model.startsWith('claude-sonnet-5')) return { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2, searchUsd: 0.01 };
  return { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1, searchUsd: 0.01 };
}

export interface AnthropicUsageCounts { input: number; cacheWrite: number; cacheRead: number; output: number; searches: number }

export function estimatedAnthropicCostUsd(model: string, usage: AnthropicUsageCounts): number {
  const price = anthropicPrices(model);
  const usd = (usage.input * price.input + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead + usage.output * price.output) / 1_000_000
    + usage.searches * price.searchUsd;
  return Math.round(usd * 1e9) / 1e9;
}
