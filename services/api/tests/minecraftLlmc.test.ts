import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sceneDecision, sceneInput, type LlmcScene } from '../src/surfaces/minecraft/minecraftLlmcScene.js';
import {
  ACT_INPUT_SCHEMA, actMilliseconds, actProblem, LLMC_READ_SKILLS, MAP_LEGEND, MC_ACT_TOOL, MC_VIEW_TOOL, VIEW_INPUT_SCHEMA, type ActResult,
} from '../src/contracts/minecraftActContract.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { MinecraftSkillDefinition } from '../src/contracts/minecraftControlContract.js';
import { skillSchema, validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { actResultText, llmcBodyDefinitions, llmcInputProblem, llmcLongCall, llmcResult, urgentWatch } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { carriedFood, createFoodTrend, LLMC_LIVE_TOKENS, llmcLiveTokens, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { createLlmcEvents, forgetLlmcEvents, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import {
  carryDone, firstPlanInbox, forgetFirstPlans, planFromAnswer, planGoal, seedPlan, startFirstPlan,
} from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { LLMC_SYSTEM_APPENDIX } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { storedBodyResult } from '../src/surfaces/minecraft/minecraftStoredResult.js';
import { llmcModelNames, llmcModelRouter } from '../src/wiring/minecraftLlmcWiring.js';
import type { FcaModel, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { applyPlanUpdate, planPath } from '@shannon/mind';
import { estimatedAnthropicTokens } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { layersMap } from './support/minecraftMaps.js';

/** Design mb-llm-centric (2026-10-21): the head's side of mc.act / mc.view, the map-first live state, the first plan and the models. */
afterEach(() => { forgetFirstPlans(); forgetLlmcEvents(); vi.useRealTimers(); });

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-21T00:00:00Z', receivedAt: '2026-10-21T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const FULL_WORLD = {
  position: { x: 201.7, y: 45, z: 277.5 }, dimension: 'minecraft:overworld', biome: 'plains', time: '昼 6000', health: 18, food: 15, saturation: 3.5,
  heldItem: 'iron_pickaxe', worn: '頭: なし、胴: iron_chestplate',
  localMap: layersMap(),
  mapLandmarks: Array.from({ length: 12 }, (_, i) => `F かまど (202,${52 + i},277) 上${7 + i}・東1 自分が置いた raw_iron×3 焼き上がり`),
  recentStops: Array.from({ length: 5 }, (_, i) => `(201,45,277)→(201,48,277) 一歩ではない ×${7 - i} ${23 + i}秒前`),
  inventory: [...Array.from({ length: 34 }, (_, i) => ({ name: `item_${i}`, count: 12 })), { name: 'bread', count: 4 }, { name: 'cooked_beef', count: 2 }],
  nearbyThreats: Array.from({ length: 8 }, (_, i) => ({ name: 'zombie', distance: 9 + i, id: 100 + i, position: { x: 210 + i, y: 45, z: 277 } })),
  nearbyEntities: Array.from({ length: 16 }, (_, i) => ({ name: i % 2 ? 'cow' : 'sheep', distance: 4 + i, id: 200 + i, position: { x: 190 + i, y: 64, z: 270 } })),
};

describe('the contract (mc.act, mc.view)', () => {
  it('its schemas fit the wire subset the body checks (anyOf of at most 4, 32 properties, depth 6)', () => {
    expect(skillSchema(ACT_INPUT_SCHEMA)).toBe(true);
    expect(skillSchema(VIEW_INPUT_SCHEMA)).toBe(true);
    expect(JSON.stringify(ACT_INPUT_SCHEMA).length).toBeLessThan(16_000);
  });

  it('takes the hands the owner asked for: shoot, an eye thrown and put in a frame, a drop toward a piglin, a pillar', () => {
    const input = { hands: [
      { do: 'shoot', target: '#12', item: 'bow', charge: 1, n: 3 },
      { do: 'use', item: 'ender_eye' },
      { do: 'use', item: 'ender_eye', at: [{ x: 1, y: 30, z: 2 }], face: 'up' },
      { do: 'drop', items: [{ item: 'gold_ingot', count: 1 }], target: 'piglin' },
      { do: 'pillarUp', n: 5, block: 'cobblestone' },
      { do: 'walk', path: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 1 }], sprint: true },
      { do: 'dig', at: [{ x: 0, y: -1, z: 1 }], rel: true },
      { do: 'attack', target: 'blaze', hold: true, seconds: 25 },
    ], stopIf: { hostileWithin: 8, hpBelow: 12 }, accept: ['blaze'] };
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(input as never)).toBeNull();
    expect(llmcInputProblem(MC_ACT_TOOL, input)).toBeNull();
  });

  it('refuses a field a hand does not take, a hand without what it needs, and more than 12 hands', () => {
    expect(actProblem({ hands: [{ do: 'walk', to: { x: 1, y: 2, z: 3 }, block: 'dirt' }] } as never)).toContain('block は使えない');
    expect(actProblem({ hands: [{ do: 'place', at: [{ x: 1, y: 2, z: 3 }] }] } as never)).toContain('block が要る');
    expect(actProblem({ hands: [{ do: 'furnace', at: [{ x: 1, y: 2, z: 3 }], op: 'put' }] } as never)).toContain('item か fuel');
    expect(actProblem({ hands: [{ do: 'chest', at: [{ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 }], op: 'look' }] } as never)).toContain('at は 1 つ');
    expect(llmcInputProblem(MC_ACT_TOOL, { hands: Array.from({ length: 13 }, () => ({ do: 'jump' })) })).toContain('形に合わない');
    expect(llmcInputProblem(MC_ACT_TOOL, { hands: [{ do: 'fly' }] })).toContain('形に合わない');
  });

  it('an act runs within its hands\' ceilings, 5 s to 170 s (r2: the body\'s bound is 180 s)', () => {
    expect(actMilliseconds({ hands: [{ do: 'eat' }] })).toBe(5_000);
    expect(actMilliseconds({ hands: [{ do: 'dig', at: Array.from({ length: 16 }, () => ({ x: 0, y: 0, z: 0 })) }] })).toBe(160_000);
    expect(actMilliseconds({ hands: Array.from({ length: 12 }, () => ({ do: 'dig' as const, at: Array.from({ length: 16 }, () => ({ x: 0, y: 0, z: 0 })) })) })).toBe(170_000);
  });
});

describe('the mode\'s tools', () => {
  const skill = (name: string, readOnly = false): MinecraftSkillDefinition => ({ name, description: `体の ${name}`, readOnly,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } });
  const definition = (name: string, description: string, readOnly: boolean): FcaToolDefinition => ({ name, description,
    input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body', effect: readOnly ? 'read' : 'write',
    cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });

  it('offers mc.act and mc.view in the head\'s own words and schema, and only the reads of the mode beside them', () => {
    const tools = llmcBodyDefinitions([skill('act'), skill('view', true), skill('move-to'), skill('find-blocks', true), skill('run-anything'),
      skill('goal-evidence', true)], definition);
    expect(tools.map(tool => tool.name)).toEqual([MC_ACT_TOOL, MC_VIEW_TOOL, 'mc.find-blocks', 'mc.goal-evidence']);
    expect(tools[0]!.nativeInputSchema).toBe(ACT_INPUT_SCHEMA);
    expect(tools[0]!.description).not.toContain('体の act');
    expect([...LLMC_READ_SKILLS].every(name => !name.startsWith('mc.'))).toBe(true);
    expect(llmcBodyDefinitions([skill('move-to')], definition)).toEqual([]);
  });

  const result = (extra: Partial<ActResult>): ActResult => ({ v: 1, ok: true, done: 2, of: 2, at: { x: 1, y: 64, z: 2 }, hp: 20, food: 18, ms: 2_300,
    lines: [{ i: 1, do: 'walk', status: 'done', line: '(0,64,0)→(1,64,2) 1.0秒' }, { i: 2, do: 'dig', status: 'done', line: '丸石×1 を得た' }], ...extra });
  const receipt = (value: ActResult | string, outcome: 'completed' | 'failed' = 'completed') => ({ id: 'r', connectionId: 'c', outcome,
    inputsReleased: true, observedAt: '2026-10-21T00:00:00Z', result: typeof value === 'string' ? value : JSON.stringify(value) });

  it('an act\'s result reads as one line a hand, without the map', () => {
    const text = llmcResult(MC_ACT_TOOL, receipt({ ...result({}), map: layersMap() }), null);
    expect(text.ok).toBe(true);
    expect(text.text).toContain('act 全部済み（2/2、2.3秒）');
    expect(text.text).toContain('2 dig 済 丸石×1 を得た');
    expect(text.text).not.toContain('地図 v1');
  });

  it('a stopped act fails; a reflex or an urgent cut is no failed step, and an act that did hands is progress', () => {
    const stopped = result({ ok: false, done: 1, stoppedBy: 'failure', lines: [{ i: 1, do: 'walk', status: 'done', line: '済み' },
      { i: 2, do: 'dig', status: 'stopped', line: '届かない (9,64,9) 距離5.2 そのマスは stone' }, { i: 3, do: 'place', status: 'skipped', line: '未実行' }] });
    const failed = llmcResult(MC_ACT_TOOL, receipt(stopped, 'failed'), null);
    expect(failed).toMatchObject({ ok: false, progressed: true });
    expect(failed.bodyReflex).toBeUndefined();
    expect(failed.text).toContain('2 dig 止 届かない');
    expect(llmcResult(MC_ACT_TOOL, receipt({ ...stopped, stoppedBy: 'reflex', stoppedWhy: '溶岩から上がった' }, 'failed'), null).bodyReflex).toBe(true);
    const urgent = llmcResult(MC_ACT_TOOL, receipt({ ...stopped, done: 0, stoppedBy: 'cancelled' }, 'failed'), 'zombie 4.0m');
    expect(urgent.text.startsWith('急ぎ: zombie 4.0m')).toBe(true);
    expect(urgent.bodyReflex).toBe(true);
  });

  it('a thrown eye says where it flew', () => {
    const text = actResultText(result({ eye: { from: { x: 0, y: 70, z: 0 }, bearingDeg: 123.4, flew: 12, to: { x: 10, y: 72, z: 7 }, broke: false } }));
    expect(text).toContain('方位 123.4° に 12 飛んだ（落ちた: 拾える）');
  });

  it('a view returns its map whole, stored whole', () => {
    const map = layersMap();
    const view = llmcResult(MC_VIEW_TOOL, receipt(JSON.stringify({ v: 1, map, landmarks: ['C 村の箱 (1,2,3)'] })), null);
    expect(view.text).toBe(`${map}\nC 村の箱 (1,2,3)`);
    expect(storedBodyResult(MC_VIEW_TOOL, view.text)).toBe(view.text);
    expect(storedBodyResult(MC_ACT_TOOL, 'x'.repeat(3_000))).toHaveLength(3_000);
  });

  it('asks ahead only for an act of four seconds or more', () => {
    expect(llmcLongCall({ name: MC_ACT_TOOL, input: { hands: [{ do: 'eat' }] } })).toBe(false);
    expect(llmcLongCall({ name: MC_ACT_TOOL, input: { hands: [{ do: 'dig', at: Array.from({ length: 6 }, () => ({ x: 0, y: 0, z: 0 })) }] } })).toBe(true);
    expect(llmcLongCall({ name: 'mc.find-blocks', input: {} })).toBe(false);
  });

  it('an urgent step: a hostile come within 6 m cuts the act, unless its own stopIf watches it', async () => {
    let threats: unknown[] = [{ name: 'zombie', distance: 12 }];
    const observe = () => frame({ nearbyThreats: threats });
    const watch = urgentWatch({ hands: [{ do: 'eat' }] }, observe, new AbortController().signal, 5);
    threats = [{ name: 'zombie', distance: 4 }];
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(watch.signal.aborted).toBe(true);
    expect(watch.reason()).toBe('zombie 4.0m');
    watch.stop();
    threats = [{ name: 'blaze', distance: 12 }];
    const accepted = urgentWatch({ hands: [{ do: 'eat' }], accept: ['blaze'] }, observe, new AbortController().signal, 5);
    threats = [{ name: 'blaze', distance: 3 }];
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(accepted.signal.aborted).toBe(false);
    accepted.stop();
    const own = urgentWatch({ hands: [{ do: 'eat' }], stopIf: { hostileWithin: 8 } }, observe, new AbortController().signal, 5);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(own.signal.aborted).toBe(false);
    own.stop();
  });
});

