import { vi } from 'vitest';
import type { PlanNode, PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../../src/contracts/minecraftProbeContract.js';
import type { ActInput } from '../../src/contracts/minecraftActContract.js';
import { createAnthropicFcaModel } from '../../src/infra/models/anthropic/anthropicFcaModel.js';
import type { FcaBodyLifecycle, FcaModelInput, FcaToolDefinition } from '../../src/mind/action/fca/fcaPorts.js';
import { llmcCoreKnowledge } from '../../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { forgetLlmcEvents, withLlmcBody } from '../../src/surfaces/minecraft/minecraftLlmcBody.js';
import type { LlmcQueue } from '../../src/surfaces/minecraft/minecraftLlmcQueueBody.js';
import { queueLines, type QueueWordsItem } from '../../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { candidateMenuTools, minecraftV2Hooks } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { message, scriptedAnthropic } from '../support/anthropicFixtures.js';
import { layersMap } from '../support/minecraftMaps.js';
import { LLMC_TOOLS } from '../support/minecraftBodyRequests.js';
import { v2tree } from './planTreeV2.js';
import type { ProbeLine } from '../../../../tools/continue-verify/judge.js';

/**
 * Bench D of the continue contract (chapter 10, boundary 10): what the model's LAST REQUEST holds, without calling the API. The head is run as it runs for a decision, from the
 * body's frames to the bytes: the lifecycle (`withLlmcBody`: the blows' watch, the facts, the queue's lines, the facts said once), the live state, the model's request builder
 * (`createAnthropicFcaModel`, whose client is `recordedClient`), and a `fetch` that keeps the body it was handed and answers with a scripted message. What is returned is
 * the bytes the request was made of; nothing leaves the process.
 *
 * `state` is the scene of `measure/urgent-max-input.json` (`input.state`): health, hunger, the food she carries, the blows of the last seconds and who stood near, the body's
 * holder and life, the promises, the queue, the free slots, the food near, and the filler that makes the input as long as it gets.
 */
export type Variant = 'normal' | 'urgent' | 'compressed';
export interface MaxState {
  hp: number; food: number; saturation: number; foods: { item: string; count: number }[];
  hits: { t: number; amount: number; by?: string }[];
  holder: Record<string, unknown>; life: number;
  promises: { id: number; line: string }[];
  queue: { item: string; state: string; effect: string; leftS?: number }[];
  free: number; foodCandidates: { name: string; id: number; distance: number }[];
  filler?: { resultChars: number; liveLines: number; nearMobs: number };
}
export interface ExtractOptions {
  state: MaxState; variant: Variant; taskId?: string;
  /** The promises as the plan holds them (the lines the fixture shows are the lines these make). */
  promises?: PlanPromise[];
  /** The model's `compactAboveTokens` (the whole request's bound; the compressed variant sets a small one). */
  compactAboveTokens?: number;
  /** Extra inventory stacks (name, count): the pack is filled to `state.free` free slots with others. */
  inventory?: { name: string; count: number }[];
  /** Hands of the queue's open items (the second is waiting). */
  hands?: ActInput[];
  /** A result text of an act, shown once (the filler's long result is added to it). */
  results?: string[];
  /** The receipts' `result` JSON of acts that ended after the last decision (the queue tells them to the lifecycle: `onRan`). */
  ran?: string[];
  /** A dragon plan (the meter is the dragon plan's); the seconds since the task began on the wall clock, and the time it was held (ms). */
  dragon?: boolean; wallSeconds?: number; heldMs?: number;
}
export interface Extracted {
  /** The request's body as `fetch` was handed it (a JSON string). */
  bytes: string;
  /** The request's last message: the live state as the model reads it (the JSON text, and parsed). */
  lastMessage: string;
  live: Record<string, any>;
  request: Record<string, any>;
  /** The live state the lifecycle handed over, before the model's rewrite. */
  raw: Record<string, any>;
}

const T0 = Date.parse('2026-10-28T12:00:00Z');
const PROBE: FcaToolDefinition = { name: 'mc.probe', description: PROBE_DESCRIPTION, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  nativeInputSchema: PROBE_INPUT_SCHEMA, domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };

const NODES: PlanNode[] = [
  { id: 'p1', parentId: null, order: 0, title: '地下の準備', state: 'continue', kind: 'prep_descent' } as PlanNode,
  { id: 'p1.1', parentId: 'p1', order: 0, title: '黒曜石を集める', state: 'continue', kind: 'obsidian' } as PlanNode,
];

/** The pack of the scene: the food and the named stacks, and filler stacks so that exactly `free` slots are free. */
function inventoryOf(state: MaxState, extra: { name: string; count: number }[]): { name: string; count: number }[] {
  const stacks = [...state.foods.map(food => ({ name: food.item, count: food.count })), ...extra];
  const target = 36 - state.free;
  for (let index = 0; stacks.length < target; index += 1) stacks.push({ name: `junk_item_${index}`, count: 1 });
  return stacks.slice(0, Math.max(target, extra.length + state.foods.length));
}

/** One frame of the body at `health`, with the zombie of the scene at `distance`. */
function frameOf(options: ExtractOptions, sequence: number, health: number, zombieAt: number): BodyObservation {
  const { state } = options;
  const filler = state.filler ?? { resultChars: 0, liveLines: 0, nearMobs: 0 };
  const x = 170.5, y = -18, z = 236.5;
  const animals = state.foodCandidates.map(item => ({ name: item.name, id: item.id, kind: 'passive', distance: item.distance, position: { x: x + item.distance, y, z } }));
  const mobs = Array.from({ length: filler.nearMobs }, (_, index) => ({ name: index % 2 ? 'villager' : 'bat', id: 7000 + index, kind: 'passive', distance: 5 + index, position: { x: x + 5 + index, y, z } }));
  const zombie = { name: 'zombie', id: 2601, kind: 'hostile', distance: zombieAt, position: { x: x + zombieAt, y, z }, canReachMe: true, canSee: true };
  const world = { position: { x, y, z }, health, food: state.food, saturation: state.saturation, dimension: 'overworld', localMap: layersMap({ x: 170, y: -18, z: 236 }),
    mapLandmarks: Array.from({ length: Math.min(12, filler.liveLines) }, (_, index) => `F かまど (${180 + index},-18,236) 東${10 + index}`),
    recentStops: Array.from({ length: Math.min(5, filler.liveLines) }, (_, index) => `dig (${index},-18,236) 掘れない`),
    inventory: inventoryOf(state, options.inventory ?? []), nearbyThreats: [zombie], nearbyEntities: [...animals, ...mobs] };
  return { schemaVersion: 1, bodyId: 'minecraft:test', sequence, stateAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), connected: true,
    state: { world: world as never, life: { life: state.life, alive: true, since: new Date(T0 - 600_000).toISOString(), dimension: 'overworld', dimensionSince: new Date(T0 - 600_000).toISOString() },
      bodyRun: { bodyBoot: 'boot-1', connectionId: 'conn-1' }, control: { holder: state.holder, waiting: [] } as never }, facts: { alive: true, life: state.life } };
}

