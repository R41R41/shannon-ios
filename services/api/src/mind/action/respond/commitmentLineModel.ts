import { configuredResponseModel, DEFAULT_HAIKU_MODEL } from '../../../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured, type BackgroundRoute, type ClaudeBackground } from '../../../infra/models/claude/claudeStructured.js';
import { configuredBackgroundBudgetUsd, estimatedOpenAICostUsd, responseUsage, utcMonthKey, type LlmUsageStore } from '../../../infra/models/llmUsage.js';
import { parseJson } from './store/dailyMindStore.js';
import { switchOn } from '@shannon/switches';
import {
  commitmentLineInstructions, commitmentLineInstructionsWithCore, commitmentRequest, groundedCommitmentLine, judgedCommitmentText, type CommitmentFacts,
  type CommitmentLineWriter,
} from './commitmentLine.js';
import { canonicalTimePhrases } from './commitmentLineTime.js';
import {
  PROMISE_TIME_HAIKU_INSTRUCTIONS, PROMISE_TIME_QUESTION, PROMISE_TIME_SCHEMA, promiseJudgeState, promiseJudgeVerdict, type CommitmentJudgeVerdict,
  type CommitmentTimeJudge,
} from './commitmentLineJudge.js';
import { JevChoiceClient, jevAnswers, jevNoul } from '../../../infra/models/jev/jevChoice.js';
import {
  lifecycleOutcomeLineInstructions, lifecycleOutcomeMessage, lifecycleOutcomeRequest, lifecyclePhraseSchema, type LifecycleOutcomeFacts,
  type LifecycleOutcomeLineWriter,
} from './lifecycleOutcomeLine.js';

/**
 * The writers of her words from facts (`commitmentLine.ts`: a promise's line; `lifecycleOutcomeLine.ts`: her phrase beside a fixed
 * fact): one background model call, cut off after 20 seconds, checked before it is used.
 */
const LINE_SCHEMA = { type: 'object', additionalProperties: false, properties: { line: { type: 'string' } }, required: ['line'] };
const CUTOFF_MILLISECONDS = 20_000;

/** One model call: its instructions, its request and the answer's schema. */
interface ModelCall { instructions: string; request: string; schema: Record<string, unknown> }

/** One kind of words: its names (for usage and the provider's schema), its schema, instructions and request, and its check. */
interface FactLine<F> {
  label: BackgroundRoute;
  schemaName: string;
  schema(facts: F): Record<string, unknown>;
  instructions(): string;
  request(facts: F): string;
  /** What is said, from the model's parsed answer, or null when nothing of it can be used. */
  read(answer: unknown, facts: F): string | null;
}

const COMMITMENT: FactLine<CommitmentFacts> = {
  label: 'commitment_line', schemaName: 'shannon_commitment_line', schema: () => LINE_SCHEMA,
  instructions: () => commitmentLineInstructions(), request: commitmentRequest,
  read: (answer, facts) => groundedCommitmentLine((answer as { line?: unknown } | null)?.line, facts),
};
const LIFECYCLE_OUTCOME: FactLine<LifecycleOutcomeFacts> = {
  label: 'lifecycle_outcome_line', schemaName: 'shannon_lifecycle_outcome_phrase', schema: lifecyclePhraseSchema,
  instructions: () => lifecycleOutcomeLineInstructions(), request: lifecycleOutcomeRequest,
  // The fact word for word, with her phrase when it is one of the list; the fact alone when it is not.
  read: (answer, facts) => (answer && typeof answer === 'object' ? lifecycleOutcomeMessage(answer, facts) : null),
};

/** The background model (`SHANNON_BACKGROUND_LLM_MODEL`, as the daily mind), within the background budget; null when none is set. */
export function configuredCommitmentLineWriter(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, fetcher?: typeof fetch, log: (line: string) => void = () => {},
): CommitmentLineWriter | null {
  if (!switchOn(environment, 'SHANNON_PROMISE_ON_TIME')) return configuredFactLineWriter(environment, usageStore, COMMITMENT, fetcher);
  // SHANNON_PROMISE_ON_TIME: her whole core leads the instructions (the prefix of her moment speech), she writes {時刻} and {約束}
  // (the raw line is kept here, checked strictly), and a second judge must say no other time is stated before her line is used.
  const kind: FactLine<CommitmentFacts> = {
    ...COMMITMENT, instructions: () => commitmentLineInstructionsWithCore(),
    read: (answer, facts) => {
      const line = (answer as { line?: unknown } | null)?.line;
      return typeof line === 'string' && judgedCommitmentText(line, facts) !== null ? line : null;
    },
  };
  const base = configuredFactLineWriter(environment, usageStore, kind, fetcher);
  if (!base) return null;
  const judge = configuredPromiseJudge(environment, usageStore, fetcher);
  return {
    async write(scopeKey, facts, signal) {
      return judgedPromiseLine(await base.write(scopeKey, facts, signal), facts, judge, { scopeKey, log, ...(signal ? { signal } : {}) });
    },
  };
}