describe('the live state (design 2.2, 2.6): the map first, at most 3,000 tokens', () => {
  it('a full frame with the plan\'s path fits, the map whole and first', () => {
    const plan = planPath(seedPlan('エンドラを倒して')!);
    const planTokens = estimatedAnthropicTokens(plan);
    const live = minecraftLlmcLive({ observation: frame(FULL_WORLD), elapsedMinutes: 12.3, trend: createFoodTrend(), events: ['反射が mc.act を止めた'] }, planTokens);
    expect(Object.keys(live)[0]).toBe('map');
    expect(live.map).toBe(FULL_WORLD.localMap);
    expect(llmcLiveTokens(live) + planTokens).toBeLessThanOrEqual(LLMC_LIVE_TOKENS);
    expect(planTokens).toBeLessThan(400);
    expect(live.food).toMatchObject({ points: 85.6 });
    expect(live.state).toMatchObject({ at: '(201,45,277)', dimension: 'overworld', health: 18, food: 15, saturation: 3.5, minutes: 12.3 });
    expect(live.events).toEqual(['反射が mc.act を止めた']);
  });

  it('a 15×15×5 map of stone and air is counted at about 1,800 tokens (r2: count_tokens put such a map at 1,480–1,760)', () => {
    const tokens = llmcLiveTokens({ map: layersMap() });
    expect(tokens).toBeGreaterThan(1_500);
    expect(tokens).toBeLessThan(2_100);
  });

  it('food: points per item, and what went in the last five minutes', () => {
    expect(carriedFood({ inventory: [{ name: 'bread', count: 2 }, { name: 'mutton', count: 1 }, { name: 'stone', count: 9 }] }, {}))
      .toEqual({ points: 25.2, items: ['bread×2(22)', 'mutton×1(3.2)'] });
    let now = 0;
    const trend = createFoodTrend(() => now);
    trend.note(20, 5);
    now = 120_000; trend.note(19, 2);
    now = 240_000; trend.note(20, 4); // ate
    now = 290_000; trend.note(18, 4);
    expect(trend.lostIn5min()).toBe(6);
  });

  it('the body lifecycle of the mode: the map-first live state, and a recall only after an event', () => {
    let arrival = { at: 10 as number | null, kind: 'login' as string | null };
    const noted: string[] = [];
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {}, transient: () => ({ old: true }),
      noteResult: (call: { name: string }) => { noted.push(call.name); } };
    const plan = planPath(seedPlan('ネザーへ行って')!);
    const body = withLlmcBody(inner, { llmc: { plan: () => undefined, planView: () => plan }, taskId: 'w1', createdAt: new Date(Date.now() - 120_000).toISOString(),
      observe: () => frame(FULL_WORLD), arrival: () => arrival });
    body.context();
    expect(Object.keys(body.transient!())[0]).toBe('map');
    expect(body.recallWanted!()).toBe(false);
    body.noteResult!({ id: 'a', name: MC_ACT_TOOL, input: {} }, { ok: false, text: 'x', retryable: true, bodyReflex: true });
    expect(noted).toEqual([MC_ACT_TOOL]);
    arrival = { at: 20, kind: 'death' };
    body.context();
    expect(body.recallWanted!()).toBe(true);
    expect((body.transient!() as { events: string[] }).events).toHaveLength(2);
  });

  it('events are told once and are what a recall waits for', () => {
    const events = createLlmcEvents('t1');
    events.arrival(100, 'login');
    events.take();
    expect(events.wanted()).toBe(false);
    events.result('mc.act', false, true);
    events.arrival(200, 'death');
    expect(events.take()).toEqual(['反射が mc.act を止めた', '死んでリスポーンした（持ち物を落とした所へ戻るか決める）']);
    expect(events.wanted()).toBe(true);
    events.result('mc.act', true, false);
    expect(events.take()).toEqual([]);
    expect(events.wanted()).toBe(false);
  });
});