/** A queue that holds the scene's items: the lines the queue words make of them, the inputs ahead, and nothing else of the real queue. */
function queueOf(options: ExtractOptions, listeners: Array<(item: unknown, result: unknown, receipt?: unknown) => void>): LlmcQueue {
  const items: QueueWordsItem[] = options.state.queue.map((entry, index) => ({ item: entry.item, node: null, why: entry.effect, startedAt: index === 0 ? T0 : null, because: null,
    input: options.hands?.[index] ?? { hands: [] }, pre: undefined, done: undefined, reason: () => null }));
  const left = (options.state.queue[0]?.leftS ?? 0) * 1000;
  const none = () => {};
  return { lines: (frame: BodyObservation | null) => queueLines(items, frame, { progress: null, leftMs: left }), ahead: () => items.map(item => item.input), mark: none, stale: () => false,
    onRan: (listener: (item: unknown, result: unknown, receipt?: unknown) => void) => { listeners.push(listener); }, furnaceNews: () => [], notes: () => [], settled: async () => {}, stop: none, cancelAll: none, noteReflexCapped: none, droppedSince: () => [], tail: () => null } as unknown as LlmcQueue;
}

/** The plan path the request is given; the compressed version's is long enough to use the live state's bound up (so that the live state is shortened). */
function planOf(variant: Variant, filler: number) {
  const rules = Array.from({ length: variant === 'compressed' ? 400 : Math.min(40, filler) }, (_, index) => `規則 ${index}: ここでは ${index} 番の石を掘らない（理由 ${index * 7}）`);
  return { revision: 1, done: '0/2', path: ['地下の準備'], now: 'p1.1 黒曜石を集める', next: [], blocked: [], rules };
}

/**
 * The last request of one decision made in `variant`: `normal` (a hostile far off), `urgent` (the zombie 2 m away: the short live state), `compressed` (a long plan path and a small
 * whole-request bound, so that the live state is shortened and the model cuts the request). The blows of `state.hits` are fed frame by frame through the lifecycle with a fake clock.
 */
