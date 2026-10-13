import { configuredResponseModel, DEFAULT_HAIKU_MODEL } from '../../../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured, type BackgroundRoute, type ClaudeBackground } from '../../../infra/models/claude/claudeStructured.js';
import { configuredBackgroundBudgetUsd, estimatedOpenAICostUsd, responseUsage, utcMonthKey, type LlmUsageStore } from '../../../infra/models/llmUsage.js';
import { parseJson } from './store/dailyMindStore.js';
import { commitmentLineInstructions, commitmentRequest, groundedCommitmentLine, type CommitmentFacts, type CommitmentLineWriter } from './commitmentLine.js';
import {
  groundedLifecycleOutcomeLine, lifecycleOutcomeLineInstructions, lifecycleOutcomeRequest, type LifecycleOutcomeFacts, type LifecycleOutcomeLineWriter,
} from './lifecycleOutcomeLine.js';

/**
 * The writers of a line in her voice from facts (`commitmentLine.ts`, `lifecycleOutcomeLine.ts`): one background model call, cut
 * off after 20 seconds, checked before it is used.
 */
const SCHEMA = { type: 'object', additionalProperties: false, properties: { line: { type: 'string' } }, required: ['line'] };
const CUTOFF_MILLISECONDS = 20_000;

/** One kind of line: its names (for usage and the provider's schema), its instructions, its request, and its check. */
interface FactLine<F> {
  label: BackgroundRoute;
  schemaName: string;
  instructions(): string;
  request(facts: F): string;
  grounded(line: unknown, facts: F): string | null;
}

const COMMITMENT: FactLine<CommitmentFacts> = {
  label: 'commitment_line', schemaName: 'shannon_commitment_line',
  instructions: () => commitmentLineInstructions(), request: commitmentRequest, grounded: groundedCommitmentLine,
};
const LIFECYCLE_OUTCOME: FactLine<LifecycleOutcomeFacts> = {
  label: 'lifecycle_outcome_line', schemaName: 'shannon_lifecycle_outcome_line',
  instructions: () => lifecycleOutcomeLineInstructions(), request: lifecycleOutcomeRequest, grounded: groundedLifecycleOutcomeLine,
};

/** The background model (`SHANNON_BACKGROUND_LLM_MODEL`, as the daily mind), within the background budget; null when none is set. */
export function configuredCommitmentLineWriter(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, fetcher?: typeof fetch,
): CommitmentLineWriter | null {
  return configuredFactLineWriter(environment, usageStore, COMMITMENT, fetcher);
}

/** The writer of a lifecycle operation's end (`lifecycleOutcomeLine.ts`), on the same model and budget; null when none is set. */
export function configuredLifecycleOutcomeLineWriter(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, fetcher?: typeof fetch,
): LifecycleOutcomeLineWriter | null {
  return configuredFactLineWriter(environment, usageStore, LIFECYCLE_OUTCOME, fetcher);
}

function configuredFactLineWriter<F>(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, kind: FactLine<F>, fetcher?: typeof fetch,
): { write(scopeKey: string, facts: F, signal?: AbortSignal): Promise<string | null> } | null {
  const selected = configuredResponseModel(environment, 'SHANNON_BACKGROUND_LLM_MODEL', environment.SHANNON_LLM_MODEL);
  if (!selected?.apiKey.trim()) return null;
  const model = /^[A-Za-z0-9._:-]{1,100}$/u.test(selected.model ?? '') ? selected.model! : DEFAULT_HAIKU_MODEL;
  const claude = claudeBackground(model, { apiKey: selected.apiKey, ...(fetcher ? { fetcher } : {}), usageStore });
  const budget = configuredBackgroundBudgetUsd(environment);
  return {
    async write(scopeKey, facts, signal) {
      const at = new Date().toISOString();
      try {
        if (usageStore.backgroundLlmCostUsd(utcMonthKey(new Date(at))) >= budget) return null;
        const timeout = AbortSignal.timeout(CUTOFF_MILLISECONDS);
        const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const instructions = kind.instructions(), request = kind.request(facts);
        const text = claude ? await claudeLine(claude, kind, scopeKey, instructions, request, both, at)
          : await openAILine({ apiKey: selected.apiKey, model, fetcher: fetcher ?? fetch, usageStore }, kind, scopeKey, instructions, request, both, at);
        const parsed = parseJson(text ?? '') as { line?: unknown } | null;
        return kind.grounded(parsed?.line, facts);
      } catch { return null; }
    },
  };
}

async function claudeLine<F>(
  claude: ClaudeBackground, kind: FactLine<F>, scopeKey: string, instructions: string, request: string, signal: AbortSignal, at: string,
): Promise<string | null> {
  const answer = await completeStructured<string>(kind.label, instructions, request, SCHEMA,
    { claude, scopeKey, maximumOutputTokens: 160, effort: 'none', signal, read: text => text, at: () => at });
  return answer.ok ? answer.value : null;
}

async function openAILine<F>(
  options: { apiKey: string; model: string; fetcher: typeof fetch; usageStore: LlmUsageStore }, kind: FactLine<F>, scopeKey: string,
  instructions: string, request: string, signal: AbortSignal, at: string,
): Promise<string | null> {
  const response = await options.fetcher('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, signal,
    body: JSON.stringify({
      model: options.model, instructions, input: request, reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: kind.schemaName, strict: true, schema: SCHEMA } }, max_output_tokens: 160, store: false,
    }),
  });
  const json = parseJson(await response.text());
  if (!response.ok) return null;
  const usage = responseUsage(json);
  const estimatedCostUsd = estimatedOpenAICostUsd(options.model, usage);
  options.usageStore.recordLlmUsage({ scopeKey, lane: 'sleep', model: options.model, ...usage, estimatedCostUsd, occurredAt: at });
  const output = (json as { output_text?: unknown } | null)?.output_text;
  return typeof output === 'string' ? output : null;
}
