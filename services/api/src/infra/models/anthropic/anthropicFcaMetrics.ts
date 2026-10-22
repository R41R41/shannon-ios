import type Anthropic from '@anthropic-ai/sdk';
import type { ActionExecution } from '../../context/actionExecution.js';
import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import type { AnthropicFcaUsage } from './anthropicFcaModel.js';
import { isFcaClearAtMessage } from './anthropicFcaTransient.js';

type Metrics = NonNullable<ActionExecution['modelMetrics']>;
/**
 * Observation redesign P1: what one decision's request weighed, for the journal's `fca_decision_metrics` line (written by the runner,
 * which also has the timings). Counts only: the replayed (stored) history and this turn's messages as token estimates
 * (`estimatedAnthropicTokens`, the same estimate the compaction uses), the provider's usage split into new input, cache reads and
 * cache writes, and how many ways the decision message was reduced before sending (parts left out as unchanged, plus a shortening).
 */
export function decisionRequestMetrics(history: readonly Anthropic.MessageParam[], turn: readonly Anthropic.MessageParam[], usage: AnthropicFcaUsage,
  built: { level: number | null; elidedParts: readonly string[] },
  transient?: { providerTransformations: number; cuts?: Metrics['cuts'] }): Metrics {
  const read = usage.cachedInputTokens, write = usage.cacheCreationInputTokens;
  // mb-llmc r8: the live state is the only part of a transient request after the last cache breakpoint (a turn-scoped system message may
  // carry no marker); its estimate beside `inputNew` says how much of the input that is not cached is that state.
  const live = transient ? turn.find(isFcaClearAtMessage) : undefined;
  // A turn-scoped system message that a later message follows is stored but never rendered: not part of the stored tokens.
  return { storedTokens: estimatedAnthropicTokens(history.filter(message => !isFcaClearAtMessage(message))), tailTokens: estimatedAnthropicTokens(turn),
    inputNew: Math.max(0, usage.inputTokens - read - write), inputRead: read, inputWrite: write, outputTokens: usage.outputTokens,
    inputTransformations: built.elidedParts.length + (built.level === null ? 0 : 1) + (transient?.providerTransformations ?? 0),
    ...(live ? { liveTokens: estimatedAnthropicTokens([live]) } : {}),
    ...(transient ? { obsMode: 'transient' as const } : {}), ...(transient?.cuts ? { cuts: transient.cuts } : {}) };
}
