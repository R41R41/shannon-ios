import { describe, expect, it } from 'vitest';
import { applyPlanUpdate, planFromSeeds, readPlanTree } from '@shannon/mind';
import { targetConditionProblem, targetRequirements, targetUpdateProblem } from '../src/surfaces/minecraft/minecraftPlanRequirements.js';
import { planFromAnswer } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { currentUsableCounts } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
const bucket = () => planFromSeeds([{ id: 'bucket', title: 'バケツ', target: { item: 'bucket', count: 1 }, doneWhen: 'have:bucket' }])!;
describe('explicit current acquisition requirements', () => {
  it('preserves targets across updates and checkpoints and rejects malformed targets', () => {
    const tree = bucket();
    expect(readPlanTree(tree)?.nodes[0]?.target).toEqual({ item: 'bucket', count: 1 });
    const bad = applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'bucket', target: { item: 'bucket', count: -1 } }] });
    expect(bad.problem).toBeTruthy();
    expect(applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'bucket', target: null }] }).tree.nodes[0]?.target).toBeUndefined();
  });
  it('rejects material or armour alternatives as proof of acquiring a bucket, including first plans', () => {
    const node = { ...bucket().nodes[0]!, doneWhen: 'have:iron_ingot>=30|have:iron_chestplate' };
    expect(targetConditionProblem(node)).toContain('不一致');
    expect(targetConditionProblem({ ...node, doneWhen: 'have:bucket|have:iron_ingot>=30' })).toBeTruthy();
    expect(targetConditionProblem({ ...node, doneWhen: 'have:bucket&have:shield|have:bucket&have:iron_pickaxe' })).toBeNull();
    expect(planFromAnswer({ nodes: [{ ...node, parent: '' }] })).toBeNull();
  });
  it('uses two ingots and one raw iron for one bucket, without demanding thirty more iron', () => {
    const words = targetRequirements(bucket().nodes[0], new Map([['iron_ingot', 2], ['raw_iron', 1]]));
    expect(words).toContain('raw_iron×1を精錬');
    expect(words).not.toContain('iron_ingot あと');
    expect(words).not.toContain('30');
  });
  it('finished loot eliminates the material deficit; consumption brings only the current deficit back', () => {
    expect(targetRequirements(bucket().nodes[0], new Map([['water_bucket', 1]]))).toContain('現在充足');
    expect(targetRequirements(bucket().nodes[0], new Map([['iron_ingot', 1]]))).toContain('iron_ingot あと2');
    expect(targetRequirements(bucket().nodes[0], new Map([['iron_ingot', 3]]))).toContain('所持材料で製作可能');
  });
  it('protects other reservations but permits the reservation intended for this node', () => {
    const tree = bucket();
    const reserved = applyPlanUpdate(tree, { ops: [{ op: 'promise', item: 'iron_ingot', count: 1, use: 'shield' }] }).tree;
    expect(targetRequirements(tree.nodes[0], new Map([['iron_ingot', 3]]), reserved)).toContain('iron_ingot あと1');
    const own = applyPlanUpdate(tree, { ops: [{ op: 'promise', item: 'iron_ingot', count: 3, use: 'bucket', until: { node: 'bucket' } }] }).tree;
    expect(targetRequirements(tree.nodes[0], new Map([['iron_ingot', 3]]), own)).toContain('所持材料で製作可能');
  });
  it('does not allow model self-report to create acquisition evidence and preserves unchanged history', () => {
    const before = bucket(), after = { ...before, nodes: before.nodes.map(n => ({ ...n, state: 'done' as const })) };
    expect(targetUpdateProblem(before, after, null)).toContain('未達か未確認');
    expect(targetUpdateProblem(after, after, null)).toBeNull();
    const rewritten = { ...after, nodes: after.nodes.map(n => ({ ...n, target: { item: 'diamond_pickaxe', count: 1 }, doneWhen: 'have:diamond_pickaxe' })) };
    expect(targetUpdateProblem(after, rewritten, null)).toContain('未達か未確認');
  });
  it('keeps unknown wear separate from broken tools and does not erase a usable spare', () => {
    const pack = new Map([['stone_pickaxe', 2]]);
    expect(currentUsableCounts(pack, [{ name: 'stone_pickaxe', count: 1, durability: { left: 0 } }]).get('stone_pickaxe')).toBe(1);
    expect(currentUsableCounts(pack, [{ name: 'stone_pickaxe', count: 2, durability: { left: 0 } }]).get('stone_pickaxe')).toBe(0);
    expect(currentUsableCounts(pack).get('stone_pickaxe')).toBe(2);
  });
  it('does not substitute a wooden pickaxe for the required materials', () => {
    expect(ownFirstPlanSystem()).not.toMatch(/have:log>=\d+\|have:wooden_pickaxe/u);
  });
});
