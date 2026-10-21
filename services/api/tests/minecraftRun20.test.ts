import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/mind/tools/shannonTools.js';
import { fastBodyState, fastJudgment, type FastBodyState } from '../src/mind/action/reflex/fastJudgment.js';
import { forgetUnreachableWater, markWaterUnreachable, waterUnreachable } from '../src/surfaces/minecraft/minecraftProcedureWater.js';
import { minecraftProcedureFacts } from '../src/surfaces/minecraft/minecraftProcedureFacts.js';
import { finalFailure, minecraftStopWhy, minecraftUpkeep, passingFailure } from '../src/surfaces/minecraft/minecraftProcedureUpkeep.js';
import { minecraftProcedureStepParts } from '../src/surfaces/minecraft/minecraftProcedureTool.js';
import { createRoutePlanning, forgetRoutes, liveRoute } from '../src/surfaces/minecraft/minecraftRoutePlanner.js';
import { minecraftEnemyInSight, minecraftFrameNeeds } from '../src/surfaces/minecraft/minecraftWorkingArbiter.js';
import { dropsAdvice } from '../src/surfaces/minecraft/minecraftDropsAdvice.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { ProcedureMemory } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { AT, SimBody, setup, type Input } from './support/minecraftProcedureSim.js';

/**
 * mb-r20 (head side of run 20, 2026-10-20): water before the stair goes down, the obsidian in the order the surface, the lava, the rock,
 * the pack cleared before a dig, a pickaxe replaced before it breaks, a late step not told late when it began late, a route taken the
 * moment it comes, the sheep kept near the start, the bed left standing, two zombies not fought bare, and the care before a dig.
 */
beforeEach(() => { forgetUnreachableWater(); forgetRoutes(); });

const kit = (body: SimBody, items: Record<string, number>) => { for (const [name, count] of Object.entries(items)) body.add(name, count); return body; };
const none = (): ToolResult => ({ ok: true, text: '見つかりませんでした', retryable: false });
const WATER_CELLS = /^\(6\d, /u;

describe('the water, before the stair goes down', () => {
  it('fills the bucket on the surface the moment she is about to go down, not down below', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    const result = await setup(body).call({ milestone: 'ダイヤ' });
    expect(result.text).toContain('最後まで着いた');
    const scoop = body.calls.indexOf('mc.use-item-on-block'), down = body.calls.indexOf('mc.stair-mine');
    expect(scoop).toBeGreaterThanOrEqual(0);
    expect(scoop).toBeLessThan(down);
    expect(body.inputs.get('mc.use-item-on-block')![0]).toMatchObject({ itemName: 'bucket' });
    expect(body.pack.get('water_bucket')).toBe(1);
  });

  it('goes up the stair she dug for the water when none is near down below, then fills the bucket and casts the obsidian', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    let surfaceWater = false;
    const find = body.tool_find_blocks.bind(body);
    body.tool_find_blocks = (input: Input) => input.blockName === 'water' && !surfaceWater ? none() : find(input);
    const climb = body.tool_stair_mine.bind(body);
    body.tool_stair_mine = (input: Input) => { if (Number(input.targetY) >= 50) surfaceWater = true; return climb(input); };
    const { call } = setup(body, { batch: true });
    const results = [await call({ milestone: 'ダイヤ', through: '黒曜石' })];
    for (let again = 0; (body.pack.get('obsidian') ?? 0) < 10 && again < 3; again += 1) results.push(await call({ milestone: '黒曜石' }));
    expect(body.pack.get('obsidian'), results.map(item => item.text).join('\n---\n')).toBe(10);
    const ups = body.inputs.get('mc.stair-mine')!.map(input => input.targetY);
    // mb-r22: with no water known the stair goes down in legs of 32 that look again for water, and the climb for it is the last resort.
    expect(ups).toEqual([32, 0, -32, -58, 64]);
    expect(body.calls.indexOf('mc.use-item-on-block')).toBeGreaterThan(body.calls.lastIndexOf('mc.stair-mine'));
  });

  it('remembers the water she could not reach across tasks, and does not walk to the same lake again', async () => {
    const first = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    first.tool_move_to = () => ({ ok: false, text: '経路がありません', failure: 'failed', bodyFailure: 'no_path', retryable: true }) as ToolResult;
    await setup(first).call({ milestone: 'ダイヤ' });
    expect(first.calls.filter(name => name === 'mc.move-to').length).toBeGreaterThan(0);
    expect(waterUnreachable({ x: 60, y: 64, z: 5 })).toBe(true);
    // The task's extension: a new task, the same world, the same lake.
    const second = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    await setup(second).call({ milestone: 'ダイヤ' });
    expect(second.calls).not.toContain('mc.move-to');
    expect(second.calls.indexOf('mc.stair-mine')).toBeGreaterThanOrEqual(0);
  });

  it('does not count a walk that ran out of time while getting nearer as a failure, and walks on', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    let walks = 0;
    body.tool_move_to = () => {
      walks += 1;
      return walks <= 3 ? { ok: false, text: '時間切れ。目標へ近づいているので、同じ目標で再実行すれば続きから進めます', failure: 'failed', bodyFailure: 'movement_incomplete', retryable: true } as ToolResult
        : { ok: true, text: '移動しました', retryable: false };
    };
    const result = await setup(body).call({ milestone: 'ダイヤ' });
    expect(result.text).toContain('最後まで着いた');
    expect(walks).toBe(4);
    expect(body.pack.get('water_bucket')).toBe(1);
    expect(waterUnreachable({ x: 60, y: 64, z: 5 })).toBe(false);
    markWaterUnreachable({ x: 1, y: 2, z: 3 });
    expect(waterUnreachable({ x: 5, y: 2, z: 3 })).toBe(true);
    expect(waterUnreachable({ x: 20, y: 2, z: 3 })).toBe(false);
  });
});

