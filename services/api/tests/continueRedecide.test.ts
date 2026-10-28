import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planPath, type PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { slotWordOf, type ActInput } from '../src/contracts/minecraftActContract.js';
import { expandShortAct } from '../src/contracts/minecraftActShortContract.js';
import { llmcInputProblem, llmcPrepare } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { notedMessages } from '../src/infra/models/anthropic/anthropicFcaTransient.js';
import { estimatedAnthropicCostUsd } from '../src/infra/models/claude/claudeUsage.js';
import type { FcaModel, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { llmcCoreKnowledge } from '../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { breakingOf } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { actDifference, redecideNote, REDECIDE_GIVE_UP_MS } from '../src/surfaces/minecraft/minecraftLlmcRedecide.js';
import { materialsOf } from '../src/surfaces/minecraft/minecraftLlmcRecipes.js';
import { candidateMenuTools, minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { BenchC, benchC, iso, until } from './helpers/benchC.js';
import { message } from './support/anthropicFixtures.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';
import { layersMap } from './support/minecraftMaps.js';

/**
 * Amendment A-10 (owner's decision 2026-10-29): an act that would break an open promise is decided again once by Opus before it is queued. Nothing here calls a model: the client is a
 * script that answers by the model the request names, and what is looked at is the shape of the calls, how many there were, what the Opus request held and what the head did with the
 * answer. The head is the real one (`llmcStepParts` over the bench C's control and queue, `fcaMinecraftTools`, `AnthropicFcaModel`).
 */
const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5';
const AT = '2026-10-29T00:00:00.000Z';
const promise = (id: number, item: string, count: number, use: string): PlanPromise =>
  ({ id, rev: 1, item, count, use, state: 'open', ledger: [{ id: 'plan:1', at: AT, kind: 'made', count, have: 0 }] });
const frame = (items: Record<string, number>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:w', sequence: 1, stateAt: AT, receivedAt: AT, connected: true,
  state: { world: { dimension: 'overworld', food: 20, health: 20, position: { x: 0, y: 64, z: 0 }, inventory: Object.entries(items).map(([name, count]) => `${name}×${count}`) } },
  facts: { dimension: 'overworld', alive: true } } as unknown as BodyObservation);

// ---- 2. the table of recipes ----------------------------------------------------------------------------------------------------------------
describe('A-10 2: the materials of a make and a craft come from a small table of the game\'s recipes', () => {
  const spent = (item: string, count: number, options: { chain?: boolean; pack?: Record<string, number> } = {}) => {
    const made = materialsOf(item, count, { chain: options.chain ?? true, ...(options.pack ? { pack: new Map(Object.entries(options.pack)) } : {}) });
    return { uncounted: made.uncounted, spends: Object.fromEntries(made.spends.map(entry => [entry.item, entry.count])) };
  };
  it('a wooden pickaxe is 3 planks and 2 sticks, and the sticks are 2 more planks (one craft of 4): 5 planks', () => {
    expect(spent('wooden_pickaxe', 1)).toEqual({ uncounted: false, spends: { planks: 5 } });
    expect(spent('wooden_pickaxe', 1, { pack: { spruce_planks: 7 } })).toEqual({ uncounted: false, spends: { planks: 5 } });
    // the sticks she holds are taken first
    expect(spent('wooden_pickaxe', 1, { pack: { spruce_planks: 7, stick: 2 } }).spends).toEqual({ planks: 3, stick: 2 });
    // one stick short: one craft more, 2 planks
    expect(spent('wooden_pickaxe', 1, { pack: { spruce_planks: 7, stick: 1 } }).spends).toEqual({ planks: 5, stick: 1 });
  });
  it('the other tools: the head is a different material, the sticks are the same chain', () => {
    expect(spent('stone_pickaxe', 1).spends).toEqual({ cobblestone: 3, planks: 2 });
    expect(spent('iron_axe', 1).spends).toEqual({ iron_ingot: 3, planks: 2 });
    expect(spent('diamond_sword', 1).spends).toEqual({ diamond: 2, planks: 2 });
    expect(spent('wooden_shovel', 2).spends).toEqual({ planks: 2 + 2 });   // 2 heads, 4 sticks = one craft of sticks = 2 planks
    expect(spent('stone_hoe', 1, { pack: { stick: 2 } }).spends).toEqual({ cobblestone: 2, stick: 2 });
  });
  it('the table, the furnace, the chest, the bucket, the shield, the torch, flint and steel, a bed, armour, a slab, a ladder', () => {
    expect(spent('crafting_table', 1).spends).toEqual({ planks: 4 });
    expect(spent('furnace', 1).spends).toEqual({ cobblestone: 8 });
    expect(spent('chest', 1).spends).toEqual({ planks: 8 });
    expect(spent('bucket', 1).spends).toEqual({ iron_ingot: 3 });
    expect(spent('shield', 1).spends).toEqual({ planks: 6, iron_ingot: 1 });
    expect(spent('torch', 4).spends).toEqual({ coal: 1, planks: 2 });
    expect(spent('torch', 5).spends).toEqual({ coal: 2, planks: 2 });
    expect(spent('flint_and_steel', 1).spends).toEqual({ iron_ingot: 1, flint: 1 });
    expect(spent('white_bed', 1).spends).toEqual({ wool: 3, planks: 3 });
    expect(spent('iron_chestplate', 1).spends).toEqual({ iron_ingot: 8 });
    expect(spent('oak_slab', 6).spends).toEqual({ planks: 3 });
    expect(spent('ladder', 3).spends).toEqual({ planks: 4 });
  });
  it('planks are made from the logs she holds (a log gives 4), and a log she does not hold is not invented', () => {
    expect(spent('oak_planks', 8, { pack: { oak_log: 5 } }).spends).toEqual({ log: 2 });
    expect(spent('crafting_table', 1, { pack: { oak_planks: 2, oak_log: 2 } }).spends).toEqual({ planks: 2, log: 1 });
    expect(spent('crafting_table', 1, { pack: { oak_planks: 1 } }).spends).toEqual({ planks: 4 });
  });
  it('a craft does not walk the chain: a part she lacks is counted as it is', () => {
    expect(spent('wooden_pickaxe', 1, { chain: false, pack: { spruce_planks: 7 } }).spends).toEqual({ planks: 3, stick: 2 });
  });
  it('a thing the table does not have is not counted, and says so', () => {
    expect(spent('piston', 1)).toEqual({ uncounted: true, spends: {} });
    expect(spent('wooden_pickaxe', 0)).toEqual({ uncounted: false, spends: {} });
  });
  it('breakingOf: a make that would use more than a promise leaves free is a breaking act, and the makes it could not count come back beside', () => {
    const open = [promise(1, 'planks', 4, '地下の作業台')];
    const pack = frame({ spruce_planks: 7 });
    expect(breakingOf(open, [{ do: 'make', item: 'wooden_pickaxe' }], pack)).toEqual({
      lines: ['この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 5 を使い、残り 2）'], keptBy: [], uncounted: [] });
    expect(breakingOf(open, [{ do: 'make', item: 'crafting_table' }], pack).lines).toHaveLength(1);
    expect(breakingOf(open, [{ do: 'make', item: 'stick' }], pack).lines).toEqual([]);
    expect(breakingOf(open, [{ do: 'craft', item: 'stone_pickaxe', count: 1 }], frame({ spruce_planks: 7, cobblestone: 3, stick: 2 })).lines).toEqual([]);
    // a spend of "planks" (a recipe does not say which kind) counts against a promise of one kind
    expect(breakingOf([promise(1, 'spruce_planks', 4, '作業台')], [{ do: 'make', item: 'wooden_pickaxe' }], pack).lines).toHaveLength(1);
    expect(breakingOf(open, [{ do: 'make', item: 'piston' }, { do: 'craft', item: 'wooden_pickaxe' }], pack).uncounted).toEqual(['make piston']);
    expect(breakingOf(open, [{ do: 'make', item: 'piston' }], pack)).toEqual({ lines: [], keptBy: [], uncounted: ['make piston'] });
  });
});

describe('A-10 1: the note and how two acts differ', () => {
  const act = (hands: ActInput['hands'], extra: Partial<ActInput> = {}): ActInput => ({ hands, why: '[p1] 道具', ...extra });
  it('the note is facts: the act as written, the promise line, and the one line that asks again', () => {
    const note = redecideNote('Sonnet', act([{ do: 'make', item: 'wooden_pickaxe' }]), ['この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 5 を使い、残り 2）']);
    expect(note).toBe('Sonnet が次の act を出した: {"why":"[p1] 道具","hands":["make wooden_pickaxe"]}。この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 5 を使い、残り 2）。この判断をもう一度決めてください');
  });
  it('same, the hands, or the other fields', () => {
    const base = act([{ do: 'make', item: 'wooden_pickaxe' }]);
    expect(actDifference(base, act([{ do: 'make', item: 'wooden_pickaxe' }])).change).toBe('same');
    expect(actDifference(base, act([{ do: 'wait', seconds: 5 }])).change).toBe('hands');
    const keep = actDifference(base, act([{ do: 'make', item: 'wooden_pickaxe' }], { why: '[p1] 割ってよい: 約束 #1 は使い終えた', keep: [{ item: 'spruce_planks', count: 4, use: '作業台' }] }));
    expect(keep).toEqual({ change: 'fields', fields: ['why', 'keep'], keep: { before: 0, after: 1 } });
  });
  it('the note goes into the live state\'s system message (a user turn after it would clear it), else into the last user turn; nothing else changes', () => {
    const live = { role: 'system', clear_at: 'next_user_message', content: '{"body":1}' };
    const before = [{ role: 'user', content: '前' }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, { role: 'user', content: 'state' }, live] as never[];
    const noted = notedMessages(before, 'NOTE')!;
    expect(noted.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(noted.at(-1)).toEqual({ ...live, content: '{"body":1}\n\nNOTE' });
    expect(before.at(-1)).toBe(live);
    expect(notedMessages([{ role: 'user', content: 'a' }] as never[], 'NOTE')).toEqual([{ role: 'user', content: 'a\n\nNOTE' }]);
    expect(notedMessages([{ role: 'user', content: [{ type: 'text', text: 'a' }] }] as never[], 'NOTE')).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'NOTE' }] }]);
    expect(notedMessages([{ role: 'assistant', content: 'a' }] as never[], 'NOTE')).toBeNull();
    expect(notedMessages([], 'NOTE')).toBeNull();
  });
});