export async function extractRequestBytes(options: ExtractOptions): Promise<Extracted> {
  const { state, variant } = options, taskId = options.taskId ?? 'bench-d';
  const filler = state.filler ?? { resultChars: 0, liveLines: 0, nearMobs: 0 };
  let clock = T0, current = frameOf(options, 1, state.hp, 30);
  const log = () => {};
  const nodes = options.dragon ? [...NODES, { id: 'p9', parentId: null, order: 1, title: 'エンドでドラゴン', state: 'wait', kind: 'dragon' } as PlanNode] : NODES;
  const tree = { ...v2tree({ revision: 1, current: 'p1.1', nodes }), promises: options.promises ?? [] };
  const ran: Array<(item: unknown, result: unknown, receipt?: unknown) => void> = [];
  const view = planOf(variant, filler.liveLines);
  const body: FcaBodyLifecycle = withLlmcBody({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name, parent) => parent, async close() {} },
  { llmc: { plan: () => ({ revision: 1, current: 'p1.1', nodes: NODES.map(node => ({ id: node.id, parentId: node.parentId, title: node.title, state: node.state })) }) as never,
    planView: () => view, planTree: () => tree },
  taskId, createdAt: new Date(T0 - (options.wallSeconds ?? 3_600) * 1000).toISOString(), now: () => clock, observe: () => current, arrival: () => ({ at: 1, kind: 'login' }), log,
  queue: queueOf(options, ran), ...options.heldMs !== undefined ? { heldMs: () => options.heldMs! } : {},
  r4: { probe: () => null, planWhere: () => null } });
  // The blows: her health frame to frame, the zombie 2 m away while it hits her.
  const hp = (before: number) => state.hits.reduce((sum, hit) => hit.t > before ? sum + hit.amount : sum, state.hp);
  const times = [...new Set([Math.min(-10, ...state.hits.map(hit => hit.t - 1)), ...state.hits.map(hit => hit.t)])].sort((a, b) => a - b);
  let sequence = 1;
  for (const t of times) {
    clock = T0 + t * 1000;
    current = frameOf(options, sequence += 1, hp(t), 2.1);
    body.urgent!();
  }
  for (const json of options.ran ?? []) for (const listener of ran) listener({}, {}, { result: json });
  clock = T0;
  current = frameOf(options, sequence += 1, state.hp, variant === 'urgent' ? 2.1 : 30);
  // The results of the acts shown once (the filler's long result among them).
  const long = 'x'.repeat(0);
  for (const text of [...options.results ?? [], ...(filler.resultChars ? [`結果 ${'あ'.repeat(filler.resultChars)}${long}`] : [])]) {
    body.storedResult!({ id: 't', name: 'mc.act', input: { hands: [{ do: 'wait', seconds: 1 }] } } as never, text);
  }
  body.urgent!();
  body.context();
  const raw = body.transient!() as Record<string, any>;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const fixture = scriptedAnthropic((_request, index) => message([{ type: 'thinking', thinking: '', signature: `s${index}` },
    { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: { hands: ['jump 1'] } }], 'tool_use'));
  const sent: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body)); return fixture.fetcher(url, init); }) as typeof fetch;
  const tools = candidateMenuTools([...LLMC_TOOLS, PROBE]);
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-opus-5-5', fetcher, recordUsage() {}, clock: () => ({ localTime: '2026-10-28 21:00', timeZone: 'Asia/Tokyo' }),
    minecraftOwnPrompt: true, systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks(),
    ...(options.compactAboveTokens ? { compactAboveTokens: options.compactAboveTokens } : {}) });
  const input = { task: { id: taskId, title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' }, messages: [], children: [], history: [], tools, coreTools: tools,
    transient: raw, plan: view, catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) } as unknown as FcaModelInput;
  try {
    await model.decide(input, new AbortController().signal);
  } finally { vi.restoreAllMocks(); }
  const bytes = sent[sent.length - 1]!;
  const request = JSON.parse(bytes) as Record<string, any>;
  const last = request.messages[request.messages.length - 1];
  const lastMessage = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  return { bytes, lastMessage, live: JSON.parse(lastMessage) as Record<string, any>, request, raw };
}

/** For tests: nothing is kept of the task's events. */
export const forgetBench = (): void => forgetLlmcEvents();

/**
 * Bench D's probe lines for the judge (`tools/continue-verify/judge.ts`, boundary 10): the bytes of the last request in each version, and a fact said once through the
 * decisions of `measure/one-time-fact-delivery.json` (each decision is asked in the version it says, and whether the fact is in its last request is read from the bytes).
 */
export async function benchDProbes(base: Omit<ExtractOptions, 'variant' | 'taskId'>, once: { key: string; text: string; decisions: { d: string; compressedOut?: boolean }[] },
  at: () => string): Promise<ProbeLine[]> {
  const shortened = (variant: Variant) => variant === 'compressed' ? { compactAboveTokens: 16_000 } : {};
  const lines: ProbeLine[] = [];
  for (const variant of ['normal', 'urgent', 'compressed'] as Variant[]) {
    const got = await extractRequestBytes({ ...base, variant, taskId: `bench-d-${variant}`, ...shortened(variant) });
    lines.push({ kind: 'request_bytes', at: at(), variant, bytes: got.bytes });
  }
  const { offer } = await import('../../src/surfaces/minecraft/minecraftLlmcOnceFacts.js');
  offer('bench-d-once', once.key, once.text);
  const perDecision: { d: string; compressedOut: boolean; inLastRequest: boolean }[] = [];
  for (const decision of once.decisions) {
    const variant: Variant = decision.compressedOut ? 'compressed' : 'normal';
    const got = await extractRequestBytes({ ...base, variant, taskId: 'bench-d-once', ...shortened(variant) });
    perDecision.push({ d: decision.d, compressedOut: decision.compressedOut === true, inLastRequest: got.lastMessage.includes(once.text) });
  }
  lines.push({ kind: 'one_time_fact', at: at(), fact: once.text, perDecision });
  return lines;
}