describe('the obsidian, in the order the surface, the lava, the rock', () => {
  it('takes the obsidian the map remembers on the surface before any lava', async () => {
    const body = kit(new SimBody(), { diamond_pickaxe: 1, water_bucket: 1 });
    body.map = '黒曜石 2か所: 90m 東 (90,70,0) ×11、250m 北 (0,-55,-250) ×14';
    const result = await setup(body).call({ milestone: '黒曜石' });
    expect(result.text).toContain('最後まで着いた');
    expect(body.calls).toEqual(['mc.move-to', 'mc.mine-block']);
    expect(body.inputs.get('mc.move-to')![0]).toMatchObject({ x: 90, y: 70, z: 0 });
    expect(body.inputs.get('mc.mine-block')![0]).toMatchObject({ blockName: 'obsidian', count: 10, searchRadius: 16 });
  });

  it('digs the obsidian in the rock far off only last, when there is no surface obsidian and no lava', async () => {
    const body = kit(new SimBody(), { diamond_pickaxe: 1, water_bucket: 1 });
    body.tool_find_blocks = none;
    const result = await setup(body).call({ milestone: '黒曜石' });
    expect(result.text).toContain('最後まで着いた');
    expect(body.inputs.get('mc.mine-block')![0]).toMatchObject({ blockName: 'obsidian', searchRadius: 128 });
  });

  it('goes up before a portal on the surface when she is down below, and takes the lava near her first when she has the water', async () => {
    const portal = kit(new SimBody(), { diamond_pickaxe: 1, water_bucket: 1 });
    portal.y = -58;
    portal.map = '構造物: 荒廃したポータル: 60m 東 (60,66,0)（黒曜石11個）';
    await setup(portal).call({ milestone: '黒曜石' });
    expect(portal.calls[0]).toBe('mc.stair-mine');
    expect(portal.inputs.get('mc.stair-mine')![0]).toMatchObject({ targetY: 66 });
    const lava = kit(new SimBody(), { diamond_pickaxe: 1, water_bucket: 1 });
    lava.y = -58;
    lava.map = '構造物: 荒廃したポータル: 60m 東 (60,66,0)（黒曜石11個）\n溶岩の溜まり 1か所: 20m 南 (0,-58,20) 地下';
    await setup(lava, { batch: true }).call({ milestone: '黒曜石' });
    expect(lava.calls).not.toContain('mc.stair-mine');
    expect(lava.pack.get('obsidian')).toBe(10);
  });
});

