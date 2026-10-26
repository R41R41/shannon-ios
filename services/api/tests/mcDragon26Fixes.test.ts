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

describe('fix 1: the current node follows the node of the item the body starts (task queue)', () => {
  const rows: Row[] = [['p1', null, '原木を集める', 'have:log>=8'], ['p5', null, '動物を狩り焼く', 'food>=40'], ['p6', null, '地下のベッドを取る', 'have:bed>=1'],
    ['p7', null, '鉄を掘る', 'have:iron_ingot>=24']];
  it('moves when an item starts for another node, and leaves the nodes passed open', () => {
    const tree = treeOf(rows, 'p1');
    expect(followNode('t1', tree)).toBeNull();
    noteItemStart('t1', 'p7');
    expect(followNode('t1', tree)).toEqual({ to: 'p7', from: 'p1', acts: 1 });
    const moved = applyPlanUpdate(tree, { ops: [], current: 'p7' }).tree;
    expect(moved.current).toBe('p7');
    expect(moved.nodes.filter(node => node.state === 'done')).toEqual([]);
    expect(followNode('t1', moved)).toBeNull();
  });
  it('is read once for each item; does not move for no node, the current node, a done node, a node above the current one or a node holding it', () => {
    const tree = treeOf(rows, 'p1');
    noteItemStart('t2', null);
    expect(followNode('t2', tree)).toBeNull();
    noteItemStart('t2', 'p1');
    expect(followNode('t2', tree)).toBeNull();
    noteItemStart('t3', 'p7');
    const done = { ...tree, nodes: tree.nodes.map(node => node.id === 'p7' ? { ...node, state: 'done' as const } : node) };
    expect(followNode('t3', done)).toBeNull();
    noteItemStart('t3', 'p7');
    expect(followNode('t3', { ...tree, current: 'p7' })).toBeNull();
    expect(followNode('t3', tree)).toBeNull();
  });
  it('goes to the first open leaf of a node with children', () => {
    const tree = treeOf([['p1', null, '木'], ['p2', null, '鉄'], ['p2.1', 'p2', '掘る'], ['p2.2', 'p2', '焼く']], 'p1');
    noteItemStart('t4', 'p2');
    expect(followNode('t4', tree)?.to).toBe('p2.1');
  });
  it('moves the plan at the next read, once, and says so in the log and the plan\'s note', () => {
    const tree = treeOf(rows, 'p1');
    noteItemStart('t5', 'p7');
    const lines: string[] = [];
    const plan = createFcaPlanTools({ taskId: 't5', checkpoint: { fcaPlanTree: tree }, rules: true, compact: true, log: line => lines.push(line),
      follow: held => followNode('t5', held) });
    const view = plan.port.view()!;
    expect(view.now).toMatch(/^p7 /u);
    expect(view.note).toContain('今の節を [p7] に進めた');
    expect(plan.port.tree().current).toBe('p7');
    expect(plan.port.display()?.current).toBe('p7');
    expect(plan.port.committed()).not.toBeNull();
    expect(lines.filter(line => line.startsWith('Shannon FCA plan followed task=t5'))).toHaveLength(1);
    expect(lines[0]).toContain('from=p1 to=p7');
    plan.port.view();
    expect(lines.filter(line => line.includes('followed'))).toHaveLength(1);
    // The skipped nodes come back by the plan's own order when this one is done.
    const done = applyPlanUpdate(plan.port.tree(), { ops: [{ op: 'set', id: 'p7', state: 'done' }] }).tree;
    expect(done.current).toBe('p1');
  });
});

describe('fix 1: a consumed material is done by what it was made into', () => {
  const tree = treeOf([['p1', null, '原木を集める', 'have:log>=8'], ['p2', null, '丸石', 'have:cobblestone>=64']], 'p1');
  it('holds with the table or a pickaxe in the pack, not for a stock count', () => {
    const none = doneFacts(frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: pack(['dark_oak_log', 3]) }))!;
    expect(nodesSeenDone(tree, none)).toEqual([]);
    expect(doneStatusWords('have:log>=8', none)).toBe('未: log 3/8');
    const made = doneFacts(frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: pack(['wooden_pickaxe', 1], ['stone_pickaxe', 1]) }))!;
    expect(nodesSeenDone(tree, made)).toEqual(['p1']);
    expect(doneStatusWords('have:log>=8', made)).toBe('満たしている');
  });
});

describe('fix 3: a descent with too little food says so', () => {
  const surface = (items: Array<[string, number]>, extra: Record<string, unknown> = {}) => frame({ dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, inventory: pack(...items), ...extra });
  const down = { hands: [{ do: 'walk', to: { x: 3, y: 36, z: 4 } }] };
  it('is said for a hand that goes 10 or more down with food under 40, with the cows in sight', () => {
    const note = descentNote(down, surface([['cooked_beef', 1]], { nearbyEntities: [{ name: 'cow', distance: 14, id: 5 }] }))!;
    expect(note).toContain('食料 20.8 点（鉄の夜の前は 40 点）のまま地下 y=36 へ下りる手');
    expect(note).toContain('cow 14m');
    expect(note).toContain('why に理由を書く');
  });
  it('is not said with enough food, for a short step down, from underground, or in the Nether', () => {
    expect(descentNote(down, surface([['cooked_beef', 2]]))).toBeNull();
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
    expect(later).toBe('目安: 今 862 秒・次の節目 ダイヤのツルハシ 目安 1,000 秒（あと 138 秒）・まだの節目: ベッド（目安 150 秒。飛ばしたなら plan.update に書く）');
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
