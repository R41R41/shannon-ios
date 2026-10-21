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
});
