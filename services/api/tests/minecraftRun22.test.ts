import { beforeEach, describe, expect, it } from 'vitest';
import { ProcedureMemory } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import type { ToolResult } from '../src/mind/tools/shannonTools.js';
import { minecraftSkillResult, withoutGoldAdvice } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { minecraftProcedureFacts } from '../src/surfaces/minecraft/minecraftProcedureFacts.js';
import { foodMove, FOOD_ENOUGH } from '../src/surfaces/minecraft/minecraftProcedureFood.js';
import { bestWater, tripSeconds, waterDetour } from '../src/surfaces/minecraft/minecraftProcedureTrip.js';
import { afterRefusal, meanwhileOres, refusals } from '../src/surfaces/minecraft/minecraftProcedureWaits.js';
import { framesSteady, SETTLE, settledBody } from '../src/surfaces/minecraft/minecraftProcedureSettle.js';
import { forgetUnreachableWater } from '../src/surfaces/minecraft/minecraftProcedureWater.js';
import { ironMove, type ProcedureTaskStore } from '../src/surfaces/minecraft/minecraftProceduresIron.js';
import { runMinecraftProcedure, type ProcedureRunParts } from '../src/surfaces/minecraft/minecraftProcedureTool.js';
import { nextFiller } from '../src/surfaces/minecraft/minecraftFillers.js';
import { SimBody, setup, type Input } from './support/minecraftProcedureSim.js';

/**
 * mb-r22 (head side of Minecraft run 22, 2026-10-21): the water before the stair goes down, a wait the body refuses, the food of the
 * opening, the obsidian's lava near the diamonds, a body that has just come back, and the golden pickaxe the body keeps naming.
 */
beforeEach(() => { forgetUnreachableWater(); });

const at = new Date().toISOString();
const frame = (world: Record<string, unknown>, sequence = 1): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence, stateAt: at, receivedAt: at,
  connected: true, state: { world: { dimension: 'overworld', health: 20, food: 20, margin: { darkInSeconds: 300 }, position: { x: 0, y: 64, z: 0 }, inventory: [],
    nearbyThreats: [], jobs: [], ...world } }, facts: { dimension: 'overworld', danger: false } } as unknown as BodyObservation);
const pack = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
const factsOf = (world: Record<string, unknown>) => minecraftProcedureFacts(frame(world));
const store = (): ProcedureTaskStore => ({ furnaces: [], visited: new Set() });
const move = (value: ReturnType<typeof ironMove>) => value.kind === 'do' ? value.item : null;
const kit = (body: SimBody, items: Record<string, number>) => { for (const [name, count] of Object.entries(items)) body.add(name, count); return body; };
const none = (): ToolResult => ({ ok: true, text: '見つかりませんでした', retryable: false });

describe('what a trip costs (run 22: 155 s to climb 130 blocks, 95 s to drop 97, 1.5 s a metre through rock)', () => {
  it('takes the longer of the height and the way, and a quarter of the shorter', () => {
    expect(tripSeconds({ x: 0, y: 64, z: 0 }, { x: 0, y: 194, z: 0 })).toBeCloseTo(156, 0);
    expect(tripSeconds({ x: 0, y: 40, z: 0 }, { x: 0, y: -57, z: 0 })).toBeCloseTo(97, 0);
    expect(tripSeconds({ x: 0, y: 70, z: 0 }, { x: 78, y: 70, z: 0 })).toBeCloseTo(35, 0);
    expect(tripSeconds({ x: 0, y: 20, z: 0 }, { x: 16, y: 20, z: 0 })).toBeCloseTo(24, 0);
  });

  it('weighs a water by the detour from where she is going next: the one on the way down costs least, the one under a cave more', () => {
    const from = { x: 0, y: 44, z: 0 }, deep = [{ x: 0, y: -58, z: 0 }];
    const near = { x: 20, y: 44, z: 5 }, far = { x: 90, y: 44, z: 5 };
    expect(waterDetour(from, near, deep)).toBeLessThan(waterDetour(from, far, deep));
    expect(bestWater(from, [far, near], deep, 90)?.cell).toEqual(near);
    expect(bestWater(from, [far], deep, 90)).toBeUndefined();
    // On the way down a water below her is cheaper than one beside her.
    const below = { x: 4, y: -10, z: 0 };
    expect(waterDetour(from, below, deep)).toBeLessThan(waterDetour(from, near, deep));
    expect(bestWater(null, [far, near], deep, 0)?.cell).toEqual(far);
  });
});

