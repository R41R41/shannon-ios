import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, PLAN_TREE_SCHEMA, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { planNowOf } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { meterLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { belowTheSurface, doneFacts, seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';

/**
 * Run 44 (2026-10-28, report: p2.2 「箱と畑で食料」 `food>=40` the now from +154 for about 609 s, the meter's 「地下の準備 … 遅れ」 all along, and a climb back
 * up for food of 131 s and more) and run 43 (p3 「食料40点と下る準備」 the now for 2,126 s): a node of the preparation before the descent cannot be met
 * once she is down (she eats, the points go down). It is closed when the body is below the surface, with what was lacking in its note.
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const pack = (items: Array<[string, number]>) => items.map(([name, count]) => ({ name, count }));
const at = (y: number, items: Array<[string, number]>, dimension = 'overworld') => frame({ dimension, position: { x: 160, y, z: 200 }, inventory: pack(items), health: 20, food: 20 });
const node = (id: string, title: string, doneWhen: string, state: PlanNode['state'] = 'continue'): PlanNode => {
  const parentId = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null;
  return { id, parentId, order: Number(id.slice(id.lastIndexOf(id.includes('.') ? '.' : 'p') + 1)) - 1, title, state, ...(doneWhen ? { doneWhen } : {}) };
};
/** Run 43's plan at +283 (as in run43Fixes.test.ts). */
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
/** Run 44's own plan (the task's checkpoint, revision 10, read from the head's database after the run): p2.2 the now; the End's preparation p11 `food>=80`. */
const run44Tree = (): PlanTree => {
  const tree = JSON.parse(fs.readFileSync(new URL('./fixtures/run44-plan-tree.json', import.meta.url), 'utf8')) as PlanTree;
  // As at +176, when she went down to the iron: p4.1 and p4.2 not begun yet.
  return { ...tree, nodes: tree.nodes.map(item => (item.id === 'p4.1' || item.id === 'p4.2' ? { ...item, state: 'continue' as const } : item)) };
};
/** +402 of run 43: 39.6 points, a table, 7 planks; and the same pack after a meal down there. */
const RUN43_PACK: Array<[string, number]> = [['bread', 2], ['sweet_berries', 6], ['potato', 2], ['crafting_table', 1], ['spruce_planks', 7], ['blue_bed', 1]];
const RUN43_DOWN: Array<[string, number]> = [['bread', 1], ['sweet_berries', 6], ['potato', 2], ['crafting_table', 1], ['spruce_planks', 7], ['blue_bed', 1]];
/** +176 of run 44: an iron pickaxe and boots from the chest, 39.6 points, a table and one plank (the live's 「食料39.6/40・作業台有・板1」). */
const RUN44_PACK: Array<[string, number]> = [['bread', 2], ['sweet_berries', 6], ['potato', 2], ['crafting_table', 1], ['spruce_planks', 1], ['purple_bed', 1],
  ['iron_pickaxe', 1], ['iron_boots', 1], ['iron_ingot', 6]];

describe('run 43 and run 44: the preparation before the descent ends when she goes down', () => {
  it('run 43: p3 stays the now on the surface, and is closed down at the iron with what was short; the now and the meter move on', () => {
    expect(seenDoneUpdate(run43Tree(), at(66, RUN43_PACK))?.ids ?? []).not.toContain('p3');
    const seen = seenDoneUpdate(run43Tree(), at(14, RUN43_DOWN))!;
    expect(seen.ids).toContain('p3');
    expect(seen.descended).toEqual(['p3']);
    const note = seen.update.ops?.find(op => 'id' in op && op.id === 'p3' && 'note' in op) as { note?: string } | undefined;
    expect(note?.note).toMatch(/^下りる前の準備の節: 地下 y=14 へ下りたので閉じた（下りた時に足りなかった物: 食料 \d+(\.\d)?\/40 点/u);
    const result = applyPlanUpdate(run43Tree(), seen.update);
    expect(result.problem ?? null).toBeNull();
    expect(result.tree.current).toBe('p4.1');
    expect(planNowOf(result.tree, null, at(14, RUN43_DOWN))).not.toContain('食料40点と下る準備');
    // The meter's preparation is reached by the node closed (`doneInPlan`): no 「地下の準備 … 遅れ」 any more.
    expect(meterLine(run43Tree(), at(14, RUN43_DOWN), 600 / 60)).toContain('地下の準備');
    expect(meterLine(result.tree, at(14, RUN43_DOWN), 600 / 60)).not.toContain('地下の準備');
    // Back on the surface later (fuel, food): it stays closed.
    expect(seenDoneUpdate(result.tree, at(70, [['bread', 1]]))?.ids ?? []).not.toContain('p3');
  });

  it('run 44: p2.2, its parent p2 and p3 close at the iron (y=30), the now goes to the iron; the End\'s preparation p11 stays open, in the Nether too', () => {
    const tree = run44Tree();
    expect(tree.current).toBe('p2.2');
    expect(seenDoneUpdate(tree, at(66, RUN44_PACK))?.descended).toBeUndefined();
    const seen = seenDoneUpdate(tree, at(30, RUN44_PACK))!;
    expect(seen.descended).toEqual(['p2', 'p2.2', 'p3']);
    const notes = Object.fromEntries((seen.update.ops ?? []).filter(op => 'note' in op).map(op => [(op as { id: string }).id, (op as { note?: string }).note]));
    expect(notes['p2.2']).toBe('下りる前の準備の節: 地下 y=30 へ下りたので閉じた（下りた時に足りなかった物: 食料 39.6/40 点（あと 0.4 点: potato 1 個））');
    expect(notes.p3).toContain('食料 39.6/40 点');
    const result = applyPlanUpdate(tree, seen.update);
    expect(result.problem ?? null).toBeNull();
    expect(result.tree.current).toBe('p4.1');
    expect(result.tree.nodes.find(item => item.id === 'p11')?.state).toBe('continue');
    // The Nether is below the surface too, and closes none of what comes after the iron.
    const nether = seenDoneUpdate(result.tree, at(70, RUN44_PACK, 'the_nether'));
    expect(nether?.descended ?? []).toEqual([]);
    expect(belowTheSurface(doneFacts(at(70, RUN44_PACK, 'the_nether'))!)).toBe(true);
    expect(belowTheSurface(doneFacts(at(64, RUN44_PACK))!)).toBe(false);
  });
});