describe('the first plan (design 2.5, 2.6; owner: the whole game in the same shape)', () => {
  it('the goal of the dragon seeds the whole game, food before iron, the End last', () => {
    const tree = seedPlan('エンドラを倒して')!;
    const titles = tree.nodes.filter(node => node.parentId === null).map(node => node.title);
    expect(titles.findIndex(title => title.startsWith('食料'))).toBeLessThan(titles.findIndex(title => title.startsWith('鉄')));
    expect(titles.at(-1)).toBe('エンドでドラゴン');
    expect(titles).toContain('ブレイズロッド7以上');
    expect(tree.nodes.length).toBeLessThanOrEqual(64);
    expect(seedPlan('ネザーへ行って')!.nodes.filter(node => node.parentId === null).at(-1)!.title).toBe('ネザーに入る');
    expect(planGoal('家を建てて')).toBeNull();
  });

  it('the strong model\'s answer becomes a tree; a parent named after its child is left out', () => {
    const tree = planFromAnswer({ nodes: [
      { id: 'a', parent: '', title: '村を回る', where: '(196,69,237) 北40', doneWhen: '' },
      { id: 'a1', parent: 'a', title: 'ベッドを全部', where: '', doneWhen: 'ベッド3' },
      { id: 'b1', parent: 'b', title: '迷子', where: '', doneWhen: '' },
      { id: 'b', parent: '', title: '鉄', where: '', doneWhen: '' },
    ] })!;
    expect(tree.nodes.map(node => node.id)).toEqual(['a', 'a1', 'b']);
    expect(tree.nodes[0]!.where).toBe('(196,69,237) 北40');
    expect(planFromAnswer({ nodes: [] })).toBeNull();
  });

  it('seeds at once, takes the answer when it comes, and carries the nodes already done', async () => {
    let answer: (value: unknown) => void = () => {};
    const lines: string[] = [];
    const held0 = { schema: 'shannon.plan-tree.v1' as const, revision: 0, current: null, nodes: [] };
    startFirstPlan({ taskId: 't', goal: 'エンドラを倒して', held: held0, world: { position: { x: 1, y: 2, z: 3 } }, log: line => lines.push(line),
      planner: () => new Promise(resolve => { answer = resolve; }) });
    const seeded = firstPlanInbox.take('t', held0)!;
    expect(seeded.tree.nodes.length).toBeGreaterThan(30);
    const done = applyPlanUpdate(seeded.tree, { ops: [{ op: 'set', id: 'p1.1', state: 'done' }] }).tree;
    expect(firstPlanInbox.take('t', done)).toBeNull();
    answer({ nodes: [{ id: 'q1', parent: '', title: '木と石の道具', where: '', doneWhen: '' }, { id: 'q2', parent: 'q1', title: '原木を集める', where: '', doneWhen: '' },
      { id: 'q3', parent: '', title: '村を回る', where: '(196,69,237)', doneWhen: '' }] });
    await new Promise(resolve => setTimeout(resolve, 0));
    const taken = firstPlanInbox.take('t', done)!;
    expect(taken.tree.nodes.find(node => node.id === 'q2')!.state).toBe('done');
    expect(taken.tree.current).toBe('q3');
    expect(taken.tree.revision).toBe(done.revision + 1);
    expect(lines.some(line => line.startsWith('Shannon Minecraft first plan planned task=t nodes=3'))).toBe(true);
    // Asked once a task.
    startFirstPlan({ taskId: 't', goal: 'x', held: held0, world: null, log: () => {}, planner: () => { throw new Error('asked twice'); } });
    expect(carryDone(done, taken.tree).nodes.length).toBe(3);
  });
});