// ---- the model: a request asked again ----------------------------------------------------------------------------------------------------------
type Answer = ReturnType<typeof message> | Error | ((body: Record<string, any>) => ReturnType<typeof message> | Error | Promise<never>);
interface Sent { model: string; body: Record<string, any>; options: Record<string, any> }
const usageOf = (input: number, output: number, write: number) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: 0,
  cache_creation: null, server_tool_use: null, service_tier: 'standard', inference_geo: null, output_tokens_details: null });
const answer = (model: string, content: Array<Record<string, unknown>>, usage = usageOf(300, 200, 20_000)) => message(content, 'tool_use', { model, usage });
const sonnetSays = (input: Record<string, unknown>) => answer(SONNET, [{ type: 'thinking', thinking: '', signature: 's0' }, { type: 'tool_use', id: 'toolu_sonnet', name: 'mc_act', input }]);
const opusSays = (...calls: Array<{ name: string; input: Record<string, unknown> }>) =>
  answer(OPUS, [{ type: 'thinking', thinking: '', signature: 'o0' }, ...calls.map((call, index) => ({ type: 'tool_use', id: `toolu_opus${index}`, name: call.name, input: call.input }))],
    usageOf(400, 300, 25_000));

function scriptedClient(sonnet: Answer, opus: Answer[]) {
  const sent: Sent[] = [];
  const queue = [...opus];
  const client = { messages: { async create(body: Record<string, any>, options: Record<string, any>) {
    sent.push({ model: String(body.model), body, options });
    const next = body.model === OPUS ? queue.shift() : sonnet;
    if (!next) throw new Error('no more script for the model asked');
    const out = typeof next === 'function' ? next(body) : next;
    if (out instanceof Error) throw out;
    return out;
  } } };
  return { client, sent };
}

