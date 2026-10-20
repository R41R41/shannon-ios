import { skillRoutingSwitches } from '@shannon/learning';
import { anthropicApiKey, sonnetRoutingAvailable, sonnetSettings } from '../infra/models/anthropic/anthropicConfig.js';
import { AnthropicChatModel } from '../infra/models/anthropic/anthropicChatModel.js';
import { AnthropicSkillSleepModel } from '../infra/models/anthropic/anthropicSkillModel.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { TieredChatModel } from '../infra/models/tieredChatModel.js';
export { closeReplySonnet, withReplySonnet } from './replySonnetWiring.js';

/**
 * Wiring of the Sonnet tier (Syzygy ADR-0008 stage 2, step 5; owner answers I-1, I-2, I-6). Null unless the Anthropic key is
 * present **and** `SHANNON_SONNET_ROUTING=on` (default off) **and** stage 2's difficulty is on: then the kernel's chat model is
 * luna itself, exactly as before, and the policy serves `sonnet` as `luna_plus`. With it, the kernel's model is the tiered one
 * and the turn routing reads Sonnet's availability and its measured first-token latency from it.
 */
export function configuredSonnet(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { usageStore?: LlmUsageStore; now?: () => string; fetch?: typeof fetch; webSearch?: import('../infra/models/webSearch.js').WebSearchOperation },
): AnthropicChatModel | null {
  const apiKey = anthropicApiKey(environment);
  if (!apiKey || !sonnetRoutingAvailable(environment)) return null;
  return new AnthropicChatModel({
    apiKey, settings: sonnetSettings(environment), agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac',
    ...(parts.webSearch ? { webSearch: parts.webSearch } : {}),
    ...(parts.usageStore ? { usageStore: parts.usageStore } : {}), ...(parts.now ? { now: parts.now } : {}), ...(parts.fetch ? { fetch: parts.fetch } : {}),
  });
}

/** The kernel's chat model: luna, or the tiered model when Sonnet is configured. */
export function tieredChatModel(luna: ShannonChatModel, sonnet: AnthropicChatModel | null): ShannonChatModel {
  return sonnet ? new TieredChatModel(luna, sonnet) : luna;
}

/**
 * The skill proposer of her sleep on Sonnet (the `strongest` hook of `createConfiguredSkillSleepModels`): whenever the Anthropic key
 * is present, independent of `SHANNON_SONNET_ROUTING` (a sleep job, not a conversation turn). Null without the key: terra proposes.
 */
export function configuredSkillProposer(
  environment: Readonly<Record<string, string | undefined>>, parts: { usageStore?: LlmUsageStore; fetch?: typeof fetch },
): AnthropicSkillSleepModel | null {
  const apiKey = anthropicApiKey(environment);
  // Review M4: only while her skills are on (stage 2 and `SHANNON_SKILLS`).
  if (!apiKey || !skillRoutingSwitches(environment).skills) return null;
  const effort = environment.SHANNON_SKILL_PROPOSER_EFFORT?.trim().toLowerCase();
  return new AnthropicSkillSleepModel({
    apiKey, model: sonnetSettings(environment).model, effort: effort === 'low' || effort === 'high' ? effort : 'medium',
    ...(parts.usageStore ? { usageStore: parts.usageStore } : {}), ...(parts.fetch ? { fetch: parts.fetch } : {}),
  });
}
