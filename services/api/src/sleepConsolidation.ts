import { createHash } from 'node:crypto';
import {
  memoryIdentifier,
  type CompanionStateSnapshot,
  type MemoryKind,
  type RelationshipInsight,
  type UserFact,
} from '@shannon/cognition';
import type { DailyUserMessage } from './backgroundJobStore.js';
import type { SleepChange, SleepContradiction } from './memoryService.js';
import {
  configuredBackgroundBudgetUsd,
  estimatedOpenAICostUsd,
  responseUsage,
  utcMonthKey,
  type LlmUsageStore,
} from './llmUsage.js';

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
  extractOutputText,
  makeChange,
  memoryId,
  normalize,
  parseJson,
  parseProposalRows,
} from './sleepConsolidationRules.js';

export interface UserFactProposal {
  kind?: 'user-fact' | 'relationship' | 'interest';
  statement: string;
  evidence: string;
}

export interface SleepConsolidationOutcome {
  facts: readonly UserFact[];
  relationships: readonly RelationshipInsight[];
  interests: readonly string[];
  report: {
    learned: readonly SleepChange[];
    updated: readonly SleepChange[];
    interestChanges: readonly SleepChange[];
    contradictions: readonly SleepContradiction[];
  };
}

export interface SleepMemoryAnalyzer {
  readonly mode: 'openai' | 'local-rules';
  analyze(messages: readonly DailyUserMessage[], context?: SleepAnalysisContext): Promise<readonly UserFactProposal[]>;
}

export interface SleepAnalysisContext {
  scopeKey: string;
  occurredAt: string;
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
  );
}

export function extractExplicitMemoryProposals(value: string): UserFactProposal[] {
  const text = normalize(value).slice(0, 2_000);
  if (!text) return [];
  const proposals: UserFactProposal[] = [];
  const utterances = text.match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
  for (const utterance of utterances) {
    if (/[？?]\s*$/u.test(utterance)) continue;
    const sentence = utterance.replace(/[。！!]\s*$/u, '').trim();
    if (!sentence) continue;
    for (const pattern of EXPLICIT_FACT_PATTERNS) appendRuleProposal(proposals, sentence, pattern, 'user-fact');
    for (const pattern of RELATIONSHIP_PATTERNS) appendRuleProposal(proposals, sentence, pattern, 'relationship');
    for (const pattern of INTEREST_PATTERNS) appendRuleProposal(proposals, sentence, pattern, 'interest');
  }
  return deduplicateProposals(proposals);
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
  readonly mode = 'openai' as const;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: OpenAISleepMemoryAnalyzerOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = options.model?.trim() || 'gpt-5.6-luna';
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(this.model)) throw new Error('SHANNON_SLEEP_MODEL is invalid');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
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
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions: SLEEP_INSTRUCTIONS,
        input: transcript,
        reasoning: { effort: 'none' },
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: 'shannon_sleep_memories',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
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
              required: ['facts', 'relationships', 'interests'],
            },
          },
        },
        max_output_tokens: 400,
        store: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) throw new Error(`OPENAI_SLEEP_RESPONSE_${response.status}`);
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
    const output = parseJson(extractOutputText(json));
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('OPENAI_SLEEP_OUTPUT_INVALID');
    const result = output as { facts?: unknown; relationships?: unknown; interests?: unknown };
    const facts = result.facts;
    if (!Array.isArray(facts)) throw new Error('OPENAI_SLEEP_OUTPUT_INVALID');
    return deduplicateProposals([
      ...parseProposalRows(facts, 'user-fact'),
      ...parseProposalRows(result.relationships, 'relationship'),
      ...parseProposalRows(result.interests, 'interest'),
    ]).slice(0, 20);
  }
}

export function createConfiguredSleepMemoryAnalyzer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  usageStore?: LlmUsageStore,
): SleepMemoryAnalyzer {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return new LocalRuleSleepMemoryAnalyzer();
  return new OpenAISleepMemoryAnalyzer({
    apiKey,
    model: environment.SHANNON_SLEEP_MODEL?.trim() || environment.SHANNON_LLM_MODEL?.trim(),
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
  const proposals = await analyzer.analyze(messages, context);
  const source = messages.map(message => normalize(message.content)).join('\n');
  const consolidated = consolidateProposals(proposals, source, current, observedAt, 0.55);
  const facts = [...consolidated.facts];
  const relationships = [...consolidated.relationships];
  const interests = [...consolidated.interests];
  const learned: SleepChange[] = [];
  const updated: SleepChange[] = [];
  const interestChanges: SleepChange[] = [];
  const contradictions: SleepContradiction[] = [];
  for (const proposal of proposals) {
    const kind = proposal.kind ?? 'user-fact';
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    if (!statement || !evidence || !source.includes(evidence)) continue;
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
    report: Object.freeze({
      learned: Object.freeze(learned), updated: Object.freeze(updated),
      interestChanges: Object.freeze(interestChanges), contradictions: Object.freeze(contradictions),
    }),
  });
}