const modelOf = (client: unknown, usages: AnthropicFcaUsage[], name = SONNET) => createAnthropicFcaModel({ client: client as never, model: name, recordUsage: usage => { usages.push(usage); },
  clock: () => ({ localTime: '2026-10-29 21:00', timeZone: 'Asia/Tokyo' }), minecraftOwnPrompt: true, systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() });

/** One decision of the first model (a scripted Sonnet): its request is the one a later ask repeats; what it chose is returned as the runner would hand it to the tool. */
async function firstDecides(model: FcaModel, taskId: string, packed: Record<string, number>): Promise<Record<string, any>> {
  const tools = candidateMenuTools(LLMC_TOOLS);
  const observation = frame(packed);
  const live = minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [], observation });
  const input = { task: { id: taskId, title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' }, messages: [], children: [], history: [], tools, coreTools: tools,
    transient: live, plan: { ...planPath(seedPlan('エンドラを倒して')!) }, catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) } as unknown as FcaModelInput;
  const out = await model.decide(input, new AbortController().signal);
  if (out.decision.kind !== 'tools') throw new Error('the scripted first model did not call a tool');
  return out.decision.calls[0]!.input as Record<string, any>;
}

describe('A-10 1: AnthropicFcaModel.redecide sends the task\'s last request again to Opus, with the note and nothing else changed', () => {
  beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });
  const hands = { hands: ['make wooden_pickaxe'], why: '[p1] 道具' };

  it('the request is the first one with only the model changed and the note after the live state; the answer is decoded as a decision is; the cost is booked as Opus', async () => {
    const { client, sent } = scriptedClient(sonnetSays(hands), [opusSays({ name: 'plan_update', input: { ops: [] } }, { name: 'mc_act', input: { hands: ['wait 5'], why: '[p1] 板を残す' } })]);
    const usages: AnthropicFcaUsage[] = [];
    const model = modelOf(client, usages);
    await firstDecides(model, 't1', { spruce_planks: 7 });
    const asked = await model.redecide!({ taskId: 't1', note: 'NOTE-LINE', signal: new AbortController().signal, timeoutMs: 5_000 });
    const [first, second] = sent;
    expect(sent.map(item => item.model)).toEqual([SONNET, OPUS]);
    // the same system, tools, settings and headers; only the model differs
    expect(second!.body.system).toEqual(first!.body.system);
    expect(second!.body.tools).toEqual(first!.body.tools);
    expect(second!.body.thinking).toEqual(first!.body.thinking);
    expect(second!.body.output_config).toEqual(first!.body.output_config);
    expect(second!.body.max_tokens).toBe(first!.body.max_tokens);
    expect(second!.options.headers).toEqual(first!.options.headers);
    expect(second!.options.maxRetries).toBe(0);
    // the messages: all the same but the live state's, which ends with the note
    const [m1, m2] = [first!.body.messages as Array<Record<string, any>>, second!.body.messages as Array<Record<string, any>>];
    expect(m2).toHaveLength(m1.length);
    expect(m2.slice(0, -1)).toEqual(m1.slice(0, -1));
    expect(m1.at(-1)!.role).toBe('system');
    expect(m2.at(-1)!.content).toBe(`${m1.at(-1)!.content as string}\n\nNOTE-LINE`);
    // the answer: the calls under their own names, with the act's hands made the mode's
    expect(asked!.calls.map(call => call.name)).toEqual(['plan.update', 'mc.act']);
    expect((asked!.calls[1]!.input as ActInput).hands).toEqual([{ do: 'wait', seconds: 5 }]);
    // the cost: booked as the budget books every call, as Opus
    expect(usages.map(usage => usage.model)).toEqual([SONNET, OPUS]);
    expect(usages[1]!.usageComplete).toBe(true);
    expect(usages[1]!.estimatedCostUsd).toBe(estimatedAnthropicCostUsd(OPUS, { input: 400, output: 300, cacheWrite: 25_000, cacheRead: 0, searches: 0 }));
    expect(asked!.usage.costUsd).toBe(usages[1]!.estimatedCostUsd);
    expect(asked!.usage.costUsd).toBeGreaterThan(0);
  });

  it('nothing to ask: a model that is Opus already answers null and sends nothing; no request remembered, or one the note cannot be added to, throws', async () => {
    const { client, sent } = scriptedClient(sonnetSays(hands), []);
    const usages: AnthropicFcaUsage[] = [];
    expect(await modelOf(client, usages, OPUS).redecide!({ taskId: 't1', note: 'N', signal: new AbortController().signal, timeoutMs: 5_000 })).toBeNull();
    expect(sent).toHaveLength(0);
    const sonnet = modelOf(client, usages);
    await expect(sonnet.redecide!({ taskId: 'never', note: 'N', signal: new AbortController().signal, timeoutMs: 5_000 })).rejects.toThrow('FCA_REDECIDE_NO_REQUEST');
    expect(sent).toHaveLength(0);
  });

  it('an answer that is not a call, an error and a time-out each throw (the last two booked at their upper bound as a decision\'s are), and the task\'s memory of the request stays', async () => {
    const hang = (body: Record<string, any>, options?: Record<string, any>) => body && options;
    void hang;
    const usages: AnthropicFcaUsage[] = [];
    const slow = scriptedClient(sonnetSays(hands), [message([{ type: 'text', text: 'どうしよう' }], 'end_turn', { model: OPUS }), new Error('connection reset')]);
    const model = modelOf(slow.client, usages);
    await firstDecides(model, 't1', { spruce_planks: 7 });
    const ask = (timeoutMs = 5_000) => model.redecide!({ taskId: 't1', note: 'N', signal: new AbortController().signal, timeoutMs });
    await expect(ask()).rejects.toThrow('FCA_REDECIDE_NO_CALL');
    await expect(ask()).rejects.toThrow('FCA_REDECIDE_FAILED');
    // a request that does not come back in time
    const stuck = { messages: { create: (body: Record<string, any>, options: { signal: AbortSignal }) => body.model === OPUS
      ? new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted by the deadline'))); })
      : Promise.resolve(sonnetSays(hands)) } };
    const waiting = modelOf(stuck, usages);
    await firstDecides(waiting, 't2', { spruce_planks: 7 });
    const before = usages.length;
    await expect(waiting.redecide!({ taskId: 't2', note: 'N', signal: new AbortController().signal, timeoutMs: 30 })).rejects.toThrow('FCA_REDECIDE_TIMEOUT');
    expect(usages.length).toBe(before + 1);
    expect(usages.at(-1)).toMatchObject({ model: OPUS, usageComplete: false });
    expect(usages.at(-1)!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('the wait for Opus is a constant, shorter than a decision\'s own 90 seconds', () => {
    expect(REDECIDE_GIVE_UP_MS).toBe(60_000);
  });
});

// ---- through the real tool ------------------------------------------------------------------------------------------------------------------
const benches: BenchC[] = [];
afterEach(() => { for (const bench of benches.splice(0)) bench.close(); vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const SLOW = { timeout: 60_000 };

/** A step of the real head with an open promise of 4 planks and `inventory`, whose first model is a scripted Sonnet that chose `sonnet` and whose Opus answers as scripted. */
async function scene(options: { sonnet: Record<string, unknown>; opus: Answer[]; inventory: Record<string, number>; promise?: boolean; budget?: boolean; instead?: string }) {
  const { client, sent } = scriptedClient(sonnetSays(options.sonnet), options.opus);
  const usages: AnthropicFcaUsage[] = [];
  const booked: number[] = [];
  let budget: ReturnType<typeof fcaBudget> | null = null;
  const model = createAnthropicFcaModel({ client: client as never, model: SONNET, recordUsage: usage => { usages.push(usage); budget?.recordUsage(usage.estimatedCostUsd, !usage.usageComplete); },
    clock: () => ({ localTime: '2026-10-29 21:00', timeZone: 'Asia/Tokyo' }), minecraftOwnPrompt: true, systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() });
  const bench = benchC({ scene: 'a10-redecide', model: { model, name: SONNET } });
  benches.push(bench);
  await bench.begin();
  if (options.promise !== false) expect((await bench.planUpdate('promise', { ops: [{ op: 'promise', item: 'planks', count: 4, use: '地下の作業台', ...(options.instead ? { instead: options.instead } : {}) }] })).ok).toBe(true);
  bench.body.inventory = options.inventory;
  await bench.spin(3);
  const chosen = await firstDecides(model, bench.run, options.inventory);
  const task = { id: bench.run, scopeKey: 'owner', origin: 'owner_request', kind: 'generic', title: 'エンドラ' } as never;
  const lease = { id: bench.head.step!.lease.id, generation: 1, holder: 'bench-c' } as never;
  if (options.budget) {
    const store = { spent: () => ({ steps: 0, yen: 0, openEstimatedYen: 0 }), capped() {}, acknowledgeEstimates() {}, add: (_task: string, _scope: string, _origin: string, yen: number) => { booked.push(yen); }, addEstimate() {} };
    budget = fcaBudget({ actions: {} as never, store: store as never, now: () => iso(), minecraftRequest: () => true });
    expect((await budget.before(task, lease)).ok).toBe(true);
  }
  const queued = () => bench.body.handed.filter(command => command.kind === 'skill' && command.skill === 'act');
  const rows = () => bench.events().filter(row => row.ev === 'redecide');
  return { bench, sent, usages, chosen, queued, rows, booked, settle: async () => { await budget?.after(task, lease); },
    act: () => bench.actThroughTools(chosen) };
}
const opusSent = (sent: Sent[]) => sent.filter(item => item.model === OPUS);
const queuedHands = (queued: () => Array<{ arguments?: Record<string, unknown> | null }>) => queued().map(command => (command.arguments as { hands?: unknown } | null)?.hands);
const PICKAXE = { hands: ['make wooden_pickaxe'], why: '[p1] 木のツルハシ' };
const BREAKS = 'この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 5 を使い、残り 2）';

describe('A-10 through the real tool: an act that would break an open promise is decided again by Opus before it is queued', () => {
  it('(a) (g) a make of a wooden pickaxe with 7 planks and a promise of 4: Opus is asked once, its request is the first one with the act and the promise line at the end, and its act is the one queued', SLOW, async () => {
    const { bench, sent, chosen, queued, rows, act } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 },
      opus: [opusSays({ name: 'mc_act', input: { hands: ['wait 5'], why: '[p1] 約束 #1 の板を残す' } })] });
    expect(chosen.hands).toEqual([{ do: 'make', item: 'wooden_pickaxe' }]);
    const result = await act();
    expect(result.ok).toBe(true);
    const [first, second] = [sent[0]!, opusSent(sent)[0]!];
    expect(opusSent(sent)).toHaveLength(1);
    expect(sent).toHaveLength(2);
    // the request: the same system, tools and history; the live state of the first ends with the act as the first model wrote it and the promise line
    expect(second.body.system).toEqual(first.body.system);
    expect(second.body.tools).toEqual(first.body.tools);
    const live = (body: Record<string, any>) => (body.messages as Array<Record<string, any>>).at(-1)!.content as string;
    expect(live(second.body).startsWith(live(first.body))).toBe(true);
    expect(live(second.body).slice(live(first.body).length)).toBe(`\n\n${redecideNote('Sonnet', chosen as ActInput, [BREAKS])}`);
    expect(live(second.body)).toContain('"hands":["make wooden_pickaxe"]');
    expect(live(second.body)).toContain(BREAKS);
    // the act queued is Opus's, and the answer says so, after the line of the queue
    await until(() => queued().length > 0);
    expect(queuedHands(queued)).toEqual([[{ do: 'wait', seconds: 5 }]]);
    const lines = result.text.split(/\r?\n/u);
    // the head's own fix (a stopIf for a wait) comes first when there is one; the queue's line, then what Opus did
    const at = lines.findIndex(line => /^列に入れた q[0-9]+/u.test(line));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toMatch(/^決め直し（Opus）: 手を替えた。列に入れたのは Opus の act: \{.*"wait 5".*\}$/u);
    expect(lines.some(line => line.includes('割る見込み'))).toBe(false);
    // the record: the request and the answer as any, and the row of what came of them
    expect(bench.events().filter(row => row.ev === 'request' && row.kind === 'redecide')).toHaveLength(1);
    expect(bench.events().filter(row => row.ev === 'request' && row.kind === 'redecide')[0]!.id).toBe('r0001');
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row).toMatchObject({ asked: true, count: 1, outcome: 'used', change: 'hands', model: OPUS, breaking: [BREAKS], uncounted: [], planUpdate: false });
    expect(row!.costUsd).toBeGreaterThan(0);
    expect(row!.ms).toBeGreaterThanOrEqual(0);
    expect(row!.act).toContain('make wooden_pickaxe');
    expect(row!.opusAct).toContain('wait 5');
  });

  it('(b) an act that breaks no promise is not asked again; one that spends only what is free, one with no promise open, one in an urgent decision', SLOW, async () => {
    const free = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 12 }, opus: [] });
    expect((await free.act()).text).not.toContain('決め直し');
    expect(opusSent(free.sent)).toHaveLength(0);
    expect(free.rows()).toHaveLength(0);
    const none = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [], promise: false });
    expect((await none.act()).ok).toBe(true);
    expect(opusSent(none.sent)).toHaveLength(0);
  });

  it('(b) an urgent decision\'s act goes in at once, and the record says it was not asked', SLOW, async () => {
    const urgent = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [] });
    const result = await urgent.bench.actThroughTools(urgent.chosen, { urgent: true });
    expect(result.ok).toBe(true);
    expect(opusSent(urgent.sent)).toHaveLength(0);
    expect(result.text).toContain(BREAKS);
    expect(urgent.rows()).toEqual([expect.objectContaining({ asked: false, count: 0, skipped: 'urgent', breaking: [BREAKS] })]);
  });

  it('(b) a make the table does not have is not counted, not asked, and the record keeps the item', SLOW, async () => {
    const { sent, act, rows, queued } = await scene({ sonnet: { hands: ['make piston'], why: '[p1] ピストン' }, inventory: { spruce_planks: 7 }, opus: [] });
    const result = await act();
    expect(result.ok).toBe(true);
    expect(opusSent(sent)).toHaveLength(0);
    await until(() => queued().length > 0);
    expect(rows()).toEqual([expect.objectContaining({ asked: false, count: 0, breaking: [], uncounted: ['make piston'] })]);
  });

  it('(c) only once for an act: when Opus\'s act breaks the promise too it is checked, queued and said so, and Opus is not asked again', SLOW, async () => {
    const { sent, act, queued, rows } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 },
      opus: [opusSays({ name: 'mc_act', input: { hands: ['drop spruce_planks 6'], why: '[p1] 約束 #1 は作業台を置かないことにしたので使う' } }), opusSays({ name: 'mc_act', input: { hands: ['wait 1'] } })] });
    const result = await act();
    expect(result.ok).toBe(true);
    expect(opusSent(sent)).toHaveLength(1);
    await until(() => queued().length > 0);
    expect(queuedHands(queued)).toEqual([[{ do: 'drop', items: [{ item: 'spruce_planks', count: 6 }] }]]);
    expect(result.text.split(/\r?\n/u).some(line => line.startsWith('この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 6 を使い、残り 1）'))).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ outcome: 'used', count: 1 });
  });

  it('(d) Opus fails: the first model\'s act is queued as it was, the failure is logged and in the record, and nothing is said to the model of it', SLOW, async () => {
    const { bench, sent, act, queued, rows } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [new Error('connection reset by peer')] });
    const result = await act();
    expect(result.ok).toBe(true);
    expect(opusSent(sent)).toHaveLength(1);
    await until(() => queued().length > 0);
    expect(queuedHands(queued)).toEqual([[{ do: 'make', item: 'wooden_pickaxe' }]]);
    expect(result.text).not.toContain('決め直し');
    expect(result.text).toContain(BREAKS);
    expect(rows()).toEqual([expect.objectContaining({ asked: true, count: 1, outcome: 'kept_first', why: 'failed', breaking: [BREAKS] })]);
    expect(String(rows()[0]!.failed)).toContain('FCA_REDECIDE_FAILED');
    expect(bench.head.lines.some(line => line.startsWith('Shannon FCA redecide failed why=FCA_REDECIDE_FAILED'))).toBe(true);
    expect(bench.events().find(row => row.ev === 'response' && row.id === 'r0001')).toMatchObject({ outcome: 'error' });
  });

  it('(d) Opus gives no act, or an act the checks refuse: the first model\'s act is queued and the record says why', SLOW, async () => {
    const nothing = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [opusSays({ name: 'plan_update', input: { ops: [] } })] });
    await nothing.act();
    await until(() => nothing.queued().length > 0);
    expect(queuedHands(nothing.queued)).toEqual([[{ do: 'make', item: 'wooden_pickaxe' }]]);
    expect(nothing.rows()[0]).toMatchObject({ outcome: 'kept_first', why: 'no_act' });
    // a hand the head's own checks refuse (a malformed hand line): the first act stands
    const refused = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [opusSays({ name: 'mc_act', input: { hands: ['go'], why: '[p1] どこかへ' } })] });
    await refused.act();
    await until(() => refused.queued().length > 0);
    expect(queuedHands(refused.queued)).toEqual([[{ do: 'make', item: 'wooden_pickaxe' }]]);
    expect(refused.rows()[0]).toMatchObject({ outcome: 'kept_first', why: 'refused' });
    expect(String(refused.rows()[0]!.refusedBy).length).toBeGreaterThan(0);
  });

  it('(e) Opus gives the same act: it goes in as it is, once, and the model reads that Opus made the same choice', SLOW, async () => {
    const { sent, act, queued, rows } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [opusSays({ name: 'mc_act', input: PICKAXE })] });
    const result = await act();
    expect(result.ok).toBe(true);
    expect(opusSent(sent)).toHaveLength(1);
    await until(() => queued().length > 0);
    expect(queued()).toHaveLength(1);
    expect(queuedHands(queued)).toEqual([[{ do: 'make', item: 'wooden_pickaxe' }]]);
    const lines = result.text.split(/\r?\n/u);
    expect(lines[lines.findIndex(line => /^列に入れた q[0-9]+/u.test(line)) + 1]).toBe('決め直し（Opus）: 同じ act を出した');
    expect(lines).toContain(BREAKS);
    expect(rows()[0]).toMatchObject({ outcome: 'used', change: 'same', changedFields: [] });
  });

  it('(f) Opus\'s keep becomes a promise as an act\'s keep does, and its plan.update goes to the plan; the first model\'s keep is not made', SLOW, async () => {
    const { bench, sent, act, queued, rows } = await scene({ sonnet: { ...PICKAXE, keep: ['spruce_planks:2:ほかの用'] }, inventory: { spruce_planks: 7 },
      opus: [opusSays({ name: 'plan_update', input: { ops: [{ op: 'promise', item: 'cobblestone', count: 8, use: 'かまど' }] } },
        { name: 'mc_act', input: { hands: ['wait 5'], why: '[p1] 板を残す', keep: ['spruce_planks:4:作業台'] } })] });
    const result = await act();
    expect(result.ok).toBe(true);
    expect(opusSent(sent)).toHaveLength(1);
    await until(() => queued().length > 0);
    const promises = bench.plan.tree().promises;
    expect(promises.map(item => `${item.item}:${item.count}:${item.use}`)).toEqual(['planks:4:地下の作業台', 'cobblestone:8:かまど', 'spruce_planks:4:作業台']);
    expect(result.text).toContain('Opus の plan.update: 通した');
    expect(result.text.split(/\r?\n/u).some(line => line.includes('作業台') && line.includes('約束'))).toBe(true);
    expect(rows()[0]).toMatchObject({ outcome: 'used', planUpdate: true, planUpdates: 1, keep: { before: 1, after: 1 } });
    expect(rows()[0]!.changedFields).toEqual(expect.arrayContaining(['hands', 'keep']));
  });

  it('(f) a plan.update of Opus that the model already made in the same step is not made twice', SLOW, async () => {
    const same = { ops: [{ op: 'promise', item: 'cobblestone', count: 8, use: 'かまど' }] };
    const { bench, act } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 },
      opus: [opusSays({ name: 'plan_update', input: same }, { name: 'mc_act', input: { hands: ['wait 5'], why: '[p1] 待つ' } })] });
    expect((await bench.planUpdate('the same', same)).ok).toBe(true);
    const result = await act();
    expect(result.text).toContain('Opus の plan.update: 通した');
    expect(bench.plan.tree().promises.filter(item => item.item === 'cobblestone')).toHaveLength(1);
  });

  it('(h) the cost of Opus is in the budget\'s count of the step: the yen the step books is the Opus request\'s', SLOW, async () => {
    const { usages, booked, settle, act, rows } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, budget: true,
      opus: [opusSays({ name: 'mc_act', input: { hands: ['wait 5'], why: '[p1] 板を残す' } })] });
    await act();
    await settle();
    const opus = usages.filter(usage => usage.model === OPUS);
    expect(opus).toHaveLength(1);
    expect(opus[0]!.estimatedCostUsd).toBeGreaterThan(0.1);
    // the first model's decision was made outside the step (the scene's priming); the step books exactly the ask
    expect(booked).toEqual([Math.ceil(opus[0]!.estimatedCostUsd * 160)]);
    expect(rows()[0]!.costUsd).toBe(opus[0]!.estimatedCostUsd);
  });

  it('(h) the same step without an ask books nothing', SLOW, async () => {
    const { booked, settle, act } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 12 }, budget: true, opus: [] });
    await act();
    await settle();
    expect(booked).toEqual([]);
  });
});

