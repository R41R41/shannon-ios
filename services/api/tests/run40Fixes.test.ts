import { afterEach, describe, expect, it } from 'vitest';
import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { forgetActNodes, followNode, noteItemStart, planNowOf, PREP_NOTE, isPrepNode } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { descentNote, foodLeads } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';

/**
 * Run 40 (2026-10-27, rel56, Sonnet): the preparation (food hunted, the descent's things) was never the plan's current node, because two items for the iron moved the now at
 * 265 s; and the descent note named 「ベッド ×6」 as where food is. A preparation node that is open holds the current node, and says so in the live.
 */
afterEach(() => forgetActNodes());
type Row = readonly [id: string, parent: string | null, title: string, doneWhen?: string];
function treeOf(rows: readonly Row[], current: string | null): PlanTree {
  const order = new Map<string | null, number>();
  const nodes: PlanNode[] = rows.map(([id, parent, title, doneWhen]) => {
    const next = order.get(parent) ?? 0;
    order.set(parent, next + 1);
    return { id, parentId: parent, order: next, title, state: 'continue', ...(doneWhen ? { doneWhen } : {}) };
  });
  return { schema: 'shannon.plan-tree.v1', revision: 1, current, nodes };
}
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });

const ROWS: Row[] = [['p1', null, '村を回る'], ['p3', null, '食料を集める（狩り）', 'food>=40'], ['p3.1', 'p3', 'タイガで動物を狩る'], ['p4', null, '地下の準備'],
  ['p5', null, '鉄の装備'], ['p5.1', 'p5', '洞窟で鉄を掘る', 'have:iron_ingot>=24'], ['p6', null, 'ダイヤ', 'have:diamond>=3']];

describe('a preparation node holds the current node', () => {
  it('knows the nodes of food, hunting and preparing, and a doneWhen of food points', () => {
    expect(isPrepNode({ title: '食料を集める（狩り）' })).toBe(true);
    expect(isPrepNode({ title: '地下の準備' })).toBe(true);
    expect(isPrepNode({ title: '村のかまどで肉を焼く', doneWhen: 'food>=40' })).toBe(true);
    expect(isPrepNode({ title: '洞窟で鉄を掘る', doneWhen: 'have:iron_ingot>=24' })).toBe(false);
  });
  it('does not follow two items for the iron while the food node is the current one (run 40: p3 and p4 were never the now)', () => {
    const tree = treeOf(ROWS, 'p3.1');
    noteItemStart('t1', 'p5.1', 'p3.1');
    noteItemStart('t1', 'p5.1', 'p3.1');
    expect(followNode('t1', tree)).toBeNull();
  });
  it('follows as before when the current node is no preparation, or the work is for the preparation itself or under it', () => {
    const plain = treeOf(ROWS, 'p1');
    noteItemStart('t2', 'p5.1', 'p1');
    noteItemStart('t2', 'p5.1', 'p1');
    expect(followNode('t2', plain)).toEqual({ to: 'p5.1', from: 'p1', acts: 2 });
    const prep = treeOf(ROWS, 'p4');
    noteItemStart('t3', 'p3.1', 'p4');
    noteItemStart('t3', 'p3.1', 'p4');
    expect(followNode('t3', prep)).toEqual({ to: 'p3.1', from: 'p4', acts: 2 });
  });
  it('lets the current node go once the preparation node is done', () => {
    const tree = treeOf(ROWS, 'p3.1');
    const done = { ...tree, nodes: tree.nodes.map(node => node.id === 'p3.1' || node.id === 'p3' ? { ...node, state: 'done' as const } : node) };
    noteItemStart('t4', 'p5.1', 'p3.1');
    noteItemStart('t4', 'p5.1', 'p3.1');
    expect(followNode('t4', { ...done, current: 'p3.1' })).toEqual({ to: 'p5.1', from: 'p3.1', acts: 2 });
  });
  it('says in the live that the preparation node stays the now while it is not met, and says nothing once it is', () => {
    const tree = treeOf(ROWS, 'p3');
    const hungry = frame({ position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'sweet_berries', count: 6 }], dimension: 'overworld' });
    expect(planNowOf(tree, null, hungry)).toContain(PREP_NOTE);
    const fed = frame({ position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'cooked_beef', count: 4 }], dimension: 'overworld' });
    expect(planNowOf(tree, null, fed)).not.toContain(PREP_NOTE);
    const iron = treeOf(ROWS, 'p5.1');
    expect(planNowOf(iron, null, hungry)).not.toContain(PREP_NOTE);
  });
});

describe('the descent note and the food leads do not name a bed', () => {
  const surface = frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: [{ name: 'sweet_berries', count: 6 }],
    scan: { dimension: 'overworld', rows: ['ベッド ×6 最寄り (10,64,12) 東 10m', '村の鐘 ×1 最寄り (9,64,30) 南 30m', '畑・作物 ×4 最寄り (5,64,36) 南 36m'] } });
  it('leaves the beds out of where food is, and keeps the bell and the fields', () => {
    const leads = foodLeads(surface.state.world as Record<string, unknown>, 'overworld');
    expect(leads).not.toContain('ベッド');
    expect(leads).toContain('村の鐘');
    expect(leads).toContain('畑');
  });
  it('a descent with only beds in sight says no food is near, not that beds are', () => {
    const beds = frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: [{ name: 'sweet_berries', count: 6 }],
      scan: { dimension: 'overworld', rows: ['ベッド ×6 最寄り (10,64,12) 東 10m'] } });
    const note = descentNote({ hands: [{ do: 'go', to: { x: 3, y: 36, z: 4 } }] }, beds)!;
    expect(note).toContain('地下 y=36 へ下りる手');
    expect(note).not.toContain('ベッド');
    expect(note).not.toContain('近くに');
  });
});
