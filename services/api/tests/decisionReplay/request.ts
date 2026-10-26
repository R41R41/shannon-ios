import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicFcaModel } from '../../src/infra/models/anthropic/anthropicFcaModel.js';
import * as historyModule from '../../src/infra/models/anthropic/anthropicFcaHistory.js';
import { anthropicFcaHistoryCodec } from '../../src/infra/models/anthropic/anthropicFcaHistory.js';
/** mb-llmc-cand 10 の木は、bootstrap を読める行にする codec（anthropicFcaHistoryCodecV2）を持つ。前の木は持たない。 */
const BOOTSTRAP_CODEC = ((historyModule as Record<string, unknown>).anthropicFcaHistoryCodecV2 ?? anthropicFcaHistoryCodec) as typeof anthropicFcaHistoryCodec;
import { FCA_TRANSIENT_BETAS } from '../../src/infra/models/anthropic/anthropicFcaTransient.js';
import { LLMC_SYSTEM_APPENDIX } from '../../src/surfaces/minecraft/minecraftKnowledge.js';
import { llmcCoreKnowledge } from '../../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { shortActTool, slimTools, splitKnowledge, type Slim } from './slim.js';
import { REWRITE_LEGEND } from './rewriteLive.js';
import type { FcaToolDefinition } from '../../src/mind/action/fca/fcaPorts.js';
import type { Decision, Entry } from './load.js';

/**
 * 判断 1 回の要求の組み立て。system と道具は本番の部品（createAnthropicFcaModel）が作ったものをそのまま取り、
 * messages だけを DB に残った履歴（その判断が受け取った live まで）から作る。
 */
export const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;

/** 「短い出力」: 考えを 2〜3 文、act を 1 つ。専用の指示文（SHANNON_MINECRAFT_OWN_PROMPT）の最後に足す一節（本番のコードではなく再現台の中だけにある）。 */
export const SHORT_OUTPUT_RULE = [
  '## Output length',
  'Keep your reasoning to 2-3 short sentences. Then call mc.act exactly once (or the one other tool the situation needs), with every hand you can already decide; write no prose after the call.',
].join('\n');

/** r10 の「止まったら」の行（minecraftKnowledgeCore.ts）と、その前の行。v1・v2 の要求は前の行のまま（前の結果を使うので）、v4 から r10 の行。 */
export const KNOWLEDGE_R10 = '「一歩ではない」は頭の高さが固い（walk は掘らない: 先に dig）か段差 2 以上（pillarUp か dig で段を作る）、'
  + '「届かない」は dig が足から 4.5m まで（歩かない: dig→walk 1 歩を交互に）、「掘れない」は道具か X、';
export const KNOWLEDGE_R9 = '「一歩ではない」は段差 2 以上か着いていない（pillarUp か dig で段を作る）、「届かない」は 4.5m 内へ寄る、「掘れない」は道具か X、';