describe('the care before a dig', () => {
  it('drops the rock beyond the blocks kept for a stair up before a dig under ground, the biggest stack first', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, stick: 4, crafting_table: 1, tuff: 100, andesite: 60, cobblestone: 20 });
    body.y = -58;
    await setup(body).call({ milestone: 'ダイヤ' });
    expect(body.calls.slice(0, 2)).toEqual(['mc.drop-item', 'mc.mine-block']);
    expect(body.inputs.get('mc.drop-item')![0]).toEqual({ itemName: 'tuff', count: 52 });
    expect(body.pack.get('cobblestone')).toBe(20);
    // 128 blocks are kept to build a stair up with: nothing to drop below that, unless the pack is full.
    const kept = kit(new SimBody(), { iron_pickaxe: 1, stick: 4, crafting_table: 1, tuff: 60, andesite: 30, cobblestone: 20 });
    kept.y = -58;
    await setup(kept).call({ milestone: 'ダイヤ' });
    expect(kept.calls).not.toContain('mc.drop-item');
  });

  it('makes a stone pickaxe before the iron dig when the one she has is about to break', async () => {
    const body = kit(new SimBody(), { stone_pickaxe: 1, oak_log: 6, cobblestone: 10, crafting_table: 1, stick: 4 });
    body.durability.set('stone_pickaxe', 5);
    await setup(body).call({ milestone: '鉄' });
    const craft = body.calls.indexOf('mc.craft-one'), dig = body.calls.indexOf('mc.mine-block');
    expect(body.inputs.get('mc.craft-one')![0]).toMatchObject({ itemName: 'stone_pickaxe' });
    expect(craft).toBeLessThan(dig);
  });

  it('eats and waits for health to come back before the stair, bare and below 16 of 20, and only a few times', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, stick: 4, crafting_table: 1 });
    body.health = 12;
    await setup(body).call({ milestone: 'ダイヤ' });
    const waits = body.calls.filter(name => name === 'mc.wait-time').length;
    expect(waits).toBe(3);
    expect(body.inputs.get('mc.wait-time')![0]).toMatchObject({ milliseconds: 16_000 });
    expect(body.calls.indexOf('mc.stair-mine')).toBeGreaterThan(body.calls.lastIndexOf('mc.wait-time'));
  });

  it('leaves the stair to the planner with health at 14 or less and an enemy within 24 m', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, stick: 4, crafting_table: 1 });
    body.health = 10;
    body.threats = [{ name: 'zombie', distance: 20, canReachMe: true }];
    const result = await setup(body).call({ milestone: 'ダイヤ' });
    expect(result.text).toContain('体力が少なく（10）敵が近い（zombie 20m）');
    expect(body.calls).not.toContain('mc.stair-mine');
  });

  it('eats the next food when one failed for this hunger, and ends nothing', () => {
    const body = kit(new SimBody(), { cooked_beef: 1, cooked_mutton: 2 });
    body.food = 10;
    const facts = minecraftProcedureFacts(body.observation());
    const memory = new ProcedureMemory();
    expect(minecraftUpkeep(facts, memory)?.item.input).toEqual({ itemName: 'cooked_beef' });
    memory.record('eat:10:cooked_beef', false, 'failed');
    expect(minecraftUpkeep(facts, memory)?.item.input).toEqual({ itemName: 'cooked_mutton' });
  });

  it('rel23: a meal refused because she is full (not_consumed) passes like a reflex, and does not stop the procedure', () => {
    expect(passingFailure('not_consumed')).toBe(true);
    expect(passingFailure('interrupted_by_reflex')).toBe(true);
    expect(passingFailure('inventory_full')).toBe(false);
    expect(finalFailure('not_consumed')).toBe(false);
  });

  it('rel23: the second furnace of the iron is set within reach of the first: she walks to the first one before placing it', async () => {
    const body = kit(new SimBody(), { raw_iron: 6, coal: 3, furnace: 2, stone_pickaxe: 1, crafting_table: 1, oak_planks: 8 });
    await setup(body).call({ milestone: '鉄' });
    const places = body.calls.flatMap((name, index) => name === 'mc.place-block-at' ? [index] : []);
    expect(places.length).toBeGreaterThanOrEqual(2);
    const between = body.calls.slice(places[0]! + 1, places[1]);
    expect(between).toContain('mc.move-to');
    expect(body.inputs.get('mc.move-to')!.find(input => input.range === 3)).toMatchObject({ x: 11, z: 2, range: 3 });
  });

  it('leaves the bed where it stands after the night, and does not offer it as a bed to take', async () => {
    const body = kit(new SimBody(), { white_bed: 1, iron_pickaxe: 1, stick: 4, crafting_table: 1 });
    body.night = true;
    await setup(body).call({ milestone: '鉄' });
    expect(body.inputs.get('mc.sleep-in-bed')![0]).toEqual({ isTakeBed: false });
    const frame = body.observation();
    const world = frame.state.world as { nearbyNeeds: unknown[]; rememberedPlaces?: unknown };
    world.nearbyNeeds = [{ id: 'bed:own', need: 'bed', name: 'white_bed', distance: 4, canReach: true, position: { x: 10, y: 64, z: 10 } },
      { id: 'bed:igloo', need: 'bed', name: 'red_bed', distance: 40, canReach: true, position: { x: 50, y: 64, z: 50 } }];
    expect(minecraftFrameNeeds(frame).map(need => need.id)).toEqual(['bed:own', 'bed:igloo']);
    world.rememberedPlaces = { respawn: '4m 北 (10,64,11)' };
    expect(minecraftFrameNeeds(frame).map(need => need.id)).toEqual(['bed:igloo']);
  });
});

