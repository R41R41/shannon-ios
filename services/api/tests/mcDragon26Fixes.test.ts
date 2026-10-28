import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { forgetActNodes, followNode, noteItemStart } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { doneFacts, doneStatusWords, nodesSeenDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { descentNote } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { isDragonPlan, meterLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { approaching, urgentRange } from '../src/surfaces/minecraft/minecraftLlmcUrgent.js';
import { urgentFacts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { urgentWatch } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { nearThreats } from '../src/surfaces/minecraft/minecraftLlmcThreat.js';
import { PREP_RULES_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';

/**
 * 「エンドラを討伐して」 of 2026-10-26 (rel49, Sonnet; the dragon check's fixes 1, 3, 5 and 6): the plan's current node follows the node the model keeps working
 * on, a consumed material's node is done by what it was made into, a descent with too little food is said, a hostile behind rock does not cut an act, and the
 * meter keeps a milestone that was passed over.
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
const pack = (...items: Array<[string, number]>) => items.map(([name, count]) => ({ name, count }));

describe('fix 1: the current node follows the node of the items the body starts, two in a row (run 39: back to the rel52 rule)', () => {
  const rows: Row[] = [['p1', null, '原木を集める', 'have:log>=8'], ['p5', null, '石炭を掘る', 'have:coal>=8'], ['p6', null, '地下のベッドを取る', 'have:bed>=1'],
    ['p7', null, '鉄を掘る', 'have:iron_ingot>=24']];
  it('does not move for one item; moves when two in a row started for another node, and leaves the nodes passed open', () => {
    const tree = treeOf(rows, 'p1');
    expect(followNode('t1', tree)).toBeNull();
    noteItemStart('t1', 'p7', 'p1');
    expect(followNode('t1', tree)).toBeNull();
    noteItemStart('t1', 'p7', 'p1');
    expect(followNode('t1', tree)).toMatchObject({ to: 'p7', from: 'p1', acts: 2 });
    const moved = applyPlanUpdate(tree, { ops: [], current: 'p7' }).tree;
    expect(moved.current).toBe('p7');
    expect(moved.nodes.filter(node => node.state === 'done')).toEqual([]);
    expect(followNode('t1', moved)).toBeNull();
  });
  it('does not move when the two are for different nodes, or an item for the current node comes between, or the plan\'s current node changed since they were sent', () => {
    const tree = treeOf(rows, 'p1');
    noteItemStart('t2', 'p5', 'p1');
    noteItemStart('t2', 'p7', 'p1');
    expect(followNode('t2', tree)).toBeNull();
    noteItemStart('t2', 'p7', 'p1');
    noteItemStart('t2', 'p1', 'p1');
    expect(followNode('t2', tree)).toBeNull();
    noteItemStart('t2', 'p7', 'p1');
    noteItemStart('t2', 'p7', 'p1');
    expect(followNode('t2', { ...tree, current: 'p5' })).toBeNull();
    noteItemStart('t2', null);
    expect(followNode('t2', { ...tree, current: 'p1' })).toMatchObject({ to: 'p7', from: 'p1', acts: 2 });
  });
  it('does not move for no node, the current node, a done node, a node above the current one or a node holding it; a parent\'s tag neither counts nor breaks a run', () => {
    const tree = treeOf(rows, 'p1');
    noteItemStart('t3', 'p7', 'p1');
    noteItemStart('t3', 'p7', 'p1');
    const done = { ...tree, nodes: tree.nodes.map(node => node.id === 'p7' ? { ...node, state: 'done' as const } : node) };
    expect(followNode('t3', done)).toBeNull();
    expect(followNode('t3', { ...tree, current: 'p7' })).toBeNull();
    const nested = treeOf([['p1', null, '木'], ['p2', null, '鉄'], ['p2.1', 'p2', '掘る'], ['p3', null, '食料']], 'p2.1');
    noteItemStart('t4', 'p3', 'p2.1');
    noteItemStart('t4', 'p2', 'p2.1');
    noteItemStart('t4', 'p3', 'p2.1');
    expect(followNode('t4', nested)).toMatchObject({ to: 'p3', from: 'p2.1', acts: 2 });
    noteItemStart('t5', 'p2', 'p2.1');
    noteItemStart('t5', 'p2', 'p2.1');
    expect(followNode('t5', nested)).toBeNull();
  });
  it('goes to the first open leaf of a node with children', () => {
    const tree = treeOf([['p1', null, '木'], ['p2', null, '鉄'], ['p2.1', 'p2', '掘る'], ['p2.2', 'p2', '焼く']], 'p1');
    noteItemStart('t6', 'p2', 'p1');
    noteItemStart('t6', 'p2', 'p1');
    expect(followNode('t6', tree)?.to).toBe('p2.1');
  });
  it('moves the plan at the next read, once, and says so in the log and the plan\'s note', () => {
    const tree = treeOf(rows, 'p1');
    noteItemStart('t7', 'p7', 'p1');
    noteItemStart('t7', 'p7', 'p1');
    const lines: string[] = [];
    const plan = createFcaPlanTools({ taskId: 't7', checkpoint: { fcaPlanTree: tree }, rules: true, compact: true, log: line => lines.push(line),
      follow: held => followNode('t7', held) });
    const view = plan.port.view()!;
    expect(view.now).toMatch(/^p7 /u);
    expect(view.note).toContain('今の節を [p7] に進めた');
    expect(plan.port.tree().current).toBe('p7');
    expect(plan.port.display()?.current).toBe('p7');
    expect(plan.port.committed()).not.toBeNull();
    expect(lines.filter(line => line.startsWith('Shannon FCA plan followed task=t7'))).toHaveLength(1);
    expect(lines[0]).toContain('from=p1 to=p7');
    plan.port.view();
    expect(lines.filter(line => line.includes('followed'))).toHaveLength(1);
    // The skipped nodes come back by the plan's own order when this one is done.
    const done = applyPlanUpdate(plan.port.tree(), { ops: [{ op: 'set', id: 'p7', state: 'done' }] }).tree;
    expect(done.current).toBe('p1');
  });
});

describe('run 39: a parent seen done does not close the child whose gear is not made', () => {
  const tree = () => treeOf([['p3', null, '鉄を集め装備', 'have:iron_chestplate&have:iron_pickaxe'], ['p3.3', 'p3', '盾', 'have:shield'],
    ['p3.4', 'p3', '兜・胸・脚', 'have:iron_helmet&have:iron_chestplate&have:iron_leggings'], ['p3.5', 'p3', '村の箱を見る'], ['p4', null, '食料', 'food>=40']], 'p3.3');
  const facts = (...items: Array<[string, number]>) => doneFacts(frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: pack(...items) }))!;
  it('keeps the parent open while a child lacks gear; the child is then the plan\'s next', () => {
    const worn = facts(['iron_chestplate', 1], ['iron_helmet', 1], ['iron_pickaxe', 1]);
    expect(nodesSeenDone(tree(), worn, true)).toEqual([]);
    const all = facts(['iron_chestplate', 1], ['iron_helmet', 1], ['iron_leggings', 1], ['iron_pickaxe', 1], ['shield', 1]);
    expect(nodesSeenDone(tree(), all, true)).toEqual(['p3', 'p3.3', 'p3.4']);
  });
  it('still closes a child with no condition of its own, and a child whose lack is not gear', () => {
    const plain = treeOf([['p3', null, '鉄', 'have:iron_pickaxe'], ['p3.1', 'p3', '箱を見る'], ['p3.2', 'p3', '鉄鉱石', 'have:iron_ore>=24']], 'p3.1');
    expect(nodesSeenDone(plain, facts(['iron_pickaxe', 1]), true)).toEqual(['p3']);
  });
});

describe('fix 1: a consumed material is done by what it was made into', () => {
  const tree = treeOf([['p1', null, '原木を集める', 'have:log>=8'], ['p2', null, '丸石', 'have:cobblestone>=64']], 'p1');
  it('holds with the table or a pickaxe in the pack, not for a stock count', () => {
    const none = doneFacts(frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: pack(['dark_oak_log', 3]) }))!;
    expect(nodesSeenDone(tree, none)).toEqual([]);
    expect(doneStatusWords('have:log>=8', none)).toBe('未: log 3/8');
    // Run 39: a wooden or stone pickaxe alone is not the wood of the table, the pickaxe and the axe.
    const pickaxes = doneFacts(frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: pack(['wooden_pickaxe', 1], ['stone_pickaxe', 1]) }))!;
    expect(nodesSeenDone(tree, pickaxes)).toEqual([]);
    const made = doneFacts(frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: pack(['wooden_pickaxe', 1], ['stone_axe', 1]) }))!;
    expect(nodesSeenDone(tree, made)).toEqual(['p1']);
    expect(doneStatusWords('have:log>=8', made)).toBe('満たしている');
  });
});

describe('fix 3: a descent with too little food says so', () => {
  const surface = (items: Array<[string, number]>, extra: Record<string, unknown> = {}) => frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: pack(...items), ...extra });
  const down = { hands: [{ do: 'walk', to: { x: 3, y: 36, z: 4 } }] };
  it('is said for a hand that goes 10 or more down with food under 40, with the cows in sight', () => {
    const note = descentNote(down, surface([['cooked_beef', 1]], { nearbyEntities: [{ name: 'cow', distance: 14, id: 5 }] }))!;
    expect(note).toContain('準備の状態（この act は地下 y=36 へ下りる手）: 未達 — 食料 20.8/40 点（あと 19.2 点: cooked_beef 1 個）・作業台 無・板 0');
    expect(note).toContain('cow 14m');
    // Run 42: no way past it (「このまま行くなら why に…書く」 was read as one); the loss as the runs measured it.
    expect(note).not.toContain('このまま行くなら');
    expect(note).not.toContain('鉄の夜');
    // GPT's review 2026-10-28: the reason and the story of a run are the instructions' (「準備の決まり」), not said again in every result.
    expect(note).not.toContain('地上へ戻るのに');
    expect(note).not.toContain('372 秒止まり');
  });
  it('names the table when the food is enough but no table and fewer than 4 planks are carried (run 41: 372 s without one)', () => {
    const noTable = descentNote(down, surface([['cooked_beef', 2], ['spruce_planks', 2]]))!;
    expect(noTable).toContain('未達 — 作業台 無・板 2');
    expect(noTable).not.toMatch(/^食料/u);
    expect(descentNote(down, surface([['cooked_beef', 2], ['crafting_table', 1]]))).toBeNull();
    expect(descentNote(down, surface([['cooked_beef', 2], ['spruce_planks', 4]]))).toBeNull();
  });
  it('is not said with enough food and a table, for a short step down, from underground, or in the Nether', () => {
    expect(descentNote(down, surface([['cooked_beef', 2], ['crafting_table', 1]]))).toBeNull();
    expect(descentNote({ hands: [{ do: 'walk', to: { x: 3, y: 66, z: 4 } }] }, surface([]))).toBeNull();
    expect(descentNote(down, frame({ dimension: 'overworld', position: { x: 0, y: 30, z: 0 }, inventory: [] }))).toBeNull();
    expect(descentNote(down, frame({ dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, inventory: [] }))).toBeNull();
    expect(descentNote({ hands: [{ do: 'dig', rel: true, at: [{ x: 0, y: -12, z: 0 }] }] }, surface([]))).toContain('y=58');
  });
});

describe('fix 5: a hostile behind rock does not make an act urgent', () => {
  const threats = (...items: Array<Record<string, unknown>>) => frame({ position: { x: 0, y: 35, z: 0 }, nearbyThreats: items });
  const walled = { name: 'zombie', id: 1, distance: 5.7, canReachMe: false, canSee: false, reach: 'walled', position: { x: 3, y: 39, z: 3 } };
  const detour = { name: 'creeper', id: 2, distance: 5.7, canReachMe: true, canSee: false, reach: 'path_no_sight', position: { x: 3, y: 39, z: 3 } };
  it('gives the range by what the body says of the way', () => {
    expect(urgentRange({ name: 'zombie', canReachMe: false }, 8)).toBe(0);
    expect(urgentRange({ name: 'creeper', reach: 'walled' }, 10)).toBe(4);
    expect(urgentRange({ name: 'creeper', canSee: false, reach: 'path_no_sight' }, 10)).toBe(5);
    expect(urgentRange({ name: 'zombie' }, 8)).toBe(8);
    expect(urgentRange({ name: 'zombie', canSee: true }, 8)).toBe(8);
    expect(urgentRange({ name: 'skeleton', canSee: true }, 8)).toBe(8);
    const [sealed] = nearThreats(threats(walled));
    expect(approaching(sealed!, 8)).toBe(false);
  });
  it('does not cut an act for the walled zombie or the creeper that has to go round, and cuts for one that sees her', async () => {
    const cut = async (item: Record<string, unknown>) => {
      let observed = threats();
      const watch = urgentWatch({ hands: [] }, () => observed, new AbortController().signal, 10);
      observed = threats(item);
      await new Promise(resolve => setTimeout(resolve, 60));
      const reason = watch.reason();
      watch.stop();
      return reason;
    };
    expect(await cut(walled)).toBeNull();
    expect(await cut(detour)).toBeNull();
    expect(await cut({ ...detour, canSee: true, reach: 'in_sight' })).toBe('creeper 5.7m');
    expect(await cut({ name: 'zombie', id: 3, distance: 5.7, canReachMe: true, canSee: true, reach: 'in_sight', position: { x: 3, y: 35, z: 3 } })).toBe('zombie 5.7m');
    expect(await cut({ name: 'zombie', id: 3, distance: 5.7 })).toBe('zombie 5.7m');
  });
  it('makes no urgent step of them at a decision either, and does for a creeper that sees her', () => {
    expect(urgentFacts(threats(walled), null).reasons).toEqual([]);
    expect(urgentFacts(threats(detour), null).reasons).toEqual([]);
    expect(urgentFacts(threats({ ...detour, canSee: true, reach: 'in_sight' }), null).reasons[0]).toContain('creeper');
  });
});

describe('fix 6: the meter keeps a milestone that was passed over', () => {
  const dragon = treeOf([['p1', null, '木と石の道具', 'have:stone_pickaxe'], ['p6', null, '地下のベッドを取る', 'have:bed>=1'], ['p7', null, '鉄', 'have:iron_pickaxe'],
    ['p9', null, 'エンドでドラゴン']], 'p6');
  const kit = (...items: Array<[string, number]>) => frame({ dimension: 'overworld', position: { x: 0, y: 40, z: 0 }, inventory: pack(...items) });
  it('names the bed after the bucket, and points at it while the plan\'s current node is the bed', () => {
    expect(isDragonPlan(dragon)).toBe(true);
    const line = meterLine(dragon, kit(['iron_pickaxe', 1], ['bucket', 1]), 862 / 60)!;
    expect(line).toBe('目安: 今 862 秒・次の節目 ベッド 目安 150 秒（712 秒遅れ）');
    const later = meterLine({ ...dragon, current: 'p7' }, kit(['iron_pickaxe', 1], ['bucket', 1]), 862 / 60)!;
    expect(later).toBe('目安: 今 862 秒・次の節目 ダイヤのツルハシ 目安 1,000 秒（あと 138 秒）・まだの節目: ベッド（目安 150 秒）');
  });
  it('says nothing of it once the bed is in the pack, and keeps the used-up milestones out of it', () => {
    expect(meterLine({ ...dragon, current: 'p7' }, kit(['iron_pickaxe', 1], ['bucket', 1], ['white_bed', 1]), 862 / 60)).not.toContain('まだの節目');
    expect(meterLine({ ...dragon, current: 'p7' }, frame({ dimension: 'the_nether', position: { x: 0, y: 70, z: 0 }, inventory: [] }), 1_700 / 60)).toBe('目安: 今 1,700 秒（節目は全部済んだ）');
  });
});

describe('fix 6: the bed rule', () => {
  it('puts the bed off when there is no village and no sheep, without a condition on what is urgent', () => {
    expect(PREP_RULES_WORDS).toContain('村も羊も見つからない世界では、地下の構造物のベッドへ下りず、ベッドの節は後回しにして鉄へ進む');
    expect(PREP_RULES_WORDS).not.toContain('の時だけ');
  });
});
