import { backgroundModelAttempt, requireBackgroundUsage } from '../../infra/models/backgroundModelAttempt.js';
import { configuredResponseModel, DEFAULT_HAIKU_MODEL, isHaikuModel } from '../../infra/models/anthropic/haikuConfig.js';
import { claudeBackground, completeStructured, type ClaudeBackground } from '../../infra/models/claude/claudeStructured.js';
import { createHash } from 'node:crypto';
import { isForgottenCommitmentEvidence } from '../memory/memoryVisibilityPorts.js';
import { reviewCommitments, type CommitmentSleepReview } from './sleepCommitmentReview.js';
import {
  memoryIdentifier,
  isOwnerMemoryEvidence,
  type CompanionStateSnapshot,
  type MemoryKind,
  type RelationshipInsight,
  type UserFact,
  type SelfInterest,
} from '@shannon/cognition';
import { SELF_INTEREST_SLEEP_INSTRUCTIONS, SELF_INTEREST_SLEEP_SCHEMA, parseSleepSelfInterests, type SleepSelfInterestDraft } from './sleepSelfInterests.js';
import type { DailyUserMessage } from './store/backgroundJobStore.js';
import type { SleepChange, SleepContradiction } from '../memory/memoryPorts.js';
import {
  configuredBackgroundBudgetUsd,
  estimatedOpenAICostUsd,
  responseUsage,
  utcMonthKey,
  type LlmUsageStore,
} from '../../infra/models/llmUsage.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

import {
  EXPLICIT_FACT_PATTERNS,
  INTEREST_PATTERNS,
  RELATIONSHIP_PATTERNS,
  SLEEP_INSTRUCTIONS,
  appendRuleProposal,
  conflictingCurrent,
  consolidateProposals,
  deduplicateProposals,
  directPreferenceValue,
  explicitFactStatement,
  extractOutputText,
  makeChange,
  memoryId,
  normalize,
  parseJson,
  parseProposalRows,
} from './sleepConsolidationRules.js';
import { extractExplicitMemoryProposals } from './explicitMemoryProposals.js';
export { extractExplicitMemoryProposals } from './explicitMemoryProposals.js';

export interface UserFactProposal {
  kind?: 'user-fact' | 'relationship' | 'interest';
  statement: string;
  evidence: string;
  selfInterest?: SleepSelfInterestDraft;
}

export interface SleepConsolidationOutcome {
  facts: readonly UserFact[];
  relationships: readonly RelationshipInsight[];
  interests: readonly string[];
  /** Only present while stage 5 is on; verified source references for the owner-observation lane. */
  interestEvidence?: readonly { interest: string; episodeIds: readonly string[] }[];
  selfInterestDrafts?: readonly SleepSelfInterestDraft[];
  report: {
    commitmentReview?: CommitmentSleepReview;
    learned: readonly SleepChange[];
    updated: readonly SleepChange[];
    interestChanges: readonly SleepChange[];
    contradictions: readonly SleepContradiction[];
  };
}

export interface SleepMemoryAnalyzer {
  readonly mode: 'openai' | 'anthropic' | 'local-rules';
  analyze(messages: readonly DailyUserMessage[], context?: SleepAnalysisContext): Promise<readonly UserFactProposal[]>;
}

export interface SleepAnalysisContext {
  scopeKey: string;
  occurredAt: string;
  stage5?: boolean;
  selfInterests?: readonly SelfInterest[];
  signal?: AbortSignal;
}

export class LocalRuleSleepMemoryAnalyzer implements SleepMemoryAnalyzer {
  readonly mode = 'local-rules' as const;

  async analyze(messages: readonly DailyUserMessage[]): Promise<readonly UserFactProposal[]> {
    return deduplicateProposals(messages.flatMap(message => extractExplicitMemoryProposals(message.content))).slice(0, 16);
  }
}

export interface ImmediateMemoryOutcome {
  facts: readonly UserFact[];
  relationships: readonly RelationshipInsight[];
  interests: readonly string[];
  /** Stored answers that a newer owner statement replaced in place (same id, previous wording kept as history). */
  revisions?: readonly { id: string; previousText: string }[];
}