export interface Variant {
  id: string; label: string; model: string;
  /** SHANNON_MINECRAFT_OWN_PROMPT=on: the Minecraft body task's own instructions (3008876 + origin/feat/minecraft-own-prompt). */
  ownPrompt: boolean; shortOutput: boolean; effort?: 'low' | 'medium' | 'high';
  /** 10/23: r10 の頭（知識の行 + 止まりの補足 H3 + 線上のマス H5 を live と履歴に足す）。 */
  r10?: boolean;
  /** 10/23: 送る前の守りをかけ、止めた答えは事実を返してもう 1 回だけ聞き直す。 */
  preflight?: boolean;
  /** 10/23: thinking を切る（既定は adaptive）。 */
  thinkingOff?: boolean;
  /** 10/23 v8: 絞った形（道具・知識の段・履歴・短い出力）。 */
  slim?: Slim;
  /** 10/23 v9: 書き直した live（rewriteLive.ts）を渡す版。指示文に、足した欄の読み方（REWRITE_LEGEND）を足す。 */
  legend?: boolean;
  /** 10/23 v10: 候補の版（candidateAdapter.ts を通る。指示文・道具・live・短い書き方・守りは候補の頭が作る）。 */
  cand?: boolean;
}
/** 比べる版。足すときはここに 1 行（上げる条件の違い、Haiku など）。 */
export const VARIANTS: readonly Variant[] = [
  { id: 'v1', label: '今の本番: Opus 5.5 + 今の指示文', model: MODELS.opus, ownPrompt: false, shortOutput: false },
  { id: 'v2', label: 'Opus 5.5 + 専用の指示文 + 短い出力', model: MODELS.opus, ownPrompt: true, shortOutput: true },
  { id: 'v3', label: 'Sonnet 5.5 + 専用の指示文 + 短い出力', model: MODELS.sonnet, ownPrompt: true, shortOutput: true },
  { id: 'v4', label: 'v2 + r10 の頭（止まりの補足・線上のマス・知識の 1 行）', model: MODELS.opus, ownPrompt: true, shortOutput: true, r10: true },
  { id: 'v5', label: 'v4 + 送る前の守り（止めたら事実を返して 1 回聞き直し）', model: MODELS.opus, ownPrompt: true, shortOutput: true, r10: true, preflight: true },
  // Opus 5.5 は thinking を切れない（disabled も tool_choice 固定も 400）。effort は low が最低で、v1〜v5 はもう low。考えの量の違いは effort high で見る。
  { id: 'v6', label: 'v4 の effort を high にした版（thinking は切れない）', model: MODELS.opus, ownPrompt: true, shortOutput: true, r10: true, effort: 'high' },
  { id: 'v7', label: 'Sonnet 5.5 + v5', model: MODELS.sonnet, ownPrompt: true, shortOutput: true, r10: true, preflight: true },
  // v8（絞った形）: v4 の上に 4 つの絞りを 1 つずつ足す。
  { id: 'v8a', label: 'v8a v4 + 道具を 6 つに', model: MODELS.opus, ownPrompt: true, shortOutput: true, r10: true, slim: { tools: true } },
  { id: 'v8b', label: 'v8b + 知識の段を場面で選ぶ', model: MODELS.opus, ownPrompt: true, shortOutput: true, r10: true, slim: { tools: true, knowledge: true } },
  { id: 'v8c', label: 'v8c + 履歴を要約 + 直近 3〜8 回', model: MODELS.opus, ownPrompt: true, shortOutput: true, r10: true, slim: { tools: true, knowledge: true, history: true } },
  { id: 'v8d', label: 'v8d + 手を短い書き方に（全部入り）', model: MODELS.opus, ownPrompt: true, shortOutput: true, r10: true, slim: { tools: true, knowledge: true, history: true, short: true } },
  // v9（書き直した live、10/23 の 3 つ目の依頼）: v2（専用の指示文 + 短い出力、r10 なし）の上に live だけを書き直す。
  { id: 'v9b', label: 'v9b v2 + 書き直した live（周り・道・敵 1 行・地図の層をそろえる）', model: MODELS.opus, ownPrompt: true, shortOutput: true, legend: true },
  { id: 'v9c', label: 'v9c v9b + 手の短い書き方', model: MODELS.opus, ownPrompt: true, shortOutput: true, legend: true, slim: { short: true } },
  // v10（候補の版の確かめ）: v1 = 今の本番（上）を基準にして、cand = 候補の頭（mb-llmc-cand）。cand の要求は candidateAdapter.ts が作る（できるまでは投げる）。
  { id: 'cand', label: 'cand 候補の版（改修案 2.1〜2.4: 専用の指示文・道具 6 つ・書き直した live・短い書き方・守り）', model: MODELS.opus, ownPrompt: true, shortOutput: false, cand: true },
];

/** The console as it was when this module loaded (captureBase silences it while production code logs, and may overlap with another capture). */
const ORIGINAL_CONSOLE = { info: console.info, warn: console.warn, error: console.error, log: console.log };
type Capture = { body: Record<string, any>; headers: Record<string, string> };
const baseCache = new Map<string, Capture>();