// ---- A-11 ------------------------------------------------------------------------------------------------------------------------------------
/** A map as the contract draws it (`layersMap`), with the symbol of one cell changed. */
function mapWith(symbol: string, cell: { x: number; y: number; z: number }): string {
  const lines = layersMap({ x: 0, y: 64, z: 0 }).split('\n');
  const at = lines.findIndex(line => line === `y=${cell.y}`);
  const row = lines[at + 2 + (cell.z + 7)]!.split(' ');
  row[1 + (cell.x + 7)] = symbol;
  lines[at + 2 + (cell.z + 7)] = row.join(' ');
  return lines.join('\n');
}
const seen = (items: Record<string, number>, extra: Record<string, unknown> = {}): BodyObservation => {
  const base = frame(items);
  return { ...base, state: { ...base.state, world: { ...(base.state.world as object), ...extra } } } as BodyObservation;
};
const INSTEAD = [[{ k: 'have', item: 'crafting_table', n: 1 }], [{ k: 'near', block: 'crafting_table', r: 8 }]] as never;
const withInstead = (instead: unknown, state: PlanPromise['state'] = 'open'): PlanPromise => ({ ...promise(1, 'planks', 4, '地下の作業台'), state, instead: instead as never });
const KEPT = '約束 #1 は代わりの条件（作業台 1）で満たす見込み';
const BURN = { do: 'smelt', items: [{ item: 'raw_iron', count: 6 }], fuel: 'spruce_planks', fuelCount: 6 };

