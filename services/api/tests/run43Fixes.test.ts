import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, PLAN_TREE_SCHEMA, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { foodFill, foodPointsWords } from '../src/surfaces/minecraft/minecraftFoodWords.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { planNowOf } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { descentNote, enemyNear, fuelShortage, recoveryLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { meterLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { doneFacts, doneStatusWords, seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';

/**
 * Run 43 (2026-10-27, Sonnet, rel60): 39.6 food points said 「40/40」 while `food>=40` judged them short (p3 the now for 2,126 s); a furnace out of
 * fuel waited before for about 600 s; the descent to the diamonds had no table and no planks (270 s back up); the pack filled (bread not made, about
 * 60 s); she fought the drowned at health 10 instead of eating, down to 0.3.
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const pack = (items: Array<[string, number]>) => items.map(([name, count]) => ({ name, count }));
const node = (id: string, title: string, doneWhen: string, state: PlanNode['state'] = 'continue'): PlanNode => {
  const parentId = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null;
  return { id, parentId, order: Number(id.slice(id.lastIndexOf(id.includes('.') ? '.' : 'p') + 1)) - 1, title, state, ...(doneWhen ? { doneWhen } : {}) };
};
/** Run 43's plan at +283 (revision 6, from its commands): the village and the tools done, p3 the now. */
const run43Tree = (): PlanTree => ({ schema: PLAN_TREE_SCHEMA, revision: 6, current: 'p3', nodes: [
  node('p1', '村を回る', 'have:bed>=1&food>=20', 'done'),
  node('p2', '木と石の道具', 'have:stone_pickaxe&have:stone_axe&have:stone_sword', 'done'),
  node('p3', '食料40点と下る準備', 'food>=40&have:crafting_table|food>=40&have:planks>=4'),
  node('p4', '鉄を掘り装備', 'have:iron_chestplate&have:iron_leggings&have:iron_helmet&have:shield&have:bucket'),
  node('p4.1', '鉄を掘る', 'have:iron_ingot>=30|have:iron_chestplate'),
  node('p4.2', '防具・盾・バケツ', 'have:iron_chestplate&have:iron_leggings&have:iron_helmet&have:shield&have:bucket'),
  node('p5', 'ダイヤと金', 'have:diamond_pickaxe&have:golden_boots'),
  node('p6', 'エンドラを倒す', ''),
] });
/** +402: bread 2, sweet berries 6, potatoes 2 (39.6 points), a table and 7 planks. */
const AT_402: Array<[string, number]> = [['bread', 2], ['sweet_berries', 6], ['potato', 2], ['crafting_table', 1], ['spruce_planks', 7], ['blue_bed', 1]];
const surface = (items: Array<[string, number]>, extra: Record<string, unknown> = {}) => frame({ dimension: 'overworld', position: { x: 160, y: 66, z: 200 },
  inventory: pack(items), health: 20, food: 20, ...extra });

describe('run 43: the food points are one number, said and judged', () => {
  it('says 39.6/40 with what is short and what fills it, and judges it short (not 「40/40」)', () => {
    expect(foodPointsWords(39.6, 40)).toBe('食料 39.6/40 点（あと 0.4 点: potato 1 個）');
    expect(foodPointsWords(40, 40)).toBe('食料 40/40 点');
    expect(foodPointsWords(39.6)).toBe('食料 39.6 点');
    expect(foodFill(2)).toBe('sweet_berries 1 個');
    expect(foodFill(30)).toBe('bread 3 個');
    const facts = doneFacts(surface(AT_402));
    expect(facts!.food).toBe(39.6);
    const status = doneStatusWords(run43Tree().nodes.find(item => item.id === 'p3')!.doneWhen, facts)!;
    expect(status).toContain('食料 39.6/40 点（あと 0.4 点: potato 1 個）');
    expect(status).not.toContain('40/40');
    expect(planNowOf(run43Tree(), null, surface(AT_402))).toContain('食料 39.6/40 点');
    const meter = meterLine(run43Tree(), surface(AT_402), 2_104 / 60)!;
    expect(meter).toContain('今 食料 39.6/40 点（あと 0.4 点: potato 1 個）・作業台 有・板 7');
    expect(meter).not.toContain('40/40');
  });
  it('closes p3 with one bread more, and the now moves on', () => {
    expect(seenDoneUpdate(run43Tree(), surface(AT_402))?.ids ?? []).not.toContain('p3');
    const more = surface(AT_402.map(([name, count]) => [name, name === 'bread' ? 3 : count] as [string, number]));
    const seen = seenDoneUpdate(run43Tree(), more)!;
    expect(seen.ids).toContain('p3');
    const result = applyPlanUpdate(run43Tree(), seen.update);
    expect(result.problem ?? null).toBeNull();
    expect(result.tree.current).toBe('p4.1');
  });
  it('says the same food in the recovery line and the descent note', () => {
    expect(recoveryLine(16, 14, 39.6, carriedItemCounts({ inventory: pack(AT_402) }, {}))).toContain('食料 39.6 点）');
    const note = descentNote({ hands: [{ do: 'go', to: { x: 165, y: 7, z: 215 } }] }, surface([['sweet_berries', 6]]))!;
    expect(note).toContain('食料 14.4/40 点（あと 25.6 点: bread 3 個）');
  });
});

