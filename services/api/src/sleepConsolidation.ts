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
  analyze(messages: readonly DailyUserMessage[]): Promise<readonly UserFactProposal[]>;
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

  async analyze(messages: readonly DailyUserMessage[]): Promise<readonly UserFactProposal[]> {
    if (!messages.length) return [];
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
        max_output_tokens: 1_200,
        store: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) throw new Error(`OPENAI_SLEEP_RESPONSE_${response.status}`);
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
): SleepMemoryAnalyzer {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return new LocalRuleSleepMemoryAnalyzer();
  return new OpenAISleepMemoryAnalyzer({
    apiKey,
    model: environment.SHANNON_SLEEP_MODEL?.trim() || environment.SHANNON_LLM_MODEL?.trim(),
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
): Promise<SleepConsolidationOutcome> {
  const proposals = await analyzer.analyze(messages);
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

const SLEEP_INSTRUCTIONS = `その日のユーザー発言を振り返る。
factsにはユーザーが明示した持続的な情報、relationshipsにはシャノンに望む関わり方、interestsにはユーザーが明示した最近の関心だけを入れる。
日本語では主語が省略される。「寿司が好き」「大きな音が嫌い」「好物はカレー」「苦手な食べ物は納豆」のような直接表現はユーザー本人の持続的な好みとしてfactsに入れる。
質問、第三者についての話、伝聞、過去だけの好み、「たぶん」「かもしれない」など不確かな表現は入れない。
推測、診断、センシティブ属性、秘密、一時的な気分、シャノンの発言由来の情報は含めない。
evidenceは入力中に完全一致する短いユーザー発言をそのまま返す。確信がなければ各配列を空にする。`;

const EXPLICIT_FACT_PATTERNS = [
  {
    pattern: /^(?:好きな食べ物|一番好きな食べ物|好物)(?:は|：|:)(?:、)?(.{1,60}?)(?:です|だ)?$/u,
    statement: (value: string) => `ユーザーの好きな食べ物は${value}`,
    accept: directPreferenceValue,
  },
  {
    pattern: /^(?:苦手な食べ物|嫌いな食べ物)(?:は|：|:)(?:、)?(.{1,60}?)(?:です|だ)?$/u,
    statement: (value: string) => `ユーザーが苦手な食べ物は${value}`,
    accept: directPreferenceValue,
  },
  {
    pattern: /^(?:食べ物なら|食べ物だと)(.{1,60}?)(?:が)?(?:一番)?(?:大)?好き(?:です|だ|なんだ)?(?:よ)?$/u,
    statement: (value: string) => `ユーザーの好きな食べ物は${value}`,
    accept: directPreferenceValue,
  },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:が好き|を好む)/u, statement: (value: string) => `ユーザーは${value}が好き` },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:が苦手|が嫌い)/u, statement: (value: string) => `ユーザーは${value}が苦手` },
  {
    pattern: /^([^はが、]{1,60}?)(?:が)?(?:一番)?(?:大)?好き(?:です|だ|なんだ)?(?:よ)?$/u,
    statement: (value: string) => `ユーザーは${value}が好き`,
    accept: directPreferenceValue,
  },
  {
    pattern: /^([^はが、]{1,60}?)(?:が)(?:苦手|嫌い)(?:です|だ|なんだ)?(?:よ)?$/u,
    statement: (value: string) => `ユーザーは${value}が苦手`,
    accept: directPreferenceValue,
  },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:をしている|をやっている)/u, statement: (value: string) => `ユーザーは${value}をしている` },
  { pattern: /(?:僕の|私の|自分の)?名前は(?:、)?(.{1,60})/u, statement: (value: string) => `ユーザーの名前は${value}` },
  { pattern: /(?:僕の|私の|自分の)?(?:仕事|職業)は(?:、)?(.{1,100})/u, statement: (value: string) => `ユーザーの仕事は${value}` },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:に住んでいる|在住)/u, statement: (value: string) => `ユーザーは${value}に住んでいる` },
  { pattern: /(?:僕の|私の|自分の)?誕生日は(?:、)?(.{1,60})/u, statement: (value: string) => `ユーザーの誕生日は${value}` },
] as const;

const RELATIONSHIP_PATTERNS = [
  { pattern: /(?:^|[。！？、])([^。！？、]{1,80}?)(?:ないでほしい|ないで欲しい)/u, statement: (value: string) => `ユーザーはシャノンに${value}ないでほしい` },
  { pattern: /(?:^|[。！？、])([^。！？、]{1,80}?)(?:しないでほしい|しないで欲しい)/u, statement: (value: string) => `ユーザーはシャノンに${value}しないでほしい` },
  { pattern: /(?:^|[。！？、])([^。！？、]{1,80}?)(?:してほしい|して欲しい)/u, statement: (value: string) => `ユーザーはシャノンに${value}してほしい` },
  { pattern: /(?:アドバイス|助言)(?:は|が)?(?:いらない|不要)/u, statement: () => 'ユーザーは求めていない時の助言を望まない' },
] as const;

const INTEREST_PATTERNS = [
  { pattern: /(?:^|[。！？、])(?:最近|いま|今)([^。！？、]{1,100}?)(?:に興味がある|が気になっている)/u, statement: (value: string) => value },
] as const;