/**
 * Her raw line (placeholders and all) as said, only when it passes the strict check and the second judge answers a clear no;
 * otherwise null (the neutral line). No judge at all is unsure. The verdict is logged as closed codes only.
 */
export async function judgedPromiseLine(raw: string | null, facts: CommitmentFacts, judge: CommitmentTimeJudge | null,
  context: { scopeKey: string; log?: (line: string) => void; signal?: AbortSignal }): Promise<string | null> {
  const judged = raw === null ? null : judgedCommitmentText(raw, facts);
  const said = raw === null ? null : groundedCommitmentLine(raw, facts);
  if (!judged || !said) return null;
  let verdict: CommitmentJudgeVerdict = 'unsure';
  const time = canonicalTimePhrases(facts)[0] ?? null;
  try { verdict = judge ? await judge.otherTime(context.scopeKey, judged, time, context.signal) : 'unsure'; } catch { verdict = 'unsure'; }
  try { context.log?.(`Shannon promise judge: ${judge?.name ?? 'none'}:${verdict}`); } catch { /* optional */ }
  return verdict === 'no' ? said : null;
}

/** The second judge of a promise's line: Jev (`TYPESAFE_API_KEY`), else the background Haiku; null when neither is set. */
export function configuredPromiseJudge(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore, fetcher?: typeof fetch,
): CommitmentTimeJudge | null {
  const jevKey = environment.TYPESAFE_API_KEY?.trim();
  if (jevKey) {
    const client = new JevChoiceClient({
      apiKey: jevKey, model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
      ...(environment.SHANNON_JEV_ENDPOINT?.trim() ? { endpoint: environment.SHANNON_JEV_ENDPOINT.trim() } : {}),
      timeoutMilliseconds: 5_000, ...(fetcher ? { fetcher } : {}),
    });
    return {
      name: 'jev',
      async otherTime(_scopeKey, sentence, time, signal) {
        try {
          const answers = jevAnswers(await client.ask(promiseJudgeState(sentence, time), { other_time: PROMISE_TIME_QUESTION }, signal));
          return promiseJudgeVerdict(jevNoul(answers, 'other_time'));
        } catch { return 'unsure'; }
      },
    };
  }
  const selected = configuredResponseModel(environment, 'SHANNON_BACKGROUND_LLM_MODEL', environment.SHANNON_LLM_MODEL);
  if (!selected?.apiKey.trim()) return null;
  const model = /^[A-Za-z0-9._:-]{1,100}$/u.test(selected.model ?? '') ? selected.model! : DEFAULT_HAIKU_MODEL;
  const claude = claudeBackground(model, { apiKey: selected.apiKey, ...(fetcher ? { fetcher } : {}), usageStore });
  if (!claude) return null;
  return {
    name: 'haiku',
    async otherTime(scopeKey, sentence, time, signal) {
      try {
        const at = new Date().toISOString();
        const timeout = AbortSignal.timeout(CUTOFF_MILLISECONDS);
        const answer = await completeStructured<string>('commitment_line', PROMISE_TIME_HAIKU_INSTRUCTIONS, JSON.stringify(promiseJudgeState(sentence, time)),
          PROMISE_TIME_SCHEMA as unknown as Record<string, unknown>, {
            claude, scopeKey, maximumOutputTokens: 60, effort: 'none', read: text => text, at: () => at,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
        const value = answer.ok ? (parseJson(answer.value) as { other_time?: unknown } | null)?.other_time : null;
        return value === 'no' || value === 'yes' ? value : 'unsure';
      } catch { return 'unsure'; }
    },
  };
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
        const call: ModelCall = { instructions: kind.instructions(), request: kind.request(facts), schema: kind.schema(facts) };
        const text = claude ? await claudeLine(claude, kind, scopeKey, call, both, at)
          : await openAILine({ apiKey: selected.apiKey, model, fetcher: fetcher ?? fetch, usageStore }, kind, scopeKey, call, both, at);
        return kind.read(parseJson(text ?? ''), facts);
      } catch { return null; }
    },
  };
}

async function claudeLine<F>(
  claude: ClaudeBackground, kind: FactLine<F>, scopeKey: string, call: ModelCall, signal: AbortSignal, at: string,
): Promise<string | null> {
  const answer = await completeStructured<string>(kind.label, call.instructions, call.request, call.schema,
    { claude, scopeKey, maximumOutputTokens: 160, effort: 'none', signal, read: text => text, at: () => at });
  return answer.ok ? answer.value : null;
}

async function openAILine<F>(
  options: { apiKey: string; model: string; fetcher: typeof fetch; usageStore: LlmUsageStore }, kind: FactLine<F>, scopeKey: string,
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
