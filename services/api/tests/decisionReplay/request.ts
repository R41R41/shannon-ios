import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicFcaModel } from '../../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../../src/infra/models/anthropic/anthropicFcaHistory.js';
import { FCA_TRANSIENT_BETAS } from '../../src/infra/models/anthropic/anthropicFcaTransient.js';
import { llmcSystemAppendix } from '../../src/surfaces/minecraft/minecraftKnowledge.js';
import { llmcCoreKnowledge } from '../../src/surfaces/minecraft/minecraftKnowledgeCore.js';
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

export interface Variant {
  id: string; label: string; model: string;
  /** SHANNON_MINECRAFT_OWN_PROMPT=on: the Minecraft body task's own instructions (3008876 + origin/feat/minecraft-own-prompt). */
  ownPrompt: boolean; shortOutput: boolean; effort?: 'low' | 'medium' | 'high';
}
/** 比べる版。足すときはここに 1 行（上げる条件の違い、Haiku など）。 */
export const VARIANTS: readonly Variant[] = [
  { id: 'v1', label: '今の本番: Opus 5.5 + 今の指示文', model: MODELS.opus, ownPrompt: false, shortOutput: false },
  { id: 'v2', label: 'Opus 5.5 + 専用の指示文 + 短い出力', model: MODELS.opus, ownPrompt: true, shortOutput: true },
  { id: 'v3', label: 'Sonnet 5.5 + 専用の指示文 + 短い出力', model: MODELS.sonnet, ownPrompt: true, shortOutput: true },
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
  const key = `${variant.model}|${variant.ownPrompt}|${variant.shortOutput}|${variant.effort ?? ''}|${createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 12)}`;
  const cached = baseCache.get(key);
  if (cached) return cached;
  let captured: Capture | null = null;
  const client = { messages: { create(body: Record<string, any>, options: { headers?: Record<string, string> }) {
    captured = { body: JSON.parse(JSON.stringify(body)), headers: options.headers ?? {} };
    return Promise.reject(new Error('captured'));
  } } };
  const model = createAnthropicFcaModel({ model: variant.model, client: client as never, recordUsage() {},
    systemAppendix: variant.ownPrompt ? llmcCoreKnowledge(true) : llmcSystemAppendix(true), ...(variant.ownPrompt ? { minecraftOwnPrompt: true } : {}) });
  console.info = console.warn = console.error = console.log = () => undefined;
  try {
    await model.decide({ task: { id: 'replay', title: 'replay', goal: 'エンドラを討伐してください', completionCriteria: 'replay' }, messages: [], children: [], history: [],
      tools: core, coreTools: core, transient: {} }, new AbortController().signal);
  } catch { /* the transport refuses on purpose */ }
  Object.assign(console, ORIGINAL_CONSOLE);
  if (!captured) throw new Error('DECISION_REPLAY_CAPTURE_FAILED');
  const base = captured as Capture;
  const system = base.body.system as Array<{ text: string; cache_control?: unknown }>;
  if (variant.shortOutput) system[1]!.text = `${system[1]!.text}\n\n${SHORT_OUTPUT_RULE}`;
  base.body.output_config = { effort: variant.effort ?? 'low' };
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
/** The messages of the decision: the epoch's bootstrap (when it has one), the epoch's earlier rounds, then this decision's turn (state message and live). */
export function sceneMessages(decision: Decision, bootstrapText: string | null, keepThinking = false): SceneMessages {
  const rows = decision.run.rows.slice(decision.epochStart, decision.index);
  const history = [...(bootstrapText ? anthropicFcaHistoryCodec.bootstrap(bootstrapText) as Entry[] : []), ...rows.flatMap(row => row.entries)];
  return { messages: [...keepThinking ? history : withoutThinking(history), ...decision.turn], epochRows: rows.length, bootstrap: !!bootstrapText };
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
  ttl: '5m' | '1h' = '5m', keepThinking = false, previous?: Decision): Promise<BuiltRequest> {
  const base = await captureBase(variant, core);
  const { messages, epochRows, bootstrap } = sceneMessages(decision, bootstrapText, keepThinking);
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