describe('the iron pieces whose ingots are in hand, before more wood or a sheep', () => {
  it('makes the pickaxe, the sword and the bucket first when the ingots are carried at the wood step', async () => {
    const body = kit(new SimBody(), { iron_ingot: 8, oak_planks: 4, stick: 4, crafting_table: 1 });
    const { call } = setup(body);
    const first = await call({ milestone: '木材' });
    expect(body.inputs.get('mc.craft-one')!.map(input => input.itemName).filter(name => name !== 'stick').slice(0, 3), first.text)
      .toEqual(['iron_pickaxe', 'iron_sword', 'bucket']);
    expect(body.calls.indexOf('mc.mine-block')).toBeGreaterThan(body.inputs.get('mc.craft-one')!.length - 1);
  });
});

describe('the sheep, kept near the start and hunted by the colour she holds', () => {
  const sheepNeed = (id: string, color: string, distance: number) => ({ id, need: 'bed_wool', name: 'sheep', color, distance, canReach: true,
    position: { x: 10, y: 64, z: 10 } });
  it('hunts the colour she holds the most of, not the nearest sheep', async () => {
    const body = kit(new SimBody(), { stone_pickaxe: 1, white_wool: 2, black_wool: 1, porkchop: 6, oak_planks: 4 });
    const look = body.observation.bind(body);
    body.observation = () => {
      const frame = look();
      (frame.state.world as { nearbyNeeds: unknown[] }).nearbyNeeds.unshift(sheepNeed('s1', 'light_gray', 8), sheepNeed('s2', 'black', 12), sheepNeed('s3', 'white', 30));
      return frame;
    };
    await setup(body).call({ milestone: '食料と羊とベッド' });
    expect(body.inputs.get('mc.attack-continuously')![0]).toMatchObject({ entityName: 'sheep', color: 'white', maxKills: 1 });
  });

  it('does not walk to sheep beyond 160 m of where the task began, and says so (at dusk: by day the bed waits, mb-r23)', async () => {
    const body = kit(new SimBody(), { stone_pickaxe: 1, porkchop: 6, oak_planks: 4 });
    const look = body.observation.bind(body);
    body.observation = () => {
      const frame = look();
      (frame.state.world as { margin: unknown }).margin = { darkInSeconds: 100 };
      return frame;
    };
    body.tool_find_nearest_entity = () => ({ ok: true, text: 'sheepを発見: 座標(300.5, 64, 3.2), 距離110m', retryable: false });
    const result = await setup(body).call({ milestone: '食料と羊とベッド' });
    expect(result.text).toContain('羊が出発点から160m の外にしか見えない');
    expect(body.calls).not.toContain('mc.move-to');
  });
});