describe('the water before the stair goes down, from wherever she stands (run 22: the bucket was made 40 blocks under ground)', () => {
  it('fills the bucket from the water found within 64 m before the stair, under ground too', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    body.y = 44;
    const find = body.tool_find_blocks.bind(body);
    body.tool_find_blocks = (input: Input) => input.blockName === 'water' ? { ok: true, text: '(20, 44, 5) 距離20m', retryable: false } : find(input);
    await setup(body).call({ milestone: 'ダイヤ' });
    const scoop = body.calls.indexOf('mc.use-item-on-block'), down = body.calls.indexOf('mc.stair-mine');
    expect(scoop).toBeGreaterThanOrEqual(0);
    expect(scoop).toBeLessThan(down);
    expect(body.inputs.get('mc.move-to')![0]).toMatchObject({ x: 20, y: 44, z: 5 });
    expect(body.inputs.get('mc.find-blocks')![0]).toMatchObject({ blockName: 'water', maxDistance: 64 });
    expect(body.pack.get('water_bucket')).toBe(1);
  });

  it('goes to a water the map remembers when the body finds none, if that costs less than the climb', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    body.y = 70;
    body.map = '水源 1か所: 60m 南 (0,40,60)';
    body.tool_find_blocks = none;
    await setup(body).call({ milestone: 'ダイヤ' });
    expect(body.inputs.get('mc.move-to')![0]).toMatchObject({ x: 0, y: 40, z: 60 });
    expect(body.calls.indexOf('mc.use-item-on-block')).toBeLessThan(body.calls.indexOf('mc.stair-mine'));
  });

  it('goes down in legs of 32 looking again for water at the foot of each, while the bucket is empty and no water is known', async () => {
    const body = kit(new SimBody(), { iron_pickaxe: 1, bucket: 1, stick: 4, crafting_table: 1 });
    body.tool_find_blocks = none;
    await setup(body).call({ milestone: 'ダイヤ' });
    const targets = body.inputs.get('mc.stair-mine')!.map(input => input.targetY);
    expect(targets.slice(0, 3)).toEqual([32, 0, -32]);
    expect(body.inputs.get('mc.find-blocks')!.filter(input => input.blockName === 'water').length).toBeGreaterThanOrEqual(4);
  });

  it('for the obsidian takes the water that lies by the lava the map knows, not the climb to the surface (run 22: 229 s)', async () => {
    const body = kit(new SimBody(), { diamond_pickaxe: 1, bucket: 1 });
    body.y = -58;
    body.map = '水源 1か所: 96m 北 (-81,16,52)\n溶岩の溜まり 1か所: 86m 北東 (-80,15,32)';
    const find = body.tool_find_blocks.bind(body);
    body.tool_find_blocks = (input: Input) => input.blockName === 'water' ? none() : find(input);
    await setup(body, { batch: true }).call({ milestone: '黒曜石' });
    expect(body.inputs.get('mc.move-to')![0]).toMatchObject({ x: -81, y: 16, z: 52 });
    expect(body.inputs.get('mc.stair-mine') ?? []).toEqual([]);
    expect(body.calls.indexOf('mc.use-item-on-block')).toBeGreaterThan(body.calls.indexOf('mc.move-to'));
  });

  it('walks under ground to a lava pool near the diamonds rather than up to the surface and down again', async () => {
    const body = kit(new SimBody(), { diamond_pickaxe: 1, water_bucket: 1 });
    body.y = -58;
    body.map = '溶岩の溜まり 1か所: 86m 北東 (-80,15,32)';
    const find = body.tool_find_blocks.bind(body);
    let lavaLooks = 0;
    body.tool_find_blocks = (input: Input) => input.blockName === 'lava' && (lavaLooks += 1) === 1 ? none() : find(input);
    await setup(body, { batch: true }).call({ milestone: '黒曜石' });
    expect(body.inputs.get('mc.move-to')![0]).toMatchObject({ x: -80, y: 15, z: 32 });
    expect(body.inputs.get('mc.stair-mine') ?? []).toEqual([]);
    expect(body.pack.get('obsidian')).toBe(10);
  });
});