describe('the knowledge (owner 2026-10-21: through the dragon)', () => {
  it('the cached instructions hold the rules, the legend and the knowledge to the End', () => {
    for (const words of ['mc.act は 1 つ', MAP_LEGEND.split('\n')[1]!, '1/8', 'ブレイズロッド 7 本以上', '金の延べ棒を drop target=ピグリン',
      '2 マスの高さの天井', '三角測量', '出発の点検', 'ハーフブロック', 'warped_stem', 'accept: ["blaze"]', 'bastion', '[overworld]', '枠にはめる', 'クリスタル', 'ベッドの爆発', '奈落', '160〜200 点', '最初の夜の前（鉄より前）', '根こそぎ']) {
      expect(LLMC_SYSTEM_APPENDIX).toContain(words);
    }
  });
});

describe('the scene replay (one decision of any model on a frozen scene)', () => {
  it('builds the decision as a live one (core tools, live map, the plan at its node) and reads the act it answered', async () => {
    const scenes = JSON.parse(readFileSync(new URL('../../../scripts/minecraft-trials/llmc-scenes.example.json', import.meta.url), 'utf8')) as LlmcScene[];
    const input = sceneInput(scenes[0]!);
    expect(input.coreTools!.map(tool => tool.name)).toEqual([MC_ACT_TOOL, MC_VIEW_TOOL, 'plan.update']);
    expect(String((input.transient as { map: string }).map)).toContain('地図 v1 足=(201,45,277)');
    expect((input.plan as { now: string }).now).toContain('p3.2');
    const model: FcaModel = { toolResults: () => ({}), async decide() {
      return { history: [], decision: { kind: 'tools', calls: [{ id: 'a', name: MC_ACT_TOOL, input: { hands: [{ do: 'pillarUp', n: 7 },
        { do: 'furnace', at: [{ x: 202, y: 52, z: 277 }], op: 'take' }] } }] } };
    } };
    const answer = await sceneDecision(scenes[0]!, model);
    expect(answer).toMatchObject({ scene: 'furnace-7-up', decision: 'tools', hands: ['pillarUp', 'furnace'], problem: null });
  });
});