describe('a step that begins late is not told late', () => {
  it('tells a step that became late while it ran, once, and one that was late from its first look not at all', () => {
    const frame = (body => minecraftProcedureFacts(body.observation()))(kit(new SimBody(), { white_bed: 1 }));
    let now = AT + 400_000;
    const parts = () => ({ now: () => now, taskStartedAt: AT, toldLate: new Set<string>(), lateAtStart: new Map<string, boolean>() });
    // Began on time (400 s of a 420 s step), became late: told once.
    const ran = parts();
    expect(minecraftStopWhy(frame, '鉄', ran)).toBeNull();
    now = AT + 700_000;
    expect(minecraftStopWhy(frame, '鉄', ran)).toBe('「鉄」の目安420秒を280秒過ぎた（いま700秒）');
    expect(minecraftStopWhy(frame, '鉄', ran)).toBeNull();
    // Late from its first look (run 20: 560 s of a 420 s step, 0 items): never told in this run.
    const late = parts();
    expect(minecraftStopWhy(frame, '鉄', late)).toBeNull();
    now = AT + 900_000;
    expect(minecraftStopWhy(frame, '鉄', late)).toBeNull();
    // The old behaviour without the map: every late step is told.
    expect(minecraftStopWhy(frame, '鉄', { now: () => now, taskStartedAt: AT, toldLate: new Set<string>() })).toContain('目安420秒');
  });
});

describe('the route, taken the moment it comes', () => {
  const answer = { legs: [{ milestone: '鉄', goal: '洞窟で鉄', where: '南 55m', x: 1, y: 30, z: 55, targetSeconds: 400 }] };
  it('does not make a step wait for it, adopts the answer whenever it comes, and gives a procedure its budget from then on', async () => {
    const lines: string[] = [];
    let answerNow: (value: unknown) => void = () => {};
    const planning = createRoutePlanning({ kept: undefined, taskId: 'live-route', log: line => lines.push(line),
      planner: () => new Promise(resolve => { answerNow = resolve; }) });
    planning.situate({ milestoneName: '木', elapsedSeconds: 3 }, {});
    const started = Date.now();
    await planning.close();
    expect(Date.now() - started).toBeLessThan(200);
    expect(liveRoute('live-route')).toBeNull();
    const step = { taskId: 'live-route', scopeKey: 's', messageIds: [], snapshot: { task: { createdAt: new Date(AT).toISOString() }, checkpoint: null } };
    const parts = minecraftProcedureStepParts({ pendingMessageIds: () => [] } as never, step as never);
    expect(parts.targetSeconds('鉄')).toBeUndefined();
    answerNow(answer);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(liveRoute('live-route')?.legs).toHaveLength(1);
    // The same parts, handed out before the answer, now read it (the middle of a procedure).
    expect(parts.targetSeconds('鉄')).toBe(400);
    expect(lines.at(-1)).toMatch(/route planned task=live-route legs=1 reason=start askedMs=\d+/u);
    // The next step of the task holds it without its checkpoint.
    expect(createRoutePlanning({ kept: undefined, taskId: 'live-route', log: () => {} }).checkpoint().minecraftRoute?.legs).toHaveLength(1);
  });

  it('ends a request still out when a stopped step closes', async () => {
    let aborted = false;
    const planning = createRoutePlanning({ kept: undefined, taskId: 'stopped-route', log: () => {},
      planner: (_system, _input, signal) => new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(null); })) });
    planning.situate({ milestoneName: '木', elapsedSeconds: 3 }, {});
    await planning.close(true);
    expect(aborted).toBe(true);
  });
});