describe('a wait the body refuses is not a failure of the procedure (run 22: 627 s and 649 s, wait_refused twice)', () => {
  const REFUSAL = '待ちを断りました: かまどの仕事 (12,64,2)のraw_iron×8 残り約80秒。その間にできること: mine-block で近くのiron_ore (8, 60, 3) 約9m・'
    + 'coal_ore (1, 62, 3) 約4mを掘る。終わった頃に withdraw-from-furnace で取り出す。';
  const done = { iron_pickaxe: 2, iron_sword: 1, water_bucket: 1, flint_and_steel: 1, stone_pickaxe: 1, coal: 8, cobblestone: 20, oak_planks: 12, stick: 8, crafting_table: 1 };
  const world = (remaining: number) => ({ inventory: pack(done), jobs: [{ position: { x: 12, y: 64, z: 2 }, remainingEstimateMs: remaining, input: 'raw_iron', count: 8 }],
    worn: '頭: iron_helmet、胴: iron_chestplate、脚: iron_leggings、足: iron_boots' });
  const s = () => ({ furnaces: [{ x: 12, y: 64, z: 2 }], visited: new Set<string>() });

  it('reads the ores the body names, nearest first', () => {
    expect(meanwhileOres(REFUSAL)).toEqual([{ name: 'coal_ore', distance: 4 }, { name: 'iron_ore', distance: 9 }]);
    expect(meanwhileOres('待ちを断りました: 夜を待つこと。その間にできること: 原木を集める。')).toEqual([]);
  });

  it('takes the refusal as a wait done, digs the ore it named once, then waits in beats the body never refuses', () => {
    const memory = new ProcedureMemory();
    const wait = move(ironMove(factsOf(world(80_000)), memory, s()))!;
    expect(wait).toMatchObject({ tool: 'mc.wait-time' });
    expect(wait.accepts!('wait_refused', REFUSAL)).toBe(true);
    expect(wait.accepts!('failed', 'x')).toBe(false);
    expect(refusals(memory)).toBe(1);
    const dig = move(ironMove(factsOf(world(78_000)), memory, s()))!;
    expect(dig).toMatchObject({ tool: 'mc.mine-block', input: { blockName: 'coal_ore', count: 3, searchRadius: 12 } });
    // A dig that finds nothing ends nothing; one that works is not done again for the same refusal.
    expect(dig.accepts!('target_not_found', '')).toBe(true);
    expect(dig.accepts!('inventory_full', '')).toBe(false);
    dig.then!('ok');
    const short = move(ironMove(factsOf(world(70_000)), memory, s()))!;
    expect(short).toMatchObject({ tool: 'mc.wait-time', input: { milliseconds: 5_000 } });
    expect(afterRefusal(memory, 70_000).item.input).toEqual({ milliseconds: 5_000 });
  });

  it('asks the body for no wait that holds the furnace after a refusal, also in the last twenty seconds', () => {
    const memory = new ProcedureMemory();
    const first = move(ironMove(factsOf(world(15_000)), memory, s()))!;
    expect(first).toMatchObject({ tool: 'mc.withdraw-from-furnace', input: { waitForCompletion: true } });
    expect(first.accepts!('wait_refused', REFUSAL)).toBe(true);
    const next = move(ironMove(factsOf(world(15_000)), memory, s()))!;
    expect(next.input).not.toMatchObject({ waitForCompletion: true });
  });

  it('runs on through a refusal in the executor: the run is not failed and the planner is not handed a failed call', async () => {
    const body = kit(new SimBody(), { stone_pickaxe: 1, coal: 8, cobblestone: 20, oak_planks: 12, stick: 8, crafting_table: 1, iron_pickaxe: 1, iron_sword: 1,
      water_bucket: 1, flint_and_steel: 1, raw_iron: 8, furnace: 1 });
    body.tool_wait_time = (input: Input) => Number(input.milliseconds) > 5_000
      ? { ok: false, text: REFUSAL, failure: 'failed', bodyFailure: 'wait_refused', retryable: true } as ToolResult
      : { ok: true, text: '待機しました', retryable: false };
    const result = await setup(body).call({ milestone: '鉄の全身の防具' });
    expect(result.text).not.toContain('できなかった: wait_refused');
    expect(result.text).not.toContain('2回できなかった');
  });
});