/** The request a decision of the mode would send for an empty history, captured at the transport. Its system, tools and fixed fields are reused. */
let captureLock: Promise<unknown> = Promise.resolve();
function captureBase(variant: Variant, core: readonly FcaToolDefinition[]): Promise<Capture> {
  // One at a time: the capture silences the console while production code logs.
  const next = captureLock.then(() => captureOnce(variant, core), () => captureOnce(variant, core));
  captureLock = next;
  return next;
}
async function captureOnce(variant: Variant, core: readonly FcaToolDefinition[]): Promise<Capture> {
  if (variant.cand) throw new Error('DECISION_REPLAY_CANDIDATE_NOT_WIRED: cand は candidateAdapter.ts を通る（run6.ts）');
  const key = `${variant.model}|${variant.ownPrompt}|${variant.shortOutput}|${variant.effort ?? ''}|${variant.r10 ? 'r10' : 'r9'}|${variant.thinkingOff ? 'nothink' : ''}|${JSON.stringify(variant.slim ?? {})}|${variant.legend ? 'legend' : ''}|${createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 12)}`;
  const cached = baseCache.get(key);
  if (cached) return cached;
  let captured: Capture | null = null;
  const client = { messages: { create(body: Record<string, any>, options: { headers?: Record<string, string> }) {
    captured = { body: JSON.parse(JSON.stringify(body)), headers: options.headers ?? {} };
    return Promise.reject(new Error('captured'));
  } } };
  const model = createAnthropicFcaModel({ model: variant.model, client: client as never, recordUsage() {},
    systemAppendix: variant.ownPrompt ? (variant.slim?.knowledge ? splitKnowledge().always : llmcCoreKnowledge()) : LLMC_SYSTEM_APPENDIX, ...(variant.ownPrompt ? { minecraftOwnPrompt: true } : {}) });
  console.info = console.warn = console.error = console.log = () => undefined;
  try {
    await model.decide({ task: { id: 'replay', title: 'replay', goal: 'エンドラを討伐してください', completionCriteria: 'replay' }, messages: [], children: [], history: [],
      tools: core, coreTools: core, transient: {} }, new AbortController().signal);
  } catch { /* the transport refuses on purpose */ }
  Object.assign(console, ORIGINAL_CONSOLE);
  if (!captured) throw new Error('DECISION_REPLAY_CAPTURE_FAILED');
  const base = captured as Capture;
  const system = base.body.system as Array<{ text: string; cache_control?: unknown }>;
  if (!variant.r10 && variant.ownPrompt) for (const block of system) block.text = block.text.replace(KNOWLEDGE_R10, KNOWLEDGE_R9);
  if (variant.shortOutput) system[1]!.text = `${system[1]!.text}\n\n${SHORT_OUTPUT_RULE}`;
  if (variant.legend) system[1]!.text = `${system[1]!.text}\n\n${REWRITE_LEGEND}`;
  base.body.output_config = { effort: variant.effort ?? 'low' };
  if (variant.slim?.tools) base.body.tools = slimTools(base.body.tools as Array<{ name: string }>);
  if (variant.slim?.short) base.body.tools = (base.body.tools as Array<{ name: string }>).map(tool => tool.name === 'mc_act' ? shortActTool() : tool);
  if (variant.thinkingOff) {
    base.body.thinking = { type: 'disabled' };
    delete base.body.output_config;
  }
  baseCache.set(key, base);
  return base;
}

/** A replayed history with the signed thinking blocks taken out (they are bound to the model and the instructions that made them). */
export function withoutThinking(entries: readonly Entry[]): Entry[] {
  return entries.map(entry => {
    if (entry.role !== 'assistant' || !Array.isArray(entry.content)) return entry;
    return { ...entry, content: (entry.content as Array<{ type: string }>).filter(block => block.type !== 'thinking' && block.type !== 'redacted_thinking') };
  });
}