interface RulePattern {
  pattern: RegExp;
  statement: (value: string) => string;
  accept?: (value: string, text: string) => boolean;
}

function appendRuleProposal(
  proposals: UserFactProposal[],
  text: string,
  pattern: RulePattern,
  kind: 'user-fact' | 'relationship' | 'interest',
): void {
  const match = text.match(pattern.pattern);
  if (!match) return;
  const value = (match[1] ?? '').trim().replace(/[。！？].*$/u, '').slice(0, 100);
  if (match[1] !== undefined && !value) return;
  if (pattern.accept && !pattern.accept(value, text)) return;
  proposals.push({ kind, statement: pattern.statement(value), evidence: text.slice(0, 240) });
}

function directPreferenceValue(value: string): boolean {
  return !/(?:食べ物なら|食べ物だと|たぶん|多分|かも|かな|気がする|彼|彼女|あの人|友達|家族|母|父|兄|姉|弟|妹|さん|くん|ちゃん|何|どれ)/u.test(value);
}

function consolidateProposals(
  proposals: readonly UserFactProposal[],
  source: string,
  current: CompanionStateSnapshot,
  observedAt: string,
  initialConfidence: number,
): ImmediateMemoryOutcome {
  const facts: UserFact[] = [];
  const relationships: RelationshipInsight[] = [];
  const interests: string[] = [];
  for (const proposal of proposals) {
    const kind = proposal.kind ?? 'user-fact';
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    if (!statement || !evidence || !source.includes(evidence)) continue;
    const id = memoryId(kind, statement);
    const control = current.memoryControls.find(item => item.memoryId === id);
    if (control && control.status !== 'active') continue;
    if (conflictingCurrent(current, kind, statement)) continue;
    if (kind === 'user-fact') {
      const previous = current.userFacts.find(item => item.id === id);
      facts.push({
        id, statement,
        confidence: Math.min(0.9, previous ? previous.confidence + 0.08 : initialConfidence),
        observedAt, evidence,
      });
    } else if (kind === 'relationship') {
      const previous = current.relationships.find(item => item.id === id);
      relationships.push({
        id, statement,
        confidence: Math.min(0.9, previous ? previous.confidence + 0.08 : initialConfidence),
        observedAt, evidence,
      });
    } else if (!current.interests.includes(statement)) {
      interests.push(statement);
    }
  }
  return Object.freeze({
    facts: Object.freeze(facts.slice(0, 8)),
    relationships: Object.freeze(relationships.slice(0, 6)),
    interests: Object.freeze(interests.slice(0, 6)),
  });
}

function parseProposalRows(value: unknown, kind: UserFactProposal['kind']): UserFactProposal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Partial<UserFactProposal>;
    return typeof row.statement === 'string' && typeof row.evidence === 'string'
      ? [{ kind, statement: row.statement, evidence: row.evidence }]
      : [];
  });
}

function memoryId(kind: Exclude<MemoryKind, 'experience'>, statement: string): string {
  if (kind === 'interest') return memoryIdentifier(kind, statement);
  return `${kind}-${createHash('sha256').update(statement.toLowerCase()).digest('hex').slice(0, 20)}`;
}

function conflictingCurrent(
  current: CompanionStateSnapshot,
  kind: Exclude<MemoryKind, 'experience'>,
  candidate: string,
): { id: string; text: string } | null {
  if (kind === 'interest') return null;
  const candidatePolarity = polarity(candidate);
  if (candidatePolarity === 0) return null;
  const candidateTopic = topic(candidate);
  const rows = kind === 'user-fact'
    ? current.userFacts.map(item => ({ id: item.id, text: item.statement }))
    : current.relationships.map(item => ({ id: item.id, text: item.statement }));
  return rows.find(row => polarity(row.text) === -candidatePolarity && topic(row.text) === candidateTopic) ?? null;
}

function polarity(value: string): number {
  if (/(苦手|嫌い|いらない|不要|望まない|しないで)/u.test(value)) return -1;
  if (/(好き|好む|ほしい|欲しい|望む|している)/u.test(value)) return 1;
  return 0;
}

function topic(value: string): string {
  return value.replace(/ユーザーは(?:シャノンに)?|が好き|を好む|が苦手|が嫌い|をしている|してほしい|しないでほしい|を望まない|いらない|不要/gu, '')
    .replace(/\s+/g, '').trim();
}

function makeChange(kind: MemoryKind, memoryIdValue: string, text: string, reason: string, evidence: string): SleepChange {
  return { kind, memoryId: memoryIdValue, text, reason, evidence };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function deduplicateProposals(proposals: readonly UserFactProposal[]): UserFactProposal[] {
  const seen = new Set<string>();
  return proposals.flatMap(proposal => {
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    const key = `${proposal.kind ?? 'user-fact'}:${statement.toLowerCase()}`;
    if (!statement || !evidence || seen.has(key)) return [];
    seen.add(key);
    return [{ ...(proposal.kind ? { kind: proposal.kind } : {}), statement, evidence }];
  });
}

function parseJson(raw: string): unknown {
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('OPENAI_SLEEP_NON_JSON'); }
}

function extractOutputText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const direct = (value as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const output = (value as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';
  return output.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as { type?: unknown; text?: unknown };
      return row.type === 'output_text' && typeof row.text === 'string' ? [row.text] : [];
    });
  }).join('').trim();
}