describe('run 43: the fuel is a lack of its own', () => {
  // +720: raw_iron ×15 and one plank, the coal ore ×10 at (195,44,215) on the map.
  const world = { position: { x: 193, y: 35, z: 212 }, inventory: pack([['raw_iron', 15], ['spruce_planks', 1], ['crafting_table', 1]]),
    mapLandmarks: ['S スポナー (133,-5,229) 西60・南17・下43 湧く: zombie', 'c 石炭[coal_ore] (195,44,215) 東2・南3・上9 ×10 見えている'] };
  it('says the coal the raw iron needs, and the coal on the map with its distance', () => {
    expect(fuelShortage(world, carriedItemCounts(world, {})))
      .toBe('燃料: 焼く物 15 個に石炭 2 が要る（石炭 1 で 8 個、板 1 枚は 1.5 個。板 1 は作業台と道具の分）。地図の石炭 (195,44,215) ×10 が 10m');
  });
  it('is not said with coal enough, nothing to smelt, or says that no coal is in sight', () => {
    const coal = { ...world, inventory: pack([['raw_iron', 15], ['coal', 2]]) };
    expect(fuelShortage(coal, carriedItemCounts(coal, {}))).toBeNull();
    const none = { ...world, inventory: pack([['cobblestone', 64]]) };
    expect(fuelShortage(none, carriedItemCounts(none, {}))).toBeNull();
    const blind = { ...world, mapLandmarks: [] };
    expect(fuelShortage(blind, carriedItemCounts(blind, {}))).toContain('地図に石炭は見えていない');
  });
});

describe('run 43: the descent to the diamonds checks the table too', () => {
  // +1,291 q95: from y≈14 to y=-56, no table, no planks.
  const deep = (items: Array<[string, number]>) => frame({ dimension: 'overworld', position: { x: 160, y: 14, z: 210 }, inventory: pack(items), health: 20, food: 20 });
  const down = { hands: [{ do: 'go', to: { x: 156, y: -56, z: 208 } }] };
  it('says it with no table and no planks, and what to do first', () => {
    const note = descentNote(down, deep([['iron_pickaxe', 1], ['bread', 2]]))!;
    expect(note).toBe('作業台 無・板 0: y=-56 へ下りる手を受け付けた。下では木が見つかりにくく、作業台の要る物（ダイヤのツルハシ・鉄の道具）は作れない。原木は持っていない');
    expect(descentNote(down, deep([['oak_log', 2]]))).toContain('原木 2 を持っている（原木 1 で板 4。作業台は板 4）');
  });
  it('is not said with a table or 4 planks, or for a short step', () => {
    expect(descentNote(down, deep([['crafting_table', 1]]))).toBeNull();
    expect(descentNote(down, deep([['oak_planks', 4]]))).toBeNull();
    expect(descentNote({ hands: [{ do: 'go', to: { x: 160, y: 8, z: 210 } }] }, deep([]))).toBeNull();
  });
});

describe('run 43: the pack says what to drop before it is full', () => {
  const stacks = (name: string, n: number) => Array.from({ length: Math.ceil(n / 64) }, (_, i) => `${name}×${Math.min(64, n - 64 * i)}`);
  const lines = (free: number) => {
    const filler = [...stacks('cobblestone', 192), ...stacks('cobbled_deepslate', 128), ...stacks('diorite', 40)];
    const rest = Array.from({ length: 36 - free - filler.length }, (_, i) => `item_${i}×1`);
    return [...filler, ...rest];
  };
  it('at 3 free slots or fewer, names what to drop and keeps a stack for pillars', () => {
    const out = packLines(lines(2));
    expect(out[0]).toBe('持ち物の空き 2 マス（使用 34/36。満杯だと dig・pickup が「満杯」で止まる）');
    expect(out[1]).toBe('空きが 2 マス。満杯になると make・pickup・dig の物が入らず止まる（実走 43 はパンを作れず約 60 秒、go も満杯で止まった）。'
      + '捨てる物の候補: cobblestone×128（2 マス）・cobbled_deepslate×128（2 マス）・diorite×40（1 マス）。cobblestone 1 スタックは柱と橋に残す。drop で捨てる');
  });
  it('is not said with 4 free slots', () => {
    expect(packLines(lines(4)).join('\n')).not.toContain('捨てる物の候補');
  });
});

describe('run 43: eat before a fight', () => {
  const near = { nearbyThreats: [{ name: 'drowned', distance: 2.1 }] };
  it('is a rule of the instructions (GPT review 2026-10-28), not a line of the recovery fact; the recovery line says the fact only', () => {
    expect(enemyNear(near)).toBe(true);
    expect(enemyNear({ nearbyThreats: [{ name: 'zombie', distance: 14 }] })).toBe(false);
    const counts = carriedItemCounts({ inventory: pack([['bread', 1]]) }, {});
    expect(recoveryLine(16, 10, 11, counts)).not.toContain('戦う前に');
    expect(recoveryLine(16, 10, 11, counts)).not.toContain('実走 42');
    expect(V2_ALWAYS).toContain('敵が近くても 1 個食べてから');
    expect(V2_ALWAYS).toContain('落下や矢 2〜3 発で死ぬ');
  });
});

describe('run 43: the always text does not grow', () => {
  it('stays under 8,800', () => {
    expect(llmcTokens(minecraftV2System(V2_ALWAYS))).toBeLessThan(8_800);
  });
});