export interface SceneMessages { messages: Entry[]; epochRows: number; bootstrap: boolean }
/** 版ごとに入力を作り替える物（v4 以降: r10 の頭が履歴と live に足す物 `r10Live.ts`）と、判断の後ろに足すやり取り（守りの聞き直し）。 */
export interface SceneRewrite { rows?: Entry[][]; turn?: Entry[]; extra?: Entry[]; history?: Entry[] }
/** The messages of the decision: the epoch's bootstrap (when it has one), the epoch's earlier rounds, then this decision's turn (state message and live). */
export function sceneMessages(decision: Decision, bootstrapText: string | null, keepThinking = false, rewrite: SceneRewrite = {}): SceneMessages {
  const rows = decision.run.rows.slice(decision.epochStart, decision.index);
  const entries = rewrite.rows ? rewrite.rows.flat() : rows.flatMap(row => row.entries);
  // 履歴をまるごと作り替える版（v8 の圧縮）は bootstrap も使わない。
  const history = rewrite.history ?? [...(bootstrapText ? BOOTSTRAP_CODEC.bootstrap(bootstrapText) as Entry[] : []), ...entries];
  return { messages: [...keepThinking ? history : withoutThinking(history), ...(rewrite.turn ?? decision.turn), ...(rewrite.extra ?? [])], epochRows: rows.length, bootstrap: !!bootstrapText };
}

/** The cache marks: system[0], system[1] and the last block of the last user message (a system message after it is skipped), as `cacheFcaBodyRequest`. */
export function markCache<T extends Record<string, any>>(body: T, ttl: '5m' | '1h', alsoAt?: number): T {
  const mark = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const system = (body.system as Array<Record<string, any>>).map(block => ({ ...block, cache_control: mark }));
  const messages = [...body.messages] as Array<Record<string, any>>;
  // The previous scene of the same epoch wrote its prefix up to this message: marking it again makes this request read that prefix (the provider
  // looks back only about 20 blocks for an earlier write, and scenes lie several rounds apart; production decisions are one round apart).
  if (alsoAt !== undefined && messages[alsoAt]?.role === 'user' && Array.isArray(messages[alsoAt]!.content)) {
    const blocks = [...messages[alsoAt]!.content];
    blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: mark };
    messages[alsoAt] = { ...messages[alsoAt], content: blocks };
  }
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.role === 'system') index -= 1;
  const message = messages[index];
  if (message?.role === 'user' && Array.isArray(message.content)) {
    const blocks = [...message.content];
    blocks[blocks.length - 1] = { ...blocks.at(-1), cache_control: mark };
    messages[index] = { ...message, content: blocks };
  }
  return { ...body, system, messages };
}

export interface BuiltRequest { body: Record<string, any>; headers: Record<string, string>; epochRows: number; bootstrap: boolean }
export async function buildRequest(variant: Variant, decision: Decision, core: readonly FcaToolDefinition[], bootstrapText: string | null,
  ttl: '5m' | '1h' = '5m', keepThinking = false, previous?: Decision, rewrite: SceneRewrite = {}): Promise<BuiltRequest> {
  const base = await captureBase(variant, core);
  const { messages, epochRows, bootstrap } = sceneMessages(decision, bootstrapText, keepThinking, rewrite);
  const { messages: _empty, ...fixed } = base.body;
  // The message the previous scene (same epoch) marked: the last one before its live state.
  const alsoAt = previous && previous.run === decision.run && previous.epochStart === decision.epochStart && previous.index < decision.index
    ? sceneMessages(previous, bootstrapText, keepThinking).messages.length - 2 : undefined;
  const body = markCache({ ...fixed, model: variant.model, messages }, ttl, alsoAt);
  return { body, headers: { 'anthropic-beta': base.headers['anthropic-beta'] ?? FCA_TRANSIENT_BETAS }, epochRows, bootstrap };
}

/** A fresh client for the replay (no SDK retries: one request, one answer). */
export function replayClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000 });
}
