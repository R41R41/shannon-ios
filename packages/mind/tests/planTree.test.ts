import { describe, expect, it } from 'vitest';
import {
  applyPlanUpdate, emptyPlanTree, flatPlan, planDisplay, planFromSeeds, planPath, planText, planTreeProblem, readPlanTree, PLAN_LIMITS,
  type PlanTree,
} from '../src/index.js';

/** Design mb-llm-centric 2.7: the model's own plan tree, 64 nodes and 4 deep, changed only by plan.update's ops. */
const base = (): PlanTree => planFromSeeds([
  { title: '木と石の道具', children: [{ title: '原木' }, { title: '石のツルハシ', doneWhen: 'stone_pickaxe' }] },
  { title: '食料（鉄より前）', where: '(196,69,237) 村' },
  { title: '鉄' },
])!;

describe('plan tree', () => {
  it('a tree from seeds starts at the first open leaf, parents first, and reads back from a checkpoint', () => {
    const tree = base();
    expect(tree.nodes.map(node => node.id)).toEqual(['p1', 'p1.1', 'p1.2', 'p2', 'p3']);
    expect(tree.current).toBe('p1.1');
    expect(planTreeProblem(tree)).toBeNull();
    expect(readPlanTree(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
    expect(readPlanTree({ ...tree, current: 'nope' })).toBeNull();
  });

  it('add, split, set, move and drop apply in order; a done current moves on, and a parent with every child done is done', () => {
    const tree = base();
    const result = applyPlanUpdate(tree, { ops: [
      { op: 'set', id: 'p1.1', state: 'done' }, { op: 'set', id: 'p1.2', state: 'done' },
      { op: 'split', id: 'p2', into: [{ title: '村を回る' }, { title: '肉を焼く' }] },
      { op: 'add', parent: null, after: 'p2', title: 'ベッド', id: 'bed' },
      { op: 'move', id: 'p3', parent: null, after: 'bed' },
    ] });
    expect(result.problem).toBeNull();
    expect(result.changed).toBe(true);
    const ids = result.tree.nodes.map(node => node.id);
    expect(ids).toEqual(['p1', 'p1.1', 'p1.2', 'p2', 'n1', 'n2', 'bed', 'p3']);
    expect(result.tree.nodes.find(node => node.id === 'p1')!.state).toBe('done');
    expect(result.tree.current).toBe('n1');
    expect(result.tree.revision).toBe(tree.revision + 1);
    const dropped = applyPlanUpdate(result.tree, { ops: [{ op: 'drop', id: 'p2' }] });
    expect(dropped.tree.nodes.some(node => node.id === 'n1' || node.id === 'p2')).toBe(false);
    expect(dropped.tree.current).toBe('bed');
  });

  it('is all or nothing: one op that does not fit leaves the tree as it was and says why', () => {
    const tree = base();
    const result = applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'p1.1', state: 'done' }, { op: 'set', id: 'zzz', state: 'done' }] });
    expect(result.changed).toBe(false);
    expect(result.tree).toBe(tree);
    expect(result.problem).toContain('ops[1]');
    expect(applyPlanUpdate(tree, { current: 'nope' }).problem).toContain('current');
    expect(applyPlanUpdate(tree, { ops: [{ op: 'move', id: 'p1', parent: 'p1.1' }] }).problem).toContain('自分の下');
  });

  it('keeps the bounds: 64 nodes, 4 deep', () => {
    let tree = emptyPlanTree();
    const deep = applyPlanUpdate(tree, { ops: [{ op: 'add', id: 'a', title: '1' }, { op: 'add', id: 'b', parent: 'a', title: '2' },
      { op: 'add', id: 'c', parent: 'b', title: '3' }, { op: 'add', id: 'd', parent: 'c', title: '4' }, { op: 'add', id: 'e', parent: 'd', title: '5' }] });
    expect(deep.problem).toContain(`深さは ${PLAN_LIMITS.depth}`);
    for (const [batch, length] of [22, 22, 20].entries()) {
      tree = applyPlanUpdate(tree, { ops: Array.from({ length }, (_, index) => ({ op: 'add' as const, title: `節${batch}-${index}` })) }).tree;
    }
    expect(tree.nodes.length).toBe(64);
    expect(applyPlanUpdate(tree, { ops: [{ op: 'add', title: 'もう一つ' }] }).problem).toContain('64');
  });

  it('a blocked node keeps its reason; it loses it when it is no longer blocked', () => {
    const blocked = applyPlanUpdate(base(), { ops: [{ op: 'set', id: 'p2', state: 'blocked', reason: '村が無い' }] }).tree;
    expect(planPath(blocked).blocked).toEqual(['p2 食料（鉄より前） — 村が無い']);
    expect(planDisplay(blocked).nodes.find(node => node.id === 'p2')).toMatchObject({ state: 'blocked', reason: '村が無い' });
    const open = applyPlanUpdate(blocked, { ops: [{ op: 'set', id: 'p2', state: 'continue' }] }).tree;
    expect(open.nodes.find(node => node.id === 'p2')!.reason).toBeUndefined();
  });

  // end1110r1 (11/10): the hand 「set blocked … 外し、次の節へ」 left the now on the node set aside (p2.1 blocked, the now still p2.1).
  describe('a current set aside', () => {
    const food = (): PlanTree => applyPlanUpdate(planFromSeeds([
      { title: '道具', children: [{ title: '原木' }] },
      { title: '食料とベッド', children: [{ title: '動物を狩る' }, { title: '肉を焼く' }, { title: 'ベッド' }] },
      { title: '鉄' },
    ])!, { ops: [{ op: 'set', id: 'p1.1', state: 'done' }] }).tree;

    it('blocked with no current named, the now goes on to the next open node; named, it is as named until the next update', () => {
      expect(food().current).toBe('p2.1');
      const aside = applyPlanUpdate(food(), { ops: [{ op: 'set', id: 'p2.1', state: 'blocked', reason: '動物が見えない' }] }).tree;
      expect(aside.current).toBe('p2.2');
      expect(aside.nodes.find(node => node.id === 'p2.1')).toMatchObject({ state: 'blocked', reason: '動物が見えない' });
      const named = applyPlanUpdate(food(), { ops: [{ op: 'set', id: 'p2.1', state: 'blocked', reason: 'x' }], current: 'p2.1' }).tree;
      expect(named.current).toBe('p2.1');
      expect(applyPlanUpdate(named, { ops: [{ op: 'set', id: 'p3', note: '後で' }] }).tree.current).toBe('p2.2');
    });

    it('the node above it blocked, the now leaves everything under that node, and nothing under it is the next until it is open again', () => {
      const under = applyPlanUpdate(food(), { current: 'p2.2' }).tree;
      const aside = applyPlanUpdate(under, { ops: [{ op: 'set', id: 'p2', state: 'blocked', reason: '羊が見えない' }] }).tree;
      expect(aside.current).toBe('p3');
      const after = applyPlanUpdate(aside, { ops: [{ op: 'set', id: 'p3', state: 'done' }] }).tree;
      expect(after.current).toBeNull();
      expect(applyPlanUpdate(after, { ops: [{ op: 'set', id: 'p2', state: 'continue' }] }).tree.current).toBe('p2.1');
    });

    it('with no other open node, the now stays', () => {
      const one = applyPlanUpdate(emptyPlanTree(), { ops: [{ op: 'add', id: 'a', title: '鉄を掘る' }] }).tree;
      expect(one.current).toBe('a');
      expect(applyPlanUpdate(one, { ops: [{ op: 'set', id: 'a', state: 'blocked', reason: 'y' }] }).tree.current).toBe('a');
    });
  });

  it('the path a decision reads: the parents, the current node with where and doneWhen, the next three leaves', () => {
    const tree = applyPlanUpdate(base(), { current: 'p1.2' }).tree;
    expect(planPath(tree)).toEqual({ done: '0/5', path: ['木と石の道具'], now: 'p1.2 石のツルハシ（済み: stone_pickaxe）',
      next: ['p2 食料（鉄より前）＠(196,69,237) 村', 'p3 鉄'], blocked: [] });
  });

  it('the whole tree as text, the flat copy for plan_json, and the body\'s view', () => {
    const tree = base();
    expect(planText(tree).split('\n')).toEqual(['計画 rev1（済み 0/5）', '・ p1 木と石の道具', '  ▶ p1.1 原木', '  ・ p1.2 石のツルハシ（済み: stone_pickaxe）',
      '・ p2 食料（鉄より前）＠(196,69,237) 村', '・ p3 鉄']);
    expect(flatPlan(tree)[1]).toEqual({ id: 'p1.1', title: '　原木', status: 'running' });
    expect(planDisplay(tree)).toMatchObject({ revision: 1, current: 'p1.1' });
    expect(planDisplay(tree).nodes[0]).toEqual({ id: 'p1', parentId: null, title: '木と石の道具', state: 'continue' });
  });

  it('the body view carries where, doneWhen, note, forbid and caution only on the nodes that have them', () => {
    const tree = applyPlanUpdate(base(), { ops: [{ op: 'set', id: 'p3', note: '村の鉄を先に' }, { op: 'forbid', id: 'p2', text: '夜に村へ出ない' },
      { op: 'caution', id: 'p2', text: '村人を殴らない' }] }).tree;
    const nodes = planDisplay(tree).nodes;
    expect(nodes.find(node => node.id === 'p1.2')).toEqual({ id: 'p1.2', parentId: 'p1', title: '石のツルハシ', state: 'continue', doneWhen: 'stone_pickaxe' });
    expect(nodes.find(node => node.id === 'p2')).toEqual({ id: 'p2', parentId: null, title: '食料（鉄より前）', state: 'continue', where: '(196,69,237) 村',
      forbid: ['夜に村へ出ない'], caution: ['村人を殴らない'] });
    expect(nodes.find(node => node.id === 'p3')).toMatchObject({ note: '村の鉄を先に' });
    expect(nodes.find(node => node.id === 'p3')).not.toHaveProperty('forbid');
  });

  it('a parent that names an acquisition of its own is not closed by its children; one that does not is', () => {
    const child = { id: 'c', title: 'バケツ1個', target: { item: 'bucket', count: 1 }, doneWhen: 'have:bucket' };
    const named = planFromSeeds([{ id: 'p', title: 'バケツ2個', target: { item: 'bucket', count: 2 }, doneWhen: 'have:bucket>=2', children: [child] }])!;
    const after = applyPlanUpdate(named, { ops: [{ op: 'set', id: 'c', state: 'done' }] }).tree;
    expect(after.nodes.find(node => node.id === 'c')?.state).toBe('done');
    expect(after.nodes.find(node => node.id === 'p')?.state).not.toBe('done');
    expect(applyPlanUpdate(after, { ops: [{ op: 'set', id: 'p', state: 'done' }] }).tree.nodes.find(node => node.id === 'p')?.state).toBe('done');
    // end1109o02: a parent with a condition of its own (doneWhen) is not closed by its children either; it becomes the open node.
    const conditioned = planFromSeeds([{ id: 'p', title: '鉄の道具と防具', doneWhen: 'have:iron_pickaxe&have:shield', children: [{ id: 'c', title: 'バケツ', doneWhen: 'have:bucket' }] },
      { id: 'q', title: 'ダイヤ', doneWhen: 'have:diamond>=3' }])!;
    const bucketed = applyPlanUpdate({ ...conditioned, current: 'c' }, { ops: [{ op: 'set', id: 'c', state: 'done' }] }).tree;
    expect(bucketed.nodes.find(node => node.id === 'p')?.state).not.toBe('done');
    expect(bucketed.current).toBe('p');
    // end1109o04: a node left behind when the current followed her forward is the current again once the node followed to is done; not one
    // from before a dimension reached.
    const left = planFromSeeds([{ id: 'p1', title: '木と石', doneWhen: 'have:stone_pickaxe&have:log>=16', children: [{ id: 'p1.3', title: '石の剣', doneWhen: 'have:stone_sword' },
      { id: 'p1.4', title: '原木', doneWhen: 'have:log>=16' }] }, { id: 'p2', title: '食料', doneWhen: 'food>=40' }, { id: 'p3', title: '鉄', doneWhen: 'have:iron_pickaxe' }])!;
    const fed = applyPlanUpdate({ ...left, current: 'p2' }, { ops: [{ op: 'set', id: 'p2', state: 'done' }] }).tree;
    expect(fed.current).toBe('p1.3');
    const gated = planFromSeeds([{ id: 'g', title: '金のブーツ', doneWhen: 'have:golden_boots' }, { id: 'n', title: 'ネザーへ', doneWhen: 'dim:the_nether' },
      { id: 'f', title: '要塞', doneWhen: 'see:fortress' }, { id: 'r', title: 'ロッド', doneWhen: 'have:blaze_rod>=7' }])!;
    const inNether = applyPlanUpdate({ ...gated, current: 'f' }, { ops: [{ op: 'set', id: 'n', state: 'done' }, { op: 'set', id: 'f', state: 'done' }] }).tree;
    expect(inNether.current).toBe('r');
    const plain = planFromSeeds([{ id: 'p', title: '道具', children: [{ id: 'c', title: 'バケツ' }] }])!;
    expect(applyPlanUpdate(plain, { ops: [{ op: 'set', id: 'c', state: 'done' }] }).tree.nodes.find(node => node.id === 'p')?.state).toBe('done');
  });
});
