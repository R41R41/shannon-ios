import { createHash } from 'node:crypto';
import type { CompanionStateSnapshot, UserFact } from '@shannon/cognition';
import type { DailyUserMessage } from './backgroundJobStore.js';

export interface UserFactProposal {
  statement: string;
  evidence: string;
}

export interface SleepMemoryAnalyzer {
  readonly mode: 'openai' | 'local-rules';
  analyze(messages: readonly DailyUserMessage[]): Promise<readonly UserFactProposal[]>;
}

export class LocalRuleSleepMemoryAnalyzer implements SleepMemoryAnalyzer {
  readonly mode = 'local-rules' as const;

  async analyze(messages: readonly DailyUserMessage[]): Promise<readonly UserFactProposal[]> {
    const proposals: UserFactProposal[] = [];
    for (const message of messages) {
      const text = message.content.replace(/\s+/g, ' ').trim().slice(0, 2_000);
      for (const pattern of EXPLICIT_FACT_PATTERNS) {
        const match = text.match(pattern.pattern);
        const value = match?.[1]?.trim().replace(/[。！？].*$/u, '').slice(0, 100);
        if (!value || value.length < 1) continue;
        proposals.push({ statement: pattern.statement(value), evidence: text.slice(0, 240) });
      }
    }
    return deduplicateProposals(proposals).slice(0, 8);
  }
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
            name: 'shannon_sleep_facts',
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
              },
              required: ['facts'],
            },
          },
        },
        max_output_tokens: 700,
        store: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) throw new Error(`OPENAI_SLEEP_RESPONSE_${response.status}`);
    const output = parseJson(extractOutputText(json));
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('OPENAI_SLEEP_OUTPUT_INVALID');
    const facts = (output as { facts?: unknown }).facts;
    if (!Array.isArray(facts)) throw new Error('OPENAI_SLEEP_OUTPUT_INVALID');
    return deduplicateProposals(facts.flatMap(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const row = value as Partial<UserFactProposal>;
      return typeof row.statement === 'string' && typeof row.evidence === 'string'
        ? [{ statement: row.statement, evidence: row.evidence }]
        : [];
    })).slice(0, 8);
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
  const proposals = await analyzer.analyze(messages);
  const source = messages.map(message => normalize(message.content)).join('\n');
  return Object.freeze(proposals.flatMap(proposal => {
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    if (!statement || !evidence || !source.includes(evidence)) return [];
    const id = `user-fact-${createHash('sha256').update(statement.toLowerCase()).digest('hex').slice(0, 20)}`;
    const previous = current.userFacts.find(fact => fact.id === id);
    return [Object.freeze({
      id,
      statement,
      confidence: Math.min(0.85, previous ? previous.confidence + 0.1 : 0.55),
      observedAt,
      evidence,
    })];
  }).slice(0, 8));
}

const SLEEP_INSTRUCTIONS = `その日のユーザー発言を振り返り、ユーザーが明示した持続的な情報だけを抽出する。
推測、診断、センシティブ属性、秘密、現在だけの気分、シャノンの発言由来の情報は含めない。
evidenceは入力中に完全一致する短いユーザー発言をそのまま返す。確信がなければfactsを空にする。`;

const EXPLICIT_FACT_PATTERNS = [
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:が好き|を好む)/u, statement: (value: string) => `ユーザーは${value}が好き` },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:が苦手|が嫌い)/u, statement: (value: string) => `ユーザーは${value}が苦手` },
  { pattern: /(?:僕は|私は|自分は)(?:、)?(.{1,100}?)(?:をしている|をやっている)/u, statement: (value: string) => `ユーザーは${value}をしている` },
] as const;

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function deduplicateProposals(proposals: readonly UserFactProposal[]): UserFactProposal[] {
  const seen = new Set<string>();
  return proposals.flatMap(proposal => {
    const statement = normalize(proposal.statement).slice(0, 160);
    const evidence = normalize(proposal.evidence).slice(0, 240);
    const key = statement.toLowerCase();
    if (!statement || !evidence || seen.has(key)) return [];
    seen.add(key);
    return [{ statement, evidence }];
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