describe('A-11 1: an act whose hands make the promise\'s instead hold is not one that breaks it', () => {
  const pack = seen({ spruce_planks: 7, raw_iron: 6 });
  it('a craft of the table gives it (the table\'s own number), so the promise is kept by its instead and not broken', () => {
    expect(breakingOf([withInstead(INSTEAD)], [{ do: 'craft', item: 'crafting_table' }], seen({ spruce_planks: 7 }))).toEqual({ lines: [], keptBy: [KEPT], uncounted: [] });
    // the same act with no instead on the promise is a breaking one, as in A-10
    expect(breakingOf([promise(1, 'planks', 4, '地下の作業台')], [{ do: 'craft', item: 'crafting_table' }], seen({ spruce_planks: 7 })).lines).toHaveLength(1);
  });
  it('a dig of a cell the map draws as a work table gives one (collect not false); the map must show the cell', () => {
    const map = mapWith('T', { x: 2, y: 64, z: 1 });
    const hands = (extra: object = {}, at = { x: 2, y: 64, z: 1 }) => [{ do: 'dig', at: [at], ...extra }, BURN];
    expect(breakingOf([withInstead(INSTEAD)], hands(), seen({ spruce_planks: 7, raw_iron: 6 }, { localMap: map }))).toEqual({ lines: [], keptBy: [KEPT], uncounted: [] });
    // collect false: nothing is picked up; a cell that is not the table; a cell the map does not show; a relative cell; no map: the promise is broken as before
    for (const [label, handsOf, world] of [['collect false', hands({ collect: false }), { localMap: map }], ['another cell', hands({}, { x: 3, y: 64, z: 1 }), { localMap: map }],
      ['off the map', hands({}, { x: 40, y: 64, z: 1 }), { localMap: map }], ['relative', hands({ rel: true }), { localMap: map }], ['no map', hands(), {}]] as const) {
      const got = breakingOf([withInstead(INSTEAD)], handsOf, seen({ spruce_planks: 7, raw_iron: 6 }, world));
      expect([label, got.lines.length, got.keptBy]).toEqual([label, 1, []]);
    }
  });
  it('a near clause holds when the scan shows it now (the words carry the distance) or when a hand places the block; else it does not', () => {
    const near = [[{ k: 'near', block: 'crafting_table', r: 8 }]] as never;
    const scanned = (found: unknown[]) => seen({ spruce_planks: 7, raw_iron: 6 }, { utilities: { radius: 16, dim: 'overworld', scanned: true, found } });
    expect(breakingOf([withInstead(near)], [BURN], scanned([{ block: 'crafting_table', distance: 2 }])).keptBy).toEqual(['約束 #1 は代わりの条件（近くに作業台 2m）で満たす見込み']);
    expect(breakingOf([withInstead(near)], [{ do: 'place', block: 'crafting_table', at: [{ x: 1, y: 64, z: 1 }] }, BURN], scanned([])).keptBy)
      .toEqual(['約束 #1 は代わりの条件（近くに作業台）で満たす見込み']);
    expect(breakingOf([withInstead(near)], [BURN], scanned([{ block: 'crafting_table', distance: 20 }])).lines).toHaveLength(1);
    // not scanned is not "none": it cannot be told, so the promise is still broken
    expect(breakingOf([withInstead(near)], [BURN], seen({ spruce_planks: 7, raw_iron: 6 })).lines).toHaveLength(1);
  });
  it('one alternative whose clauses all hold is enough; a clause that does not hold (or one the head cannot tell) spoils its alternative only', () => {
    const table = [{ k: 'have', item: 'crafting_table', n: 1 }];
    const both = [[...table, { k: 'have', item: 'furnace', n: 1 }]] as never;
    expect(breakingOf([withInstead(both)], [{ do: 'craft', item: 'crafting_table' }], seen({ spruce_planks: 7 })).lines).toHaveLength(1);
    expect(breakingOf([withInstead([[{ k: 'hp', n: 10 }], table])], [{ do: 'craft', item: 'crafting_table' }], seen({ spruce_planks: 7 })).keptBy).toEqual([KEPT]);
    expect(breakingOf([withInstead([[...table, { k: 'dim', dim: 'the_nether' }]])], [{ do: 'craft', item: 'crafting_table' }], seen({ spruce_planks: 7 })).lines).toHaveLength(1);
    // what the pack holds counts too, less what the act spends of it
    expect(breakingOf([withInstead(INSTEAD)], [BURN], seen({ spruce_planks: 7, raw_iron: 6, crafting_table: 1 })).keptBy).toEqual([KEPT]);
    expect(breakingOf([withInstead([[{ k: 'have', item: 'planks', n: 5 }]])], [BURN], pack).lines).toHaveLength(1);
  });
  it('a thing the table does not have is not said to be gained; a promise already held by its instead is not counted at all', () => {
    expect(breakingOf([withInstead([[{ k: 'have', item: 'piston', n: 1 }]])], [{ do: 'craft', item: 'piston' }, BURN], pack).lines).toHaveLength(1);
    expect(breakingOf([withInstead([[{ k: 'have', item: 'crafting_table', n: 1 }]])], [{ do: 'make', item: 'piston' }, BURN], pack).lines).toHaveLength(1);
    expect(breakingOf([withInstead(INSTEAD, 'kept_by_instead')], [BURN], pack)).toEqual({ lines: [], keptBy: [], uncounted: [] });
    // a pickup that names the item takes at least one
    expect(breakingOf([withInstead(INSTEAD)], [{ do: 'pickup', target: 'crafting_table' }, BURN], pack).keptBy).toEqual([KEPT]);
  });
});

