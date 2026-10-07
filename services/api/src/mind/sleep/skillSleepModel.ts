import { extractOutputText, parseJson, stableScopeIdentifier, validModel } from '../../infra/models/chatModelSupport.js';
import { estimatedOpenAICostUsd, responseUsage, type LlmUsageStore } from '../../infra/models/llmUsage.js';

/**
 * The model the skill sleep asks (Syzygy ADR-0008 stage 2, step 6): one structured answer per call, for the maintainer of the
 * pattern wiki and for the skill proposer. Core: memory. Usage is recorded on the background lane, inside its monthly budget.
 *
 * The proposer should be the strongest model there is (WikiSkill: skills written by a stronger model carry over to a weaker one,
 * and luna is the main model). `createConfiguredSkillSleepModels` is the one hook where Sonnet 5.5 is chosen: the wiring hands
 * `configuredSkillProposer` (`wiring/sonnetWiring.ts`), which is Sonnet whenever the Anthropic key is present (independent of
 * `SHANNON_SONNET_ROUTING`); without the key the proposer is terra, like the maintainer.
 */
export interface SkillSleepModel {
  readonly model: string;
  json(scopeKey: string, name: string, instructions: string, input: unknown, schema: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class OpenAISkillSleepModel implements SkillSleepModel {
  readonly model: string;

  constructor(private readonly options: { apiKey: string; model?: string; endpoint?: string; fetcher?: typeof fetch; usageStore?: LlmUsageStore; timeoutMilliseconds?: number }) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model ?? 'gpt-5.6-terra');
  }

  async json(scopeKey: string, name: string, instructions: string, input: unknown, schema: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await (this.options.fetcher ?? fetch)(this.options.endpoint ?? 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model, instructions, input: JSON.stringify(input),
        reasoning: { effort: 'low' },
        text: { verbosity: 'low', format: { type: 'json_schema', name, strict: true, schema } },
        max_output_tokens: 4_000, store: false,
        prompt_cache_key: stableScopeIdentifier(scopeKey), safety_identifier: stableScopeIdentifier(scopeKey),
      }),
      signal: AbortSignal.timeout(this.options.timeoutMilliseconds ?? 120_000),
    });
    const envelope = parseJson(await response.text());
    if (!response.ok) throw new Error(`OPENAI_SKILLS_${response.status}`);
    const usage = responseUsage(envelope);
    this.options.usageStore?.recordLlmUsage({
      scopeKey, lane: 'memory_background', model: this.model, ...usage, estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage), occurredAt: new Date().toISOString(),
    });
    return parseJson(extractOutputText(envelope));
  }
}

/**
 * The maintainer's and the proposer's models: with a model key and `SHANNON_KNOWLEDGE_ENABLED` not false. The maintainer is
 * `SHANNON_SKILL_MODEL` (else the knowledge model, else terra); the proposer `SHANNON_SKILL_PROPOSER_MODEL` (else the same). The
 * hook for Sonnet 5.5 (step 5): when the Anthropic adapter and its key are present, the proposer is Sonnet.
 */
export function createConfiguredSkillSleepModels(environment: Readonly<Record<string, string | undefined>>, usageStore?: LlmUsageStore,
  strongest?: () => SkillSleepModel | null): { maintainer: SkillSleepModel | null; proposer: SkillSleepModel | null } {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey || environment.SHANNON_KNOWLEDGE_ENABLED?.trim() === 'false') return { maintainer: null, proposer: strongest?.() ?? null };
  const model = environment.SHANNON_SKILL_MODEL?.trim() || environment.SHANNON_KNOWLEDGE_MODEL?.trim() || undefined;
  const maintainer = new OpenAISkillSleepModel({ apiKey, ...(model ? { model } : {}), ...(usageStore ? { usageStore } : {}) });
  const proposerModel = environment.SHANNON_SKILL_PROPOSER_MODEL?.trim() || model;
  const proposer = strongest?.() ?? new OpenAISkillSleepModel({ apiKey, ...(proposerModel ? { model: proposerModel } : {}), ...(usageStore ? { usageStore } : {}) });
  return { maintainer, proposer };
}
