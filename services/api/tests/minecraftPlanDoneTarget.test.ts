import { expect, it } from 'vitest';
import { applyPlanUpdate, planFromSeeds, type PlanTree } from '@shannon/mind';
import { seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
const pack = (buckets: number) => ({ connected: true, state: { world: { inventory: buckets ? [{ name: 'bucket', count: buckets }] : [] } }, facts: {} }) as unknown as BodyObservation;
const twoBuckets = () => planFromSeeds([{ id: 'p', title: 'バケツ2個', target: { item: 'bucket', count: 2 }, doneWhen: 'have:bucket>=2',
  children: [{ id: 'c', title: 'バケツ1個', target: { item: 'bucket', count: 1 }, doneWhen: 'have:bucket>=1' }] }])!;
const stateOf = (tree: PlanTree, id: string) => tree.nodes.find(node => node.id === id)?.state;
const settle = (tree: PlanTree, buckets: number) => {
  const seen = seenDoneUpdate(tree, pack(buckets));
  return { seen, tree: seen ? applyPlanUpdate(tree, seen.update).tree : tree };
};

it('a child that is done does not close a parent whose own target the pack has not reached', () => {
  const { seen, tree } = settle(twoBuckets(), 1);
  expect(seen?.ids).toEqual(['c']);
  expect(stateOf(tree, 'c')).toBe('done');
  expect(stateOf(tree, 'p')).not.toBe('done');
});

it('the parent is closed once the pack holds what its target names', () => {
  const { seen, tree } = settle(twoBuckets(), 2);
  expect(seen?.ids).toEqual(expect.arrayContaining(['c', 'p']));
  expect(stateOf(tree, 'c')).toBe('done');
  expect(stateOf(tree, 'p')).toBe('done');
});

it('a parent with no target of its own is still closed by its children', () => {
  const tree = planFromSeeds([{ id: 'p', title: '道具', doneWhen: 'have:bucket',
    children: [{ id: 'c', title: 'バケツ', target: { item: 'bucket', count: 1 }, doneWhen: 'have:bucket' }] }])!;
  expect(stateOf(settle(tree, 1).tree, 'p')).toBe('done');
});