describe('two zombies, bare or hurt: up or in before the blows', () => {
  const zombie = (distance: number) => ({ name: 'zombie', distance, canReachMe: true, ignited: false });
  const state = (overrides: Partial<FastBodyState>): FastBodyState => ({ health: 20, threats: [], night: false, respawnedRecently: false, healthDropped: false,
    hasWeapon: true, floorActive: false, floorKnown: true, shelterFailed: false, resting: new Set(), canCage: false, canTower: false, ...overrides });
  const chosen = (value: FastBodyState) => {
    const verdict = fastJudgment(value);
    return 'decision' in verdict ? `${verdict.decision.rule}/${verdict.decision.skill}` : verdict.hold;
  };

  it('climbs a pillar before fighting two with no armour or health 14 or less, and walls herself in when she cannot climb', () => {
    const two = [zombie(3), zombie(4)];
    expect(chosen(state({ health: 13, threats: two, armorPieces: 0, canTower: true, canCage: true }))).toBe('outnumbered_tower/tower-up');
    expect(chosen(state({ health: 20, threats: two, armorPieces: 0, canTower: true }))).toBe('outnumbered_tower/tower-up');
    expect(chosen(state({ health: 13, threats: two, armorPieces: 4, canCage: true }))).toBe('outnumbered_cage/build-around-self');
    // After a pillar (resting) the cage; with neither, the fight as before.
    expect(chosen(state({ health: 13, threats: two, armorPieces: 0, canTower: true, canCage: true, resting: new Set(['tower-up']) }))).toBe('outnumbered_cage/build-around-self');
    expect(chosen(state({ health: 13, threats: two, armorPieces: 0 }))).toBe('melee_fight/attack-continuously');
  });

  it('still fights two when armoured and healthy, one when bare, and fights as before when the body does not say what she wears', () => {
    expect(chosen(state({ health: 20, threats: [zombie(3), zombie(4)], armorPieces: 4, canTower: true }))).toBe('melee_fight/attack-continuously');
    expect(chosen(state({ health: 20, threats: [zombie(3)], armorPieces: 0, canTower: true }))).toBe('melee_fight/attack-continuously');
    expect(chosen(state({ health: 13, threats: [zombie(3), zombie(4)], canTower: true }))).toBe('outnumbered_tower/tower-up');
    expect(chosen(state({ health: 20, threats: [zombie(3), zombie(4)], canTower: true }))).toBe('melee_fight/attack-continuously');
  });

  it('goes up a pillar rather than building a cage while being hit at 6 or less', () => {
    const hit = [zombie(2)];
    expect(chosen(state({ health: 6, threats: hit, canTower: true, canCage: true, healthDropped: true }))).toBe('low_health_tower/tower-up');
    expect(chosen(state({ health: 6, threats: hit, canCage: true, healthDropped: true }))).toBe('low_health_shelter/dig-shelter');
  });

  it('reads the armour she wears from the body\'s one line', () => {
    const read = (worn: string | undefined) => fastBodyState({ facts: {}, state: { world: { health: 10, nearbyThreats: [], ...(worn !== undefined ? { worn } : {}) } } },
      { earlierHealth: null, sinceArrivalMs: null });
    expect(read('頭: iron_helmet(残り100/165)、胴: なし、脚: iron_leggings(残り200/225)、足: なし').armorPieces).toBe(2);
    expect(read('頭: なし、胴: なし、脚: なし、足: なし').armorPieces).toBe(0);
    expect(read(undefined).armorPieces).toBeUndefined();
  });
});

describe('a wait in a shelter is not cut for what is in reach', () => {
  const frame = (threats: unknown[], danger = false): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: new Date(AT).toISOString(),
    receivedAt: new Date(AT).toISOString(), connected: true, facts: { danger }, state: { world: { nearbyThreats: threats } } } as never);
  it('sees an enemy at the slit whether or not it can reach her', () => {
    expect(minecraftEnemyInSight(frame([{ name: 'spider', distance: 20, canReachMe: false }]))).toBe(true);
    expect(minecraftEnemyInSight(frame([{ name: 'spider', distance: 30, canReachMe: true }]))).toBe(false);
    expect(minecraftEnemyInSight(frame([], true))).toBe(true);
    expect(minecraftEnemyInSight(frame([]))).toBe(false);
    expect(minecraftEnemyInSight(null)).toBe(false);
  });
});

describe('the drops of a death, weighed against the walk', () => {
  const world = (lost: string[], place = '178m 南 (-125,75,839)') => ({ dimension: 'overworld', lastDeath: 'ゾンビに倒された。落とし物は拾いに戻れる',
    deaths: [{ dimension: 'overworld', lostItems: lost }], rememberedPlaces: { death: place } });
  const advice = (value: ReturnType<typeof world>) => dropsAdvice(value, carriedItemCounts({ inventory: value.deaths[0]!.lostItems }, {}));
  it('says how far, how long, and which drops are worth fetching', () => {
    const iron = advice(world(['iron_pickaxe×1', 'water_bucket×1', 'stone_axe×1']))!;
    expect(iron).toContain('死んだ所まで178m（歩いて約71秒');
    expect(iron).toContain('iron_pickaxe・water_bucket');
    expect(iron).toContain('遠い');
    expect(advice(world(['stone_pickaxe×1', 'stone_axe×1', 'oak_planks×8']))).toContain('その場で作り直すほうが早い');
    expect(dropsAdvice({ ...world(['iron_pickaxe×1']), rememberedPlaces: {} }, new Map([['iron_pickaxe', 1]]))).toBeNull();
    expect(dropsAdvice(world(['iron_pickaxe×1']), null)).toBeNull();
  });
});