/**
 * Cheap, deterministic capture for facts the user stated directly. This runs in
 * the turn-refinement worker, never in the FCA response lane. Anything inferred
 * or contradictory remains a sleep-batch concern.
 */
export function captureImmediateExplicitMemory(
  userMessage: string,
  current: CompanionStateSnapshot,
  observedAt: string,
  supplementalProposals: readonly UserFactProposal[] = [],
): ImmediateMemoryOutcome {
  const source = normalize(userMessage).slice(0, 2_000);
  return consolidateProposals(
    deduplicateProposals([...extractExplicitMemoryProposals(source), ...supplementalProposals]),
    source,
    current,
    observedAt,
    0.72,
    { revise: true },
  );
}

interface OpenAISleepMemoryAnalyzerOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
  usageStore?: LlmUsageStore;
  backgroundBudgetUsd?: number;
  now?: () => Date;
}

export class OpenAISleepMemoryAnalyzer implements SleepMemoryAnalyzer {
  readonly mode: 'openai' | 'anthropic';
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;
  /** The background route of a Claude model (`claudeStructured.ts`); null keeps the OpenAI Responses request. */
  private readonly claude: ClaudeBackground | null;

  constructor(private readonly options: OpenAISleepMemoryAnalyzerOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = options.model?.trim() || DEFAULT_HAIKU_MODEL;
    this.mode = isHaikuModel(this.model) ? 'anthropic' : 'openai';
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(this.model)) throw new Error('SHANNON_SLEEP_MODEL is invalid');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    const { apiKey, fetcher, endpoint, usageStore } = options;
    this.claude = claudeBackground(this.model, { apiKey, fetcher, endpoint, usageStore });
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  }

  async analyze(messages: readonly DailyUserMessage[], context?: SleepAnalysisContext): Promise<readonly UserFactProposal[]> {
    if (!messages.length) return [];
    const current = this.options.now?.() ?? new Date();
    const budget = this.options.backgroundBudgetUsd ?? 0.5;
    if ((this.options.usageStore?.backgroundLlmCostUsd(utcMonthKey(current)) ?? 0) >= budget) return [];
    const transcript = messages
      .map((message, index) => `[${index + 1}] ${message.content.replace(/\s+/g, ' ').trim().slice(0, 2_000)}`)
      .join('\n')
      .slice(0, 24_000);
    return backgroundModelAttempt({ ...this.options, model: this.model, scopeKey: context?.scopeKey ?? '', lane: 'sleep',
      maxOutputTokens: context?.stage5 ? 1200 : 400, signal: context?.signal, now: () => context?.occurredAt ?? current.toISOString() }, async accounted => {
    const stage5 = context?.stage5 === true;
    const request = {
      instructions: SLEEP_INSTRUCTIONS + (stage5 ? SELF_INTEREST_SLEEP_INSTRUCTIONS : ''),
      input: stage5 ? `${transcript}\n現在の自己関心（変更の基準。根拠にはしない）:\n${JSON.stringify(context?.selfInterests ?? [])}` : transcript,
      schema: sleepMemorySchema(stage5), maximumOutputTokens: stage5 ? 1_200 : 400,
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMilliseconds), ...(context?.signal ? [context.signal] : [])]),
    };
    const output = this.claude ? await this.claudeOutput(this.claude, request, context, accounted) : await this.openAIOutput(request, context, accounted);
    return sleepProposals(output, messages, context);
    });
  }

  private async claudeOutput(claude: ClaudeBackground, request: SleepRequest, context: SleepAnalysisContext | undefined,
    accounted: () => void): Promise<unknown> {
    // Without a context nothing is booked, as before.
    const route = context ? claude : { model: claude.model, client: claude.client };
    const answer = await completeStructured<string>('sleep', request.instructions, request.input, request.schema, {
      claude: route, scopeKey: context?.scopeKey ?? '', maximumOutputTokens: request.maximumOutputTokens, effort: 'none', signal: request.signal,
      onBooked: accounted, requireUsage: Boolean(context?.signal), read: text => text, ...(context ? { at: () => context.occurredAt } : {}),
    });
    if (!answer.ok) throw Object.assign(new Error(`OPENAI_SLEEP_RESPONSE_${answer.status}`), { status: answer.status });
    context?.signal?.throwIfAborted();
    return parseJson(answer.value);
  }

  private async openAIOutput(request: SleepRequest, context: SleepAnalysisContext | undefined, accounted: () => void): Promise<unknown> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions: request.instructions,
        input: request.input,
        reasoning: { effort: 'none' },
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: 'shannon_sleep_memories',
            strict: true,
            schema: request.schema,
          },
        },
        max_output_tokens: request.maximumOutputTokens,
        store: false,
      }),
      signal: request.signal,
    });
    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) throw Object.assign(new Error(`OPENAI_SLEEP_RESPONSE_${response.status}`), { status: response.status });
    const usage = responseUsage(json);
    if (context) {
      this.options.usageStore?.recordLlmUsage({
        scopeKey: context.scopeKey,
        lane: 'sleep',
        model: this.model,
        ...usage,
        estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
        occurredAt: context.occurredAt,
      });
    }
    if (usage.unknownCostUpperBoundUsd) accounted();
    requireBackgroundUsage((json as { usage?: unknown })?.usage, context?.signal);
    accounted();
    context?.signal?.throwIfAborted();
    return parseJson(extractOutputText(json));
  }
}