describe('the models (owner: chosen after the scene replay, each by the environment)', () => {
  it('main Sonnet, no raise (r5), the first plan by Opus by default; each name from the environment', () => {
    expect(llmcModelNames({})).toEqual({ main: 'claude-sonnet-5-5', escalate: null, plan: 'claude-opus-5-5' });
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next' })).toMatchObject({ escalate: 'claude-opus-5-5' });
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_MODEL: 'claude-haiku-5-5', SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'on' }))
      .toMatchObject({ main: 'claude-haiku-5-5', escalate: 'claude-sonnet-5-5' });
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_MODEL: 'claude-haiku-5-5', SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'claude-opus-5-5' }).escalate)
      .toBe('claude-opus-5-5');
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_MODEL: 'claude-opus-5-5', SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next' }).escalate).toBeNull();
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none' }).escalate).toBeNull();
    expect(llmcModelNames({ SHANNON_MINECRAFT_LLMC_MODEL: 'gpt-x', SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'claude-sonnet-5-5' }))
      .toMatchObject({ main: 'claude-sonnet-5-5', plan: 'claude-sonnet-5-5' });
  });

  it('a decision is raised while the task has failed twice in a row', () => {
    const main = { name: 'main' } as unknown as FcaModel, escalate = { name: 'up' } as unknown as FcaModel;
    expect(llmcModelRouter({ main, escalate }, { consecutiveToolFailures: 1 })).toBe(main);
    expect(llmcModelRouter({ main, escalate }, { consecutiveToolFailures: 2 })).toBe(escalate);
    expect(llmcModelRouter({ main, escalate: null }, { consecutiveToolFailures: 5 })).toBe(main);
  });
});
