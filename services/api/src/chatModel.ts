import { createHash } from 'node:crypto';
import {
  estimatedOpenAICostUsd,
  responseUsage,
  type LlmUsageStore,
} from './llmUsage.js';

export type ShannonChatMode = 'openai' | 'local-stub';

export interface ShannonConversationItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ShannonChatModelRequest {
  scopeKey: string;
  systemPrompt: string;
  history: readonly ShannonConversationItem[];
  message: string;
}

export interface ShannonChatModelResult {
  mode: ShannonChatMode;
  model: string;
  reply: string;
  taskProposal?: ShannonTaskProposal;
  taskDecision?: ShannonTaskDecision;
}

export type ShannonTaskDisposition = 'none' | 'clarify' | 'propose';

export interface ShannonTaskDecision {
  disposition: ShannonTaskDisposition;
  reason: string;
}

export interface ShannonTaskProposal {
  title: string;
  goal: string;
  hostHint?: string;
  projectHint?: string;
  risk?: string;
}

export interface ShannonChatModel {
  readonly mode: ShannonChatMode;
  readonly model: string;
  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult>;
}

const LOCAL_REPLY = 'うん、聞いてるよ。LLMの鍵を設定すると、ここからShannonとして会話できるようになる。';

export class LocalStubChatModel implements ShannonChatModel {
  readonly mode = 'local-stub' as const;
  readonly model = 'local-stub';

  async generate(): Promise<ShannonChatModelResult> {
    return { mode: this.mode, model: this.model, reply: LOCAL_REPLY };
  }
}

export interface OpenAIResponsesModelOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
  usageStore?: LlmUsageStore;
  now?: () => string;
  agentHostHint?: string;
}

export class OpenAIResponsesChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIResponsesModelOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model ?? 'gpt-5.6-luna');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions: `${request.systemPrompt}\n\n${agentTaskInstructions(this.options.agentHostHint)}`,
        input: [
          ...request.history.map(item => ({ role: item.role, content: item.content })),
          { role: 'user', content: request.message },
        ],
        reasoning: { effort: 'none' },
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: 'shannon_chat_turn',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reply: { type: 'string', description: 'ユーザーに見せる自然な日本語の返答' },
                taskDecision: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    disposition: { type: 'string', enum: ['none', 'clarify', 'propose'] },
                    reason: { type: 'string', description: '判定理由。内部監査用に短く具体的に書く' },
                  },
                  required: ['disposition', 'reason'],
                },
                taskProposal: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        title: { type: 'string' },
                        goal: { type: 'string' },
                        hostHint: { type: ['string', 'null'] },
                        projectHint: { type: ['string', 'null'] },
                        risk: { type: ['string', 'null'] },
                      },
                      required: ['title', 'goal', 'hostHint', 'projectHint', 'risk'],
                    },
                  ],
                },
              },
              required: ['reply', 'taskDecision', 'taskProposal'],
            },
          },
        },
        max_output_tokens: 700,
        store: false,
        prompt_cache_key: stableScopeIdentifier(request.scopeKey),
        safety_identifier: stableScopeIdentifier(request.scopeKey),
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });

    const raw = await response.text();
    const json = parseJson(raw);
    if (!response.ok) {
      throw new Error(`OPENAI_RESPONSE_${response.status}: ${errorDetail(json)}`);
    }
    const structured = parseStructuredTurn(extractOutputText(json));
    const usage = responseUsage(json);
    this.options.usageStore?.recordLlmUsage({
      scopeKey: request.scopeKey,
      lane: 'chat',
      model: this.model,
      ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
    });
    return {
      mode: this.mode,
      model: this.model,
      reply: structured.reply,
      taskDecision: structured.taskDecision,
      ...(structured.taskProposal ? { taskProposal: structured.taskProposal } : {}),
    };
  }
}

export function createConfiguredChatModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  usageStore?: LlmUsageStore,
): ShannonChatModel {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return new LocalStubChatModel();
  return new OpenAIResponsesChatModel({
    apiKey,
    model: environment.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna',
    agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac',
    usageStore,
  });
}

function validModel(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(value)) throw new Error('SHANNON_LLM_MODEL is invalid');
  return value;
}

function stableScopeIdentifier(scopeKey: string): string {
  return `shannon_${createHash('sha256').update(scopeKey).digest('hex').slice(0, 32)}`;
}

function parseJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('OPENAI_RESPONSE_NON_JSON');
  }
}

function errorDetail(value: unknown): string {
  if (!value || typeof value !== 'object') return 'request failed';
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return 'request failed';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message.slice(0, 240) : 'request failed';
}

