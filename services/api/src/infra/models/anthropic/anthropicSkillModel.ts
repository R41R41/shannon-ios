import { backgroundModelAttempt, requireBackgroundUsage } from '../backgroundModelAttempt.js';
import { observedAnthropicResponse } from './observerProjection.js';
import type Anthropic from '@anthropic-ai/sdk';
import { parseJson } from '../chatModelSupport.js';
import type { LlmUsageStore } from '../llmUsage.js';
import { structuredSchema } from './anthropicRequest.js';
import { ambientClaudeClient } from '../claude/claudeClient.js';
import { sendClaudeOnce } from '../claude/claudeOnce.js';
import { bookClaudeUsage, estimatedAnthropicCostUsd } from '../claude/claudeUsage.js';

/**
 * Sonnet as the skill proposer of her sleep (Syzygy ADR-0008 stage 2, steps 5–6; `createConfiguredSkillSleepModels`, the
 * `strongest` hook). Core: memory (a sleep job). Used whenever the Anthropic key is present, independent of
 * `SHANNON_SONNET_ROUTING` (which is about conversation turns); otherwise the proposer stays terra.
 *
 * One structured answer per call (`output_config.format`, the schema in the supported subset), adaptive thinking at
 * `SHANNON_SKILL_PROPOSER_EFFORT` (`medium` by default), at most 4,000 output tokens, 60 s and no retry (review M4). Usage goes on the background lane (`memory_background`), inside the
 * monthly background budget, priced with cache reads (`estimatedAnthropicCostUsd`). A refusal or an empty answer throws, and the
 * consolidator treats it as any failed call.
 */
/** Review M4: what one call of the Sonnet proposer may take. */
export const SKILL_PROPOSER_LIMITS = Object.freeze({ maxTokens: 4_000, timeoutMilliseconds: 60_000 });

export class AnthropicSkillSleepModel {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: {
    apiKey: string; model: string; effort?: 'low' | 'medium' | 'high'; fetch?: typeof fetch; usageStore?: LlmUsageStore; timeoutMilliseconds?: number; now?: () => string;
  }) {
    if (!options.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY is required');
    this.model = options.model;
    const timeoutMilliseconds = options.timeoutMilliseconds ?? SKILL_PROPOSER_LIMITS.timeoutMilliseconds;
    this.client = ambientClaudeClient({ apiKey: options.apiKey, timeoutMilliseconds, fetch: options.fetch });
  }

  async json(scopeKey: string, _name: string, instructions: string, input: unknown, schema: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    return backgroundModelAttempt({ ...this.options, model: this.model, scopeKey, lane: 'memory_background', maxOutputTokens: 4000, signal }, async accounted => {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model, max_tokens: SKILL_PROPOSER_LIMITS.maxTokens,
      system: [{ type: 'text', text: instructions, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(input) }],
      thinking: { type: 'adaptive' },
      output_config: { effort: this.options.effort ?? 'medium', format: { type: 'json_schema', schema: structuredSchema(schema) as Record<string, unknown> } },
    };
    const message = await sendClaudeOnce({ body, message: value => value, dispatch: () => this.client.messages.create(body, signal ? { signal } : {}),
      span: { input: { purpose: 'skill_proposer', round: 0, streaming: false }, project: observedAnthropicResponse, model: this.model } });
    const usage = message.usage;
    const counts = { input: usage.input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? 0, searches: 0 };
    bookClaudeUsage(this.options.usageStore, { scopeKey, lane: 'memory_background', model: this.model, counts,
      estimatedCostUsd: estimatedAnthropicCostUsd(this.model, counts), at: () => this.options.now?.() ?? new Date().toISOString() });
    requireBackgroundUsage(usage, signal, true);
    accounted();
    signal?.throwIfAborted();
    if (message.stop_reason === 'refusal') throw new Error('ANTHROPIC_SKILLS_REFUSAL');
    const text = message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map(block => block.text).join('');
    const parsed = parseJson(text);
    if (parsed === null || parsed === undefined) throw new Error('ANTHROPIC_SKILLS_EMPTY');
    return parsed;
    });
  }
}