interface SleepRequest {
  instructions: string;
  input: string;
  schema: Record<string, unknown>;
  maximumOutputTokens: number;
  signal: AbortSignal;
}

function sleepMemorySchema(stage5: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...(stage5 ? { selfInterests: SELF_INTEREST_SLEEP_SCHEMA } : {}),
      facts: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            statement: { type: 'string', maxLength: 160 },
            evidence: { type: 'string', maxLength: 240 },
          },
          required: ['statement', 'evidence'],
        },
      },
      relationships: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            statement: { type: 'string', maxLength: 160 },
            evidence: { type: 'string', maxLength: 240 },
          },
          required: ['statement', 'evidence'],
        },
      },
      interests: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            statement: { type: 'string', maxLength: 160 },
            evidence: { type: 'string', maxLength: 240 },
          },
          required: ['statement', 'evidence'],
        },
      },
    },
    required: ['facts', 'relationships', 'interests', ...(stage5 ? ['selfInterests'] : [])],
  };
}

function sleepProposals(output: unknown, messages: readonly DailyUserMessage[], context: SleepAnalysisContext | undefined): UserFactProposal[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('OPENAI_SLEEP_OUTPUT_INVALID');
  const result = output as { facts?: unknown; relationships?: unknown; interests?: unknown; selfInterests?: unknown };
  const facts = result.facts;
  if (!Array.isArray(facts)) throw new Error('OPENAI_SLEEP_OUTPUT_INVALID');
  const ownerProposals = deduplicateProposals([
    ...parseProposalRows(facts, 'user-fact'),
    ...parseProposalRows(result.relationships, 'relationship'),
    ...parseProposalRows(result.interests, 'interest'),
  ]).slice(0, 20);
  return [...ownerProposals, ...(context?.stage5 ? parseSleepSelfInterests(result.selfInterests, messages, context.selfInterests ?? [])
    .map(selfInterest => ({ kind: 'interest' as const, statement: selfInterest.proposal.title ?? '', evidence: selfInterest.evidence, selfInterest })) : [])];
}

export function createConfiguredSleepMemoryAnalyzer(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
  usageStore?: LlmUsageStore,
): SleepMemoryAnalyzer {
  const selected = configuredResponseModel(environment, 'SHANNON_SLEEP_MODEL', environment.SHANNON_LLM_MODEL);
  if (!selected) return new LocalRuleSleepMemoryAnalyzer();
  return new OpenAISleepMemoryAnalyzer({
    ...selected,
    usageStore,
    backgroundBudgetUsd: configuredBackgroundBudgetUsd(environment),
  });
}

export async function consolidateUserFacts(
  analyzer: SleepMemoryAnalyzer,
  messages: readonly DailyUserMessage[],
  current: CompanionStateSnapshot,
  observedAt: string,
): Promise<readonly UserFact[]> {
  return (await consolidateSleepMemory(analyzer, messages, current, observedAt)).facts;
}

