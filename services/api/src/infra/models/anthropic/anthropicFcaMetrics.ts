import type Anthropic from '@anthropic-ai/sdk';
import type { ActionExecution } from '../../context/actionExecution.js';
import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import type { AnthropicFcaUsage } from './anthropicFcaModel.js';

/**
 * Observation redesign P1: what one decision's request weighed, for the journal's `fca_decision_metrics` line (written by the runner,
 * which also has the timings). Counts only: the replayed (stored) history and this turn's messages as token estimates
 * (`estimatedAnthropicTokens`, the same estimate the compaction uses), the provider's usage split into new input, cache reads and
 * cache writes, and how many ways the decision message was reduced before sending (parts left out as unchanged, plus a shortening).
 */
export function decisionRequestMetrics(history: readonly Anthropic.MessageParam[], turn: readonly Anthropic.MessageParam[], usage: AnthropicFcaUsage,
  built: { level: number | null; elidedParts: readonly string[] }): NonNullable<ActionExecution['modelMetrics']> {
  const read = usage.cachedInputTokens, write = usage.cacheCreationInputTokens;
  return { storedTokens: estimatedAnthropicTokens(history), tailTokens: estimatedAnthropicTokens(turn),
    inputNew: Math.max(0, usage.inputTokens - read - write), inputRead: read, inputWrite: write, outputTokens: usage.outputTokens,
    inputTransformations: built.elidedParts.length + (built.level === null ? 0 : 1) };
}