describe('the furnace that has nothing ready yet is not a failed call (run 22: four parts taken out counted as failed)', () => {
  it('accepts waiting_external with or without the words of a part taken, and does not ask for the same part again at once', () => {
    const memory = new ProcedureMemory();
    const lacking = { inventory: pack({ stone_pickaxe: 1, coal: 8, cobblestone: 20, oak_planks: 12, stick: 8, crafting_table: 1 }),
      jobs: [{ position: { x: 12, y: 64, z: 2 }, remainingEstimateMs: 30_000, input: 'raw_iron', count: 8 }] };
    const part = move(ironMove(factsOf(lacking), memory, { furnaces: [{ x: 12, y: 64, z: 2 }], visited: new Set() }))!;
    expect(part).toMatchObject({ tool: 'mc.withdraw-from-furnace', input: { waitForCompletion: false } });
    expect(part.accepts!('waiting_external', '完成品はまだありません')).toBe(true);
    expect(part.accepts!('waiting_external', '完成済みのiron_ingot×5を回収しました。')).toBe(true);
    expect(part.accepts!('material_missing', '燃料')).toBe(false);
    const again = move(ironMove(factsOf(lacking), memory, { furnaces: [{ x: 12, y: 64, z: 2 }], visited: new Set() }));
    expect(again?.tool).not.toBe('mc.withdraw-from-furnace');
  });
});

describe('the food of the opening (run 22: 130 s on chickens with the sheep taken already)', () => {
  const animal = (name: string, distance: number, need = 'food') => ({ id: `${need}:${name}:${distance}`, need, name, distance, canReach: true });
  const near = (items: ReturnType<typeof animal>[], inventory: Record<string, number> = {}) => factsOf({ nearbyNeeds: items, inventory: pack(inventory) });

  it('does not hunt with the food enough, nor the chickens when a cow or a sheep is near; gives up a kind that failed', () => {
    const memory = new ProcedureMemory();
    expect(foodMove(near([animal('chicken', 10)], { cooked_mutton: FOOD_ENOUGH }), memory)).toBeNull();
    const first = foodMove(near([animal('chicken', 14), animal('cow', 24)]), memory);
    expect(first?.kind === 'do' && first.item.input).toMatchObject({ entityName: 'cow' });
    const sheep = foodMove(near([animal('chicken', 14), animal('sheep', 20, 'bed_wool')], { mutton: 1 }), memory);
    expect(sheep?.kind === 'do' && sheep.item.input).toMatchObject({ entityName: 'sheep' });
    // The body could not hit a chicken: it is given up (the failure counts as nothing), the next kind is tried.
    const chicken = foodMove(near([animal('chicken', 6), animal('pig', 40)]), memory);
    expect(chicken?.kind === 'do' && chicken.item.input).toMatchObject({ entityName: 'chicken' });
    if (chicken?.kind !== 'do') throw new Error('no hunt');
    expect(chicken.item.accepts!('failed', 'chicken に攻撃できませんでした')).toBe(true);
    const next = foodMove(near([animal('chicken', 6), animal('pig', 40)]), memory);
    expect(next?.kind === 'do' && next.item.input).toMatchObject({ entityName: 'pig' });
  });

  it('looks only near when some food is carried, further when little, once blind at most, and stops after two misses', () => {
    const memory = new ProcedureMemory();
    expect(foodMove(near([animal('cow', 40)], { mutton: 3 }), memory)).toBeNull();
    const far = foodMove(near([animal('cow', 40)], { mutton: 2 }), memory);
    expect(far?.kind === 'do' && far.item.input).toMatchObject({ entityName: 'cow' });
    const blind = foodMove(near([]), new ProcedureMemory());
    expect(blind?.kind === 'do' && blind.item.input).toMatchObject({ entityName: 'food_animals', maxDistance: 32 });
    const worn = new ProcedureMemory();
    worn.notes.set('food:misses', 2);
    expect(foodMove(near([animal('cow', 5)]), worn)).toBeNull();
  });

  it('leaves a food animal alone in a wait or after a call when the pack holds the stock (6)', () => {
    const wait = (inventory: Record<string, number>) => nextFiller(frame({ inventory: pack(inventory), nearbyNeeds: [animal('cow', 5)] }),
      { remainingMs: 60_000, recent: new Set(), waitingCell: null });
    expect(wait({})?.tool).toBe('mc.attack-continuously');
    expect(wait({ cooked_beef: 6 })).toBeNull();
  });
});