export async function consolidateSleepMemory(
  analyzer: SleepMemoryAnalyzer,
  messages: readonly DailyUserMessage[],
  current: CompanionStateSnapshot,
  observedAt: string,
  context?: SleepAnalysisContext,
): Promise<SleepConsolidationOutcome> {
  const visibleMessages = messages.filter(message => !isForgottenCommitmentEvidence(current, message.content));
  const analyzed = await analyzer.analyze(visibleMessages, context);
  const proposals = analyzed.filter(proposal => !proposal.selfInterest);
  const source = visibleMessages.map(message => normalize(message.content)).join('\n');
  const consolidated = consolidateProposals(proposals, source, current, observedAt, 0.55);
  const withSource = <T extends UserFact | RelationshipInsight>(item: T): T => {
    const original = visibleMessages.find(message => item.evidence && normalize(message.content).includes(item.evidence));
    return original?.sourceExperienceId ? { ...item, sourceExperienceId: original.sourceExperienceId } : item;
  };
  const facts = consolidated.facts.map(withSource);
  const relationships = consolidated.relationships.map(withSource);
  const interests = [...consolidated.interests];
  const interestEvidence = context?.stage5 ? interests.map(interest => ({ interest,
    episodeIds: [...new Set(proposals.filter(p => p.kind === 'interest' && normalize(p.statement).slice(0, 160) === interest)
      .flatMap(p => visibleMessages.filter(message => normalize(message.content).includes(normalize(p.evidence)))
        .flatMap(message => message.sourceExperienceId ? [message.sourceExperienceId] : [])))] })) : undefined;
  const learned: SleepChange[] = [];
  const updated: SleepChange[] = [];
  const interestChanges: SleepChange[] = [];
  const contradictions: SleepContradiction[] = [];
  for (const proposal of proposals) {
    const kind = proposal.kind ?? 'user-fact';
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    if (!statement || !evidence || !source.includes(evidence) || !isOwnerMemoryEvidence(evidence, source)) continue;
    if (isForgottenCommitmentEvidence(current, evidence)) continue;
    const id = memoryId(kind, statement);
    const control = current.memoryControls.find(item => item.memoryId === id);
    if (control && control.status !== 'active') {
      contradictions.push({
        kind, memoryId: id, currentText: control.overrideText || statement, candidateText: statement,
        reason: control.status === 'rejected' ? 'ユーザーが事実ではないと指定済み' : 'ユーザーが忘れるよう指定済み',
        evidence,
      });
      continue;
    }
    const conflict = conflictingCurrent(current, kind, statement);
    if (conflict) {
      contradictions.push({
        kind, memoryId: conflict.id, currentText: conflict.text, candidateText: statement,
        reason: '既存の理解と矛盾するため自動上書きせず保留', evidence,
      });
      continue;
    }
    if (kind === 'user-fact') {
      const previous = current.userFacts.find(item => item.id === id);
      (previous ? updated : learned).push(makeChange(kind, id, statement, previous ? '同じ内容が再確認された' : '明示されたユーザー情報を学習', evidence));
    } else if (kind === 'relationship') {
      const previous = current.relationships.find(item => item.id === id);
      (previous ? updated : learned).push(makeChange(kind, id, statement, previous ? '関わり方が再確認された' : '望ましい関わり方を学習', evidence));
    } else if (!current.interests.includes(statement)) {
      interestChanges.push(makeChange(kind, id, statement, '明示された関心からシャノンの関心が動いた', evidence));
    }
  }
  return Object.freeze({
    facts: Object.freeze(facts.slice(0, 8)),
    relationships: Object.freeze(relationships.slice(0, 6)),
    interests: Object.freeze(interests.slice(0, 6)),
    ...(interestEvidence ? { interestEvidence } : {}),
    ...(context?.stage5 ? { selfInterestDrafts: analyzed.flatMap(proposal => proposal.selfInterest ? [proposal.selfInterest] : []) } : {}),
    report: Object.freeze({
      commitmentReview: reviewCommitments(current, observedAt),
      learned: Object.freeze(learned), updated: Object.freeze(updated),
      interestChanges: Object.freeze(interestChanges), contradictions: Object.freeze(contradictions),
    }),
  });
}
