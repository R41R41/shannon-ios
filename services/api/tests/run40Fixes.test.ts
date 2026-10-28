import { afterEach, describe, expect, it } from 'vitest';
import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { forgetActNodes, followNode, noteItemStart, planNowOf, PREP_NOTE, isPrepNode } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { descentNote, foodLeads } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { v2tree } from './helpers/planTreeV2.js';

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
  return v2tree({ revision: 1, current, nodes });
}
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });

const ROWS: Row[] = [['p1', null, '村を回る'], ['p3', null, '食料を集める（狩り）', 'food>=40'], ['p3.1', 'p3', 'タイガで動物を狩る'], ['p4', null, '地下の準備'],
  ['p5', null, '鉄の装備'], ['p5.1', 'p5', '洞窟で鉄を掘る', 'have:iron_ingot>=24'], ['p6', null, 'ダイヤ', 'have:diamond>=3']];

describe('a preparation node holds the current node', () => {
  it('knows the nodes of the kinds food and prep_descent, and nothing that a title or a doneWhen says (chapter 7)', () => {
    expect(isPrepNode({ kind: 'food' })).toBe(true);
    expect(isPrepNode({ kind: 'prep_descent' })).toBe(true);
    expect(isPrepNode({ kind: 'iron' })).toBe(false);
    expect(isPrepNode({ kind: 'village' })).toBe(false);
    expect(isPrepNode({})).toBe(false);
  });
  it('does not follow two items for the iron while the food node is the current one (run 40: p3 and p4 were never the now)', () => {
    const tree = treeOf(ROWS, 'p3.1');
    noteItemStart('t1', 'p5.1', 'p3.1');
    noteItemStart('t1', 'p5.1', 'p3.1');
    expect(followNode('t1', tree)).toBeNull();
  });
  it('follows as before when no preparation node is open before the work, or the work is for the preparation itself or under it', () => {
    const closed = treeOf(ROWS, 'p1');
    const prepDone = { ...closed, nodes: closed.nodes.map(node => ['p3', 'p3.1', 'p4'].includes(node.id) ? { ...node, state: 'done' as const } : node) };
    noteItemStart('t2', 'p5.1', 'p1');
    noteItemStart('t2', 'p5.1', 'p1');
    expect(followNode('t2', prepDone)).toMatchObject({ to: 'p5.1', from: 'p1', acts: 2 });
    const prep = treeOf(ROWS, 'p4');
    noteItemStart('t3', 'p3.1', 'p4');
    noteItemStart('t3', 'p3.1', 'p4');
    expect(followNode('t3', prep)).toMatchObject({ to: 'p3.1', from: 'p4', acts: 2 });
  });
  it('lets the current node go once the preparation node is done', () => {
    const tree = treeOf(ROWS, 'p3.1');
    const done = { ...tree, nodes: tree.nodes.map(node => ['p3', 'p3.1', 'p4'].includes(node.id) ? { ...node, state: 'done' as const } : node) };
    noteItemStart('t4', 'p5.1', 'p3.1');
    noteItemStart('t4', 'p5.1', 'p3.1');
    expect(followNode('t4', { ...done, current: 'p3.1' })).toMatchObject({ to: 'p5.1', from: 'p3.1', acts: 2 });
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

/**
 * Run 41 (2026-10-27, rel57 never held): the current node was p2.3 「石の道具を作る」 and two items for p4.1 「洞窟で鉄鉱石」 moved it over p1.3 (food) and p3 (the preparation before the
 * descent), so no preparation node was ever the now and `heldByPreparation` had nothing to hold. The current node is put on the preparation node open before the destination.
 */
describe('the current node goes to the open preparation node before the destination (run 41)', () => {
  const RUN41: Row[] = [['p1', null, '村と食料'], ['p1.3', 'p1', '食料を集める（箱・畑・干し草）', 'food>=40'], ['p2', null, '木と石の道具'], ['p2.3', 'p2', '石の道具を作る', 'have:stone_pickaxe&have:stone_axe'],
    ['p3', null, '地下の準備', 'have:crafting_table&have:planks>=8&food>=40'], ['p4', null, '鉄を掘る'], ['p4.1', 'p4', '洞窟で鉄鉱石', 'have:raw_iron>=30'], ['p4.2', 'p4', 'かまどで焼く', 'have:iron_ingot>=30']];
  const withDone = (tree: PlanTree, ids: string[]): PlanTree => ({ ...tree, nodes: tree.nodes.map(node => ids.includes(node.id) ? { ...node, state: 'done' as const } : node) });
  it('p2.3 with two items for p4.1: the first open preparation node, p1.3, becomes the now; with p1.3 done, p3', () => {
    const tree = treeOf(RUN41, 'p2.3');
    noteItemStart('r1', 'p4.1', 'p2.3');
    noteItemStart('r1', 'p4.1', 'p2.3');
    expect(followNode('r1', tree)).toMatchObject({ to: 'p1.3', from: 'p2.3', acts: 2 });
    noteItemStart('r2', 'p4.1', 'p2.3');
    noteItemStart('r2', 'p4.1', 'p2.3');
    const found = followNode('r2', withDone(tree, ['p1', 'p1.3']));
    expect(found).toMatchObject({ to: 'p3', from: 'p2.3', acts: 2 });
    expect(found!.words).toContain('今の節を [p3] 地下の準備 に置いた');
    expect(found!.words).toContain('札は [p4.1] のまま、手は止めていない');
  });
  it('through the plan: the now is p3, the tags are not touched, and further items for p4.1 are held by the open preparation (rel57)', () => {
    const lines: string[] = [];
    const tree = withDone(treeOf(RUN41, 'p2.3'), ['p1', 'p1.3']);
    noteItemStart('r3', 'p4.1', 'p2.3');
    noteItemStart('r3', 'p4.1', 'p2.3');
    const plan = createFcaPlanTools({ taskId: 'r3', checkpoint: { fcaPlanTree: tree }, rules: true, compact: true, log: line => lines.push(line), follow: held => followNode('r3', held) });
    const view = plan.port.view()!;
    expect(plan.port.tree().current).toBe('p3');
    expect(view.note).toContain('今の節を [p3] 地下の準備 に置いた');
    expect(lines.filter(line => line.startsWith('Shannon FCA plan followed task=r3'))).toHaveLength(1);
    // The model goes on with p4.1: the items are sent under the new now, p3, which is open and a preparation node.
    noteItemStart('r3', 'p4.1', 'p3');
    noteItemStart('r3', 'p4.1', 'p3');
    plan.port.view();
    expect(plan.port.tree().current).toBe('p3');
    expect(lines.filter(line => line.includes('followed'))).toHaveLength(1);
    // The live says so beside the node while its condition is not met.
    const hungry = frame({ position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'spruce_log', count: 2 }], dimension: 'overworld' });
    expect(planNowOf(plan.port.tree(), null, hungry)).toContain(PREP_NOTE);
  });
  it('when the model says the preparation is skipped (blocked with a reason), the now goes on to the work', () => {
    const tree = treeOf(RUN41, 'p2.3');
    const skipped = { ...tree, nodes: tree.nodes.map(node => node.id === 'p1.3' || node.id === 'p3' ? { ...node, state: 'blocked' as const } : node) };
    noteItemStart('r4', 'p4.1', 'p2.3');
    noteItemStart('r4', 'p4.1', 'p2.3');
    const found = followNode('r4', skipped);
    expect(found).toMatchObject({ to: 'p4.1', from: 'p2.3' });
    expect(found!.words).toContain('今の節を [p4.1] に進めた');
    expect(found!.words).toContain('飛ばした節は順のまま残っている');
  });
  it('a move on names the open nodes it passed', () => {
    const tree = treeOf([['p1', null, '村を回る'], ['p2', null, '木と石の道具'], ['p2.1', 'p2', '原木を集める'], ['p5', null, '鉄'], ['p5.1', 'p5', '洞窟で鉄鉱石']], 'p1');
    noteItemStart('r5', 'p5.1', 'p1');
    noteItemStart('r5', 'p5.1', 'p1');
    expect(followNode('r5', tree)!.words).toContain('飛ばした節は順のまま残っている: [p2.1] 原木を集める');
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
