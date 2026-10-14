import { configuredResponseModel, DEFAULT_HAIKU_MODEL } from '../../../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured, type BackgroundRoute, type ClaudeBackground } from '../../../infra/models/claude/claudeStructured.js';
import { configuredBackgroundBudgetUsd, estimatedOpenAICostUsd, responseUsage, utcMonthKey, type LlmUsageStore } from '../../../infra/models/llmUsage.js';
import { parseJson } from './store/dailyMindStore.js';
import {
  commitmentLineInstructions, commitmentRequest, promisePhraseChoice, promisePhraseSchema, type CommitmentFacts, type CommitmentLineWriter,
  type PromisePhraseChoice,
} from './commitmentLine.js';
import {
  lifecycleOutcomeLineInstructions, lifecycleOutcomeMessage, lifecycleOutcomeRequest, lifecyclePhraseSchema, type LifecycleOutcomeFacts,
  type LifecycleOutcomeLineWriter,
} from './lifecycleOutcomeLine.js';

/**
 * The writers of her phrase beside a fixed fact (`commitmentLine.ts`: a promise; `lifecycleOutcomeLine.ts`: the end of a Minecraft
 * operation): one background model call, cut off after 20 seconds, its choice held to the list by the schema and checked again.
 */
const CUTOFF_MILLISECONDS = 20_000;

/** One model call: its instructions, its request and the answer's schema. */
interface ModelCall { instructions: string; request: string; schema: Record<string, unknown> }

/** One kind of words: its names (for usage and the provider's schema), its schema, instructions and request, and its check. */
interface FactLine<F, R = string> {
  label: BackgroundRoute;
  schemaName: string;
  schema(facts: F): Record<string, unknown>;
  instructions(): string;
  request(facts: F): string;
  /** What is used of the model's parsed answer, or null when nothing of it can be. */
  read(answer: unknown, facts: F): R | null;
}

const COMMITMENT: FactLine<CommitmentFacts, PromisePhraseChoice> = {
  label: 'commitment_line', schemaName: 'shannon_promise_phrase', schema: promisePhraseSchema,
  instructions: () => commitmentLineInstructions(), request: commitmentRequest,
  // Only her choice from the list is kept; the fact sentence is the server's, built when the notice is told.
  read: (answer, facts) => promisePhraseChoice(answer, facts),
};
const LIFECYCLE_OUTCOME: FactLine<LifecycleOutcomeFacts> = {
  label: 'lifecycle_outcome_line', schemaName: 'shannon_lifecycle_outcome_phrase', schema: lifecyclePhraseSchema,
  instructions: () => lifecycleOutcomeLineInstructions(), request: lifecycleOutcomeRequest,
  // The fact word for word, with her phrase when it is one of the list; the fact alone when it is not.
  read: (answer, facts) => (answer && typeof answer === 'object' ? lifecycleOutcomeMessage(answer, facts) : null),
};

/**
 * The background model (`SHANNON_BACKGROUND_LLM_MODEL`, as the daily mind), within the background budget; null when none is set.
 * With anyone else there it is never asked (the private-safe fact sentence is said alone).
 */
export function configuredCommitmentLineWriter(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, fetcher?: typeof fetch,
): CommitmentLineWriter | null {
  const writer = configuredFactLineWriter(environment, usageStore, COMMITMENT, fetcher);
  return writer ? { write: async (scopeKey, facts, signal) => (facts.others ? null : writer.write(scopeKey, facts, signal)) } : null;
}

/** The writer of a lifecycle operation's end (`lifecycleOutcomeLine.ts`), on the same model and budget; null when none is set. */
export function configuredLifecycleOutcomeLineWriter(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, fetcher?: typeof fetch,
): LifecycleOutcomeLineWriter | null {
  return configuredFactLineWriter(environment, usageStore, LIFECYCLE_OUTCOME, fetcher);
}

function configuredFactLineWriter<F, R>(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, kind: FactLine<F, R>, fetcher?: typeof fetch,
): { write(scopeKey: string, facts: F, signal?: AbortSignal): Promise<R | null> } | null {
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
        const call: ModelCall = { instructions: kind.instructions(), request: kind.request(facts), schema: kind.schema(facts) };
        const text = claude ? await claudeLine(claude, kind, scopeKey, call, both, at)
          : await openAILine({ apiKey: selected.apiKey, model, fetcher: fetcher ?? fetch, usageStore }, kind, scopeKey, call, both, at);
        return kind.read(parseJson(text ?? ''), facts);
      } catch { return null; }
    },
  };
}

async function claudeLine<F, R>(
  claude: ClaudeBackground, kind: FactLine<F, R>, scopeKey: string, call: ModelCall, signal: AbortSignal, at: string,
): Promise<string | null> {
  const answer = await completeStructured<string>(kind.label, call.instructions, call.request, call.schema,
    { claude, scopeKey, maximumOutputTokens: 160, effort: 'none', signal, read: text => text, at: () => at });
  return answer.ok ? answer.value : null;
}

async function openAILine<F, R>(
  options: { apiKey: string; model: string; fetcher: typeof fetch; usageStore: LlmUsageStore }, kind: FactLine<F, R>, scopeKey: string,
  call: ModelCall, signal: AbortSignal, at: string,
): Promise<string | null> {
  const response = await options.fetcher('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, signal,
    body: JSON.stringify({
      model: options.model, instructions: call.instructions, input: call.request, reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: kind.schemaName, strict: true, schema: call.schema } }, max_output_tokens: 160, store: false,
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