describe('a body that has just come back is not given a procedure until its frames come steadily (run 22: frozen again 9 s after the resume)', () => {
  const steady = (from: number) => Array.from({ length: 12 }, (_, i) => from + i * 400);

  it('judges the frames by their gaps', () => {
    expect(framesSteady(steady(0), 4_800)).toBe(true);
    expect(framesSteady([0, 400], 800)).toBe(false);
    expect(framesSteady([1_000, 1_400, 1_800, 2_200], 2_200 + SETTLE.maxGapMs + 500)).toBe(false);
    expect(framesSteady([100, 300, 3_000, 3_200, 3_400], 3_500)).toBe(false);
  });

  it('waits for the arrival to be old enough and the frames steady, then lets the procedure go', async () => {
    let clock = 100_000, sequence = 0;
    const waited: number[] = [];
    const parts = { arrivedAt: () => clock - 1_000, now: () => clock, observe: () => frame({}, (sequence += 1)),
      sleep: async (ms: number) => { waited.push(ms); clock += ms; } };
    expect(await settledBody(parts, new AbortController().signal)).toBeNull();
    expect(waited.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(SETTLE.afterArrivalMs - 1_000);
    // A body that arrived long ago is not asked to settle.
    waited.length = 0;
    expect(await settledBody({ ...parts, arrivedAt: () => clock - 10 * 60_000 }, new AbortController().signal)).toBeNull();
    expect(await settledBody({ ...parts, arrivedAt: () => null }, new AbortController().signal)).toBeNull();
    expect(waited).toEqual([]);
  });

  it('gives the turn back with the reason when no frame comes, and the executor starts no item', async () => {
    let clock = 100_000;
    const executed: string[] = [];
    const parts: ProcedureRunParts = { taskId: 'settle', observe: () => frame({}, 7), now: () => clock, arrivedAt: () => clock - 2_000,
      sleep: async (ms: number) => { clock += ms; },
      execute: async item => { executed.push(item.name); return { ok: true, text: '', retryable: false }; }, offered: () => true };
    const result = await runMinecraftProcedure(parts, { operationId: 'o', input: { milestone: '木' }, signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('体が戻ってまだ落ち着いていない');
    expect(executed).toEqual([]);
  });
});

describe('the golden pickaxe the body keeps naming (run 22: on nearly every result)', () => {
  const NOTE = '道具の補充: stoneをiron_pickaxeで掘っています。より安く済むgolden_pickaxeは材料が足りず作れません（不足: gold_ingot×3）。';
  const receipt = (result: string, outcome: 'completed' | 'failed' = 'completed') => ({ outcome, result } as unknown as MinecraftControlReceipt);

  it('is not told to the planner or the procedures; other restocking notes are', () => {
    expect(withoutGoldAdvice(`stoneを6個採掘しました。${NOTE}`)).toBe('stoneを6個採掘しました。');
    expect(withoutGoldAdvice(`stoneを6個採掘しました。\n${NOTE}\n拾いました。`)).toBe('stoneを6個採掘しました。\n拾いました。');
    expect(withoutGoldAdvice(NOTE)).toBe('（道具の補充の知らせだけの結果）');
    const stone = '道具の補充: stoneをiron_pickaxeで掘っています。より安く済むstone_pickaxeは材料が足りず作れません（不足: stick×2）。';
    expect(withoutGoldAdvice(stone)).toBe(stone);
    expect(withoutGoldAdvice('そのまま')).toBe('そのまま');
    expect(minecraftSkillResult(receipt(`掘りました。${NOTE}`)).text).toBe('掘りました。');
    expect(minecraftSkillResult(receipt(`掘れませんでした。${NOTE}`, 'failed')).text).not.toContain('golden_pickaxe');
  });
});