describe('A-11 3: the plain variations of the hand words are the body\'s words', () => {
  const problem = (input: unknown) => llmcInputProblem('mc.act', expandShortAct(input).input);
  it('equip with slot=off-hand, off_hand, offhand, main-hand, main_hand, mainhand, hand: read, and no problem', () => {
    for (const [word, slot] of [['off-hand', 'offhand'], ['off_hand', 'offhand'], ['offhand', 'offhand'], ['main-hand', 'hand'], ['main_hand', 'hand'], ['mainhand', 'hand'], ['hand', 'hand']] as const) {
      for (const line of [`equip shield slot=${word}`, `equip shield ${word}`, `json {"do":"equip","item":"shield","slot":"${word}"}`]) {
        const expanded = expandShortAct({ hands: [line], why: '盾を持つ' });
        expect([line, (expanded.input as ActInput).hands[0]!.slot]).toEqual([line, slot]);
        expect(problem({ hands: [line], why: '盾を持つ' })).toBeNull();
      }
      // a hand written as an object (no line among them) is read the same way, and so is the head's own shaping of a raw input
      expect(problem({ hands: [{ do: 'equip', item: 'shield', slot: word }], why: '盾を持つ' })).toBeNull();
      expect(((llmcPrepare('mc.act', { hands: [{ do: 'equip', item: 'shield', slot: word }], why: '盾' }).input) as ActInput).hands[0]!.slot).toBe(slot);
    }
  });
  it('a word that is no variation of a slot is still refused', () => {
    expect(problem({ hands: ['equip shield slot=pocket'], why: 'x' })).not.toBeNull();
    expect(slotWordOf('knee')).toBe('knee');
  });
});