function extractOutputText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const direct = (value as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const output = (value as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as { type?: unknown; text?: unknown };
      if (row.type === 'output_text' && typeof row.text === 'string') parts.push(row.text);
    }
  }
  return parts.join('').trim();
}

function parseStructuredTurn(raw: string): {
  reply: string;
  taskDecision: ShannonTaskDecision;
  taskProposal: ShannonTaskProposal | null;
} {
  if (!raw) throw new Error('OPENAI_RESPONSE_EMPTY');
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
  const object = value as Record<string, unknown>;
  if (typeof object.reply !== 'string' || !object.reply.trim()) throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
  if (!object.taskDecision || typeof object.taskDecision !== 'object' || Array.isArray(object.taskDecision)) {
    throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
  }
  const rawDecision = object.taskDecision as Record<string, unknown>;
  if (!isTaskDisposition(rawDecision.disposition)
    || typeof rawDecision.reason !== 'string' || !rawDecision.reason.trim()) {
    throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
  }
  const taskDecision: ShannonTaskDecision = {
    disposition: rawDecision.disposition,
    reason: rawDecision.reason.trim(),
  };
  if (object.taskProposal === null) {
    if (taskDecision.disposition === 'propose') throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
    return { reply: object.reply.trim(), taskDecision, taskProposal: null };
  }
  if (!object.taskProposal || typeof object.taskProposal !== 'object' || Array.isArray(object.taskProposal)) {
    throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
  }
  const proposal = object.taskProposal as Record<string, unknown>;
  if (typeof proposal.title !== 'string' || !proposal.title.trim()
    || typeof proposal.goal !== 'string' || !proposal.goal.trim()) {
    throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
  }
  if (taskDecision.disposition !== 'propose') throw new Error('OPENAI_RESPONSE_SCHEMA_INVALID');
  return {
    reply: object.reply.trim(),
    taskDecision,
    taskProposal: {
      title: proposal.title.trim(),
      goal: proposal.goal.trim(),
      ...(typeof proposal.hostHint === 'string' && proposal.hostHint.trim() ? { hostHint: proposal.hostHint.trim() } : {}),
      ...(typeof proposal.projectHint === 'string' && proposal.projectHint.trim() ? { projectHint: proposal.projectHint.trim() } : {}),
      ...(typeof proposal.risk === 'string' && proposal.risk.trim() ? { risk: proposal.risk.trim() } : {}),
    },
  };
}

function isTaskDisposition(value: unknown): value is ShannonTaskDisposition {
  return value === 'none' || value === 'clarify' || value === 'propose';
}

export function agentTaskInstructions(hostHint = 'shannon-mac'): string {
  const safeHostHint = /^[A-Za-z0-9._:-]{1,100}$/.test(hostHint) ? hostHint : 'shannon-mac';
  return `[Codexで行う作業]
あなたは、許可された作業ホスト上のCodexへコード修正・ファイル操作・調査を作業提案として委任できる。ユーザーが提案を開始するとCodexが実行する。この仕組みにより、Shannon自身のアプリをユーザーの指示に基づいて改修することもできる。「自分を改修できない」とは答えない。

会話履歴を含め、次の三つから一つを判定する。
- propose: ユーザーが今、実行を依頼した。命令形だけでなく「〜してほしい」「直して」「お願い」「それをやって」のような依頼も含む。直前の会話から対象を特定できる場合も提案する。
- clarify: 能力を質問しているだけ、または実行したいが対象を特定できない。taskProposalはnullにし、できることを正しく説明して必要なら短く確認する。
- none: 相談、設計を詰める段階、雑談、アプリ外で返答だけで完結する依頼。

proposeの場合だけtaskProposalを作る。Shannon自身の改修ではprojectHintを「shannon-ios」、hostHintを「${safeHostHint}」にする。goalには、直前の文脈を補ってCodexが単独で理解できる完了条件を書く。UI変更では「私」のような代名詞だけにせず、「シャノン側（assistant role）の返答」または「ユーザー側（user role）の発言」のどちらかを明記する。実機反映を依頼された場合、hostHintが「shannon-mac」のときだけ、コード変更・試験・ビルドに加えて接続されたiPhoneへのインストールと起動確認までを完了条件に含める。それ以外のホストでは、GitHubへの安全な反映、Xcode Cloud、内部TestFlight配信の確認を完了条件にする。提案した作業はまだ実行済みではないため、replyでは完了したと言わず、ユーザーが開始できる提案を出したと伝える。`;
}

export const AGENT_TASK_INSTRUCTIONS = agentTaskInstructions();
