import { configuredResponseModel, DEFAULT_HAIKU_MODEL } from '../../../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured, type ClaudeBackground } from '../../../infra/models/claude/claudeStructured.js';
import { configuredBackgroundBudgetUsd, estimatedOpenAICostUsd, responseUsage, utcMonthKey, type LlmUsageStore } from '../../../infra/models/llmUsage.js';
import { parseJson } from './store/dailyMindStore.js';
import { COMMITMENT_LINE_INSTRUCTIONS, commitmentRequest, groundedCommitmentLine, type CommitmentFacts, type CommitmentLineWriter } from './commitmentLine.js';

/** The writer of a promise's line (`commitmentLine.ts`): one background model call in her voice, checked before it is used. */
const SCHEMA = { type: 'object', additionalProperties: false, properties: { line: { type: 'string' } }, required: ['line'] };

/** The background model (`SHANNON_BACKGROUND_LLM_MODEL`, as the daily mind), within the background budget; null when none is set. */
export function configuredCommitmentLineWriter(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, fetcher?: typeof fetch,
): CommitmentLineWriter | null {
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
        const timeout = AbortSignal.timeout(20_000);
        const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const text = claude ? await claudeLine(claude, scopeKey, facts, both, at)
          : await openAILine({ apiKey: selected.apiKey, model, fetcher: fetcher ?? fetch, usageStore }, scopeKey, facts, both, at);
        const parsed = parseJson(text ?? '') as { line?: unknown } | null;
        return groundedCommitmentLine(parsed?.line, facts);
      } catch { return null; }
    },
  };
}

async function claudeLine(claude: ClaudeBackground, scopeKey: string, facts: CommitmentFacts, signal: AbortSignal, at: string): Promise<string | null> {
  const answer = await completeStructured<string>('commitment_line', COMMITMENT_LINE_INSTRUCTIONS, commitmentRequest(facts), SCHEMA,
    { claude, scopeKey, maximumOutputTokens: 160, effort: 'none', signal, read: text => text, at: () => at });
  return answer.ok ? answer.value : null;
}

async function openAILine(
  options: { apiKey: string; model: string; fetcher: typeof fetch; usageStore: LlmUsageStore }, scopeKey: string, facts: CommitmentFacts, signal: AbortSignal,
  at: string,
): Promise<string | null> {
  const response = await options.fetcher('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, signal,
    body: JSON.stringify({
      model: options.model, instructions: COMMITMENT_LINE_INSTRUCTIONS, input: commitmentRequest(facts), reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: 'shannon_commitment_line', strict: true, schema: SCHEMA } }, max_output_tokens: 160, store: false,
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
