import { backgroundModelAttempt, requireBackgroundUsage } from '../../infra/models/backgroundModelAttempt.js';
import { configuredResponseModel } from '../../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured, type ClaudeBackground } from '../../infra/models/claude/claudeStructured.js';
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
  json(scopeKey: string, name: string, instructions: string, input: unknown, schema: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
}

export class OpenAISkillSleepModel implements SkillSleepModel {
  readonly model: string;
  private readonly fetcher: typeof fetch;
  /** The background route of a Claude model (`claudeStructured.ts`); null keeps the OpenAI Responses request. */
  private readonly claude: ClaudeBackground | null;

  constructor(private readonly options: { apiKey: string; model?: string; endpoint?: string; fetcher?: typeof fetch; usageStore?: LlmUsageStore; timeoutMilliseconds?: number }) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model ?? 'gpt-5.6-terra');
    this.claude = claudeBackground(this.model, options);
    this.fetcher = options.fetcher ?? fetch;
  }

  async json(scopeKey: string, name: string, instructions: string, input: unknown, schema: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    return backgroundModelAttempt({ ...this.options, model: this.model, scopeKey, lane: 'memory_background', maxOutputTokens: 4000, signal }, async accounted => {
    const timeout = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMilliseconds ?? 120_000), ...(signal ? [signal] : [])]);
    if (this.claude) return this.claudeJson({ claude: this.claude, scopeKey, instructions, input, schema, signal, timeout, accounted });
    const response = await this.fetcher(this.options.endpoint ?? 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model, instructions, input: JSON.stringify(input),
        reasoning: { effort: 'low' },
        text: { verbosity: 'low', format: { type: 'json_schema', name, strict: true, schema } },
        max_output_tokens: 4_000, store: false,
        prompt_cache_key: stableScopeIdentifier(scopeKey), safety_identifier: stableScopeIdentifier(scopeKey),
      }),
      signal: timeout,
    });
    const envelope = parseJson(await response.text());
    if (!response.ok) throw Object.assign(new Error(`OPENAI_SKILLS_${response.status}`), { status: response.status });
    const usage = responseUsage(envelope);
    this.options.usageStore?.recordLlmUsage({
      scopeKey, lane: 'memory_background', model: this.model, ...usage, estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage), occurredAt: new Date().toISOString(),
    });
    if (usage.unknownCostUpperBoundUsd) accounted();
    requireBackgroundUsage((envelope as { usage?: unknown })?.usage, signal);
    accounted();
    signal?.throwIfAborted();
    return parseJson(extractOutputText(envelope));
    });
  }

  private async claudeJson(call: { claude: ClaudeBackground; scopeKey: string; instructions: string; input: unknown;
    schema: Readonly<Record<string, unknown>>; signal?: AbortSignal; timeout: AbortSignal; accounted: () => void }): Promise<unknown> {
    const answer = await completeStructured<string>('skill_sleep', call.instructions, JSON.stringify(call.input), call.schema, {
      claude: call.claude, scopeKey: call.scopeKey, maximumOutputTokens: 4_000, effort: 'low', signal: call.timeout,
      onBooked: call.accounted, requireUsage: Boolean(call.signal), read: text => text,
    });
    if (!answer.ok) throw Object.assign(new Error(`OPENAI_SKILLS_${answer.status}`), { status: answer.status });
    call.signal?.throwIfAborted();
    return parseJson(answer.value);
  }
}

/**
 * The maintainer's and the proposer's models: only with a model key and `SHANNON_KNOWLEDGE_ENABLED` not false (else neither). The maintainer is
 * `SHANNON_SKILL_MODEL` (else the knowledge model, else terra); the proposer `SHANNON_SKILL_PROPOSER_MODEL` (else the same). The
 * hook for Sonnet 5.5 (step 5): when the Anthropic adapter and its key are present, the proposer is Sonnet.
 */
export function createConfiguredSkillSleepModels(environment: Readonly<Record<string, string | undefined>>, usageStore?: LlmUsageStore,
  strongest?: () => SkillSleepModel | null): { maintainer: SkillSleepModel | null; proposer: SkillSleepModel | null } {
  const selected = configuredResponseModel(environment, 'SHANNON_SKILL_MODEL', environment.SHANNON_KNOWLEDGE_MODEL?.trim() || 'gpt-5.6-terra');
  // Review M4: no knowledge sleep (no selected model key, or switched off), no skill sleep either: no proposer, Sonnet included.
  if (!selected || environment.SHANNON_KNOWLEDGE_ENABLED?.trim() === 'false') return { maintainer: null, proposer: null };
  const maintainer = new OpenAISkillSleepModel({ ...selected, ...(usageStore ? { usageStore } : {}) });
  const strongestModel = strongest?.();
  const proposerSelection = strongestModel ? null : configuredResponseModel(environment, 'SHANNON_SKILL_PROPOSER_MODEL', selected.model);
  const proposer = strongestModel ?? (proposerSelection ? new OpenAISkillSleepModel({ ...proposerSelection, ...(usageStore ? { usageStore } : {}) }) : null);
  return { maintainer, proposer };
}
