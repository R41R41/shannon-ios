import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
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
    // A first plan with such a node is not thrown away (run59 task 1): the node stays with its doneWhen, without the target that its alternatives do not prove.
    const kept = planFromAnswer({ nodes: [{ ...node, parent: '' }] })!;
    expect(kept.nodes).toHaveLength(1);
    expect(kept.nodes[0]!.target).toBeUndefined();
    expect(kept.nodes[0]!.doneWhen).toBe('have:iron_ingot>=30|have:iron_chestplate');
  });
  it('says in the refusal how to mend it: doneWhen to the target, or the target changed with it, or dropped (2026-11-23)', () => {
    const node = { ...bucket().nodes[0]!, doneWhen: 'have:iron_ingot>=2' };
    const problem = targetConditionProblem(node)!;
    expect(problem).toContain('各 | の枝に have:bucket>=1 が必要');
    expect(problem).toContain('set で target も新しい物・数に直す');
    expect(problem).toContain('set で target=null');
    // A change of what is to be taken is made in one set (target and doneWhen together), and it passes.
    const changed = applyPlanUpdate(bucket(), { ops: [{ op: 'set', id: 'bucket', title: '羊毛', doneWhen: 'have:white_wool>=2', target: { item: 'white_wool', count: 2 } }] });
    expect(changed.problem).toBeNull();
    expect(targetConditionProblem(changed.tree.nodes[0]!)).toBeNull();
  });
  it('says in the refusal how to mend it: doneWhen to the target, or the target changed with it, or dropped (2026-11-23)', () => {
    const node = { ...bucket().nodes[0]!, doneWhen: 'have:iron_ingot>=2' };
    const problem = targetConditionProblem(node)!;
    expect(problem).toContain('各 | の枝に have:bucket>=1 が必要');
    expect(problem).toContain('set で target も新しい物・数に直す');
    expect(problem).toContain('set で target=null');
    // A change of what is to be taken is made in one set (target and doneWhen together), and it passes.
    const changed = applyPlanUpdate(bucket(), { ops: [{ op: 'set', id: 'bucket', title: '羊毛', doneWhen: 'have:white_wool>=2', target: { item: 'white_wool', count: 2 } }] });
    expect(changed.problem).toBeNull();
    expect(targetConditionProblem(changed.tree.nodes[0]!)).toBeNull();
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
    expect(targetUpdateProblem(before, after, null)).toContain('未確認');
    expect(targetUpdateProblem(after, after, null)).toBeNull();
    const rewritten = { ...after, nodes: after.nodes.map(n => ({ ...n, target: { item: 'diamond_pickaxe', count: 1 }, doneWhen: 'have:diamond_pickaxe' })) };
    expect(targetUpdateProblem(after, rewritten, null)).toContain('未確認');
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

describe('a target the head lowers itself (11/15b c1: 「パール 14」 with 13 eyes made was refused five times)', () => {
  const pearls = () => planFromSeeds([{ id: 'p2', title: 'パール', target: { item: 'ender_pearl', count: 14 }, doneWhen: 'have:ender_pearl>=14' }])!;
  const seen = { connected: true, facts: {}, state: { world: { inventory: [{ name: 'ender_eye', count: 13 }] } } } as unknown as BodyObservation;
  it('says what is counted toward the target and how many now, and how to lower it', () => {
    const before = pearls(), done = applyPlanUpdate(before, { ops: [{ op: 'set', id: 'p2', state: 'done' }] }).tree;
    const problem = targetUpdateProblem(before, done, seen)!;
    expect(problem).toContain('ender_pearl×14 に今 13（ender_pearl 0＋ender_eye 13。アイもパールとして数える）、あと 1');
    expect(problem).toContain('target の count と doneWhen の数を 13 に下げてよい（枠の 12 と予備の最低 1 は下回らない）');
  });
  it('does not offer lowering below the frame, nor for any other target', () => {
    const few = { connected: true, facts: {}, state: { world: { inventory: [{ name: 'ender_pearl', count: 3 }] } } } as unknown as BodyObservation;
    const before = pearls(), done = applyPlanUpdate(before, { ops: [{ op: 'set', id: 'p2', state: 'done' }] }).tree;
    const pearlProblem = targetUpdateProblem(before, done, few)!;
    expect(pearlProblem).toContain('今 3');
    expect(pearlProblem).toContain('枠に 12 と割れる分の予備 1 以上で 13 要るので数は下げない');
    expect(pearlProblem).not.toMatch(/下げてよい|3 以下/u);
    const rods = planFromSeeds([{ id: 'r1', title: 'ロッド', target: { item: 'blaze_rod', count: 7 }, doneWhen: 'have:blaze_rod>=7' }])!;
    const empty = { connected: true, facts: {}, state: { world: { inventory: [] } } } as unknown as BodyObservation;
    const rodProblem = targetUpdateProblem(rods, applyPlanUpdate(rods, { ops: [{ op: 'set', id: 'r1', state: 'done' }] }).tree, empty)!;
    expect(rodProblem).toContain('blaze_rod×7 に今 0');
    expect(rodProblem).not.toMatch(/下げ/u);
  });
  it('takes the node closed when the head lowers the count and its doneWhen to what she has', () => {
    const before = pearls();
    const lowered = applyPlanUpdate(before, { ops: [{ op: 'set', id: 'p2', state: 'done', target: { item: 'ender_pearl', count: 13 }, doneWhen: 'have:ender_pearl>=13' }] });
    expect(lowered.problem).toBeFalsy();
    expect(targetUpdateProblem(before, lowered.tree, seen)).toBeNull();
  });
});