describe('A-11 2: an act of Opus that the checks before sending refuse is mended once', () => {
  const BAD = { hands: ['go'], why: '[p1] どこかへ' };
  it('the mend is the same request with the act and the refusal added; the mended act goes in; the record says repairs 1 with the refusal, and both requests are paid', SLOW, async () => {
    const { bench, sent, usages, act, queued, rows, booked, settle } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, budget: true,
      opus: [opusSays({ name: 'mc_act', input: BAD }), opusSays({ name: 'mc_act', input: { hands: ['wait 5'], why: '[p1] 約束の板を残す' } })] });
    const result = await act();
    expect(result.ok).toBe(true);
    await settle();
    expect(opusSent(sent)).toHaveLength(2);
    const live = (body: Record<string, any>) => (body.messages as Array<Record<string, any>>).at(-1)!.content as string;
    const [first, again] = opusSent(sent);
    // the mend: the first ask's request with the repair note after the first note (the act as written, what refused it, one line)
    expect(live(again!.body).startsWith(live(first!.body))).toBe(true);
    const added = live(again!.body).slice(live(first!.body).length);
    expect(added).toMatch(/^\n\nOpus の次の act: \{.*"書き方の誤り":".*go.*\}。送る前の確認が断った: 手の書き方が読めない.+。書き方を直してください$/u);
    expect(again!.body.system).toEqual(first!.body.system);
    await until(() => queued().length > 0);
    expect(queuedHands(queued)).toEqual([[{ do: 'wait', seconds: 5 }]]);
    expect(result.text).toContain('決め直し（Opus）: 手を替えた');
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row).toMatchObject({ outcome: 'used', count: 1, repairs: 1 });
    expect(String(row!.refusedBy).length).toBeGreaterThan(0);
    expect(row!.repairRefusedBy).toBeUndefined();
    // both requests are in the record, as requests of their own, and in the budget's count
    expect(bench.events().filter(item => item.ev === 'request' && item.kind === 'redecide').map(item => item.id)).toEqual(['r0001', 'r0002']);
    const opus = usages.filter(usage => usage.model === OPUS);
    expect(opus).toHaveLength(2);
    const total = opus[0]!.estimatedCostUsd + opus[1]!.estimatedCostUsd;
    expect(row!.costUsd).toBeCloseTo(total, 10);
    expect(booked).toEqual([Math.ceil(total * 160)]);
  });

  it('a mended act that is refused too: the first model\'s act goes in as it was, once more is not asked, and the record has both refusals', SLOW, async () => {
    const { sent, act, queued, rows } = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 },
      opus: [opusSays({ name: 'mc_act', input: BAD }), opusSays({ name: 'mc_act', input: { hands: ['walk'], why: '[p1] まだ' } }), opusSays({ name: 'mc_act', input: { hands: ['wait 1'] } })] });
    const result = await act();
    expect(result.ok).toBe(true);
    expect(opusSent(sent)).toHaveLength(2);
    await until(() => queued().length > 0);
    expect(queuedHands(queued)).toEqual([[{ do: 'make', item: 'wooden_pickaxe' }]]);
    expect(result.text).not.toContain('決め直し');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ outcome: 'kept_first', why: 'refused', repairs: 1 });
    expect(String(rows()[0]!.refusedBy).length).toBeGreaterThan(0);
    expect(String(rows()[0]!.repairRefusedBy).length).toBeGreaterThan(0);
  });

  it('an act that passes the checks is not mended; an act the mend asks for and does not get (no act, an error) leaves the first act and says so', SLOW, async () => {
    const fine = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [opusSays({ name: 'mc_act', input: { hands: ['wait 5'], why: '[p1] 待つ' } })] });
    await fine.act();
    expect(opusSent(fine.sent)).toHaveLength(1);
    expect(fine.rows()[0]!.repairs).toBeUndefined();
    const lost = await scene({ sonnet: PICKAXE, inventory: { spruce_planks: 7 }, opus: [opusSays({ name: 'mc_act', input: BAD }), new Error('connection reset')] });
    expect((await lost.act()).ok).toBe(true);
    await until(() => lost.queued().length > 0);
    expect(queuedHands(lost.queued)).toEqual([[{ do: 'make', item: 'wooden_pickaxe' }]]);
    expect(lost.rows()[0]).toMatchObject({ outcome: 'kept_first', why: 'refused', repairs: 1 });
    expect(String(lost.rows()[0]!.repairFailed)).toContain('FCA_REDECIDE_FAILED');
  });
});

describe('A-11 1 through the real tool: a promise kept by its instead is said so and Opus is not asked', () => {
  it('a craft of the work table with 7 planks and a promise of 4 that names the table as its instead: the answer says kept, the act is queued, no request to Opus', SLOW, async () => {
    const { bench, sent, chosen, act, queued, rows } = await scene({ sonnet: { hands: ['craft crafting_table'], why: '[p1] 作業台を作る' }, inventory: { spruce_planks: 7 }, opus: [],
      instead: 'have:crafting_table>=1|near:crafting_table~8' });
    expect(chosen.hands).toEqual([{ do: 'craft', item: 'crafting_table' }]);
    expect(bench.plan.tree().promises[0]!.instead).toBeDefined();
    const result = await act();
    expect(result.ok).toBe(true);
    expect(opusSent(sent)).toHaveLength(0);
    await until(() => queued().length > 0);
    const lines = result.text.split(/\r?\n/u);
    expect(lines).toContain(KEPT);
    expect(lines.some(line => line.includes('割る見込み'))).toBe(false);
    expect(rows()).toEqual([expect.objectContaining({ asked: false, count: 0, satisfied: [KEPT], breaking: [] })]);
  });
});
