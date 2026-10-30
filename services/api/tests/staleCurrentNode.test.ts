import { afterEach, describe, expect, it } from 'vitest';
import { forgetOnceFacts, pending } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { staleNodeFacts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { reachedMilestoneNames } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { v2tree } from './helpers/planTreeV2.js';

/**
 * Run 48: the model added 「[n1] 食料不足のまま鉄へ（地上に動物なし）」 (kind prep_descent, prep skipped, no doneWhen) and tagged every act with it; the plan's current node was n1 from +190 s to the end, past the
 * iron pickaxe, the diamond pickaxe and the obsidian. The code moves a node only by a condition it can read; a node with none is moved by the model's plan.update. The head says, once for each
 * milestone reached, that the current node has no condition and is not done and which milestones came since it became the current node.
 */
afterEach(() => forgetOnceFacts());
const TASK = 'stale-node-task';
const tree = (n1: Record<string, unknown> = {}, current = 'n1') => ({ ...v2tree({ revision: 4, current, nodes: [
  { id: 'p1', parentId: null, order: 0, title: '木と石の道具', state: 'done', kind: 'stone_tools', doneWhen: 'have:stone_pickaxe' } as never,
  { id: 'n1', parentId: null, order: 1, title: '食料不足のまま鉄へ（地上に動物なし）', state: 'continue', kind: 'prep_descent', ...n1 } as never,
  { id: 'p9', parentId: null, order: 2, title: 'エンドでドラゴン', state: 'wait', kind: 'dragon' } as never] }), promises: [] });
const frame = (items: string[]) => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: items.map(name => ({ name, count: 1 })) } }, facts: {} } as never);
const staleOf = () => pending(TASK).filter(fact => fact.key.startsWith('stale_node:')).map(fact => fact.text);

describe('the milestones the plan reaches while the current node stays', () => {
  it('names the milestones the frame shows (the meter\'s own list)', () => {
    expect(reachedMilestoneNames(tree(), frame(['iron_pickaxe', 'bucket']))).toEqual(expect.arrayContaining(['鉄のツルハシ', 'バケツ']));
    expect(reachedMilestoneNames(tree(), frame([]))).toEqual([]);
    expect(reachedMilestoneNames(null, frame([]))).toBeNull();
  });
  it('says once for each new milestone that the current node has no condition and is not done', () => {
    // n1 becomes the current node while the iron pickaxe is already carried: not "since"
    expect(staleOf()).toEqual([]);
    staleNodeFacts(TASK, tree(), frame(['iron_pickaxe']));
    expect(staleOf()).toEqual([]);
    // the bucket comes: one fact
    staleNodeFacts(TASK, tree(), frame(['iron_pickaxe', 'bucket']));
    expect(staleOf()).toHaveLength(1);
    expect(staleOf()[0]).toContain('今の節 n1「食料不足のまま鉄へ（地上に動物なし）」には、済む条件が書かれておらず');
    expect(staleOf()[0]).toContain('バケツ に着いた');
    expect(staleOf()[0]).not.toContain('鉄のツルハシ');
    expect(staleOf()[0]).not.toMatch(/しなさい|してください|すること|べき/u);
    // the same frame again: nothing new; the diamond pickaxe comes: the fact is replaced by one that names both
    staleNodeFacts(TASK, tree(), frame(['iron_pickaxe', 'bucket']));
    expect(staleOf()).toHaveLength(1);
    staleNodeFacts(TASK, tree(), frame(['iron_pickaxe', 'bucket', 'diamond_pickaxe']));
    expect(staleOf()).toHaveLength(1);
    expect(staleOf()[0]).toContain('バケツ・ダイヤのツルハシ に着いた');
  });
  it('says nothing of a node with a condition the code reads, of a done node, or when the current node moves (the base starts again)', () => {
    staleNodeFacts(TASK, tree({ doneWhen: 'have:iron_pickaxe' }), frame([]));
    staleNodeFacts(TASK, tree({ doneWhen: 'have:iron_pickaxe' }), frame(['bucket']));
    expect(staleOf()).toEqual([]);
    forgetOnceFacts();
    staleNodeFacts(TASK, tree(), frame([]));
    staleNodeFacts(TASK, tree({ state: 'done' }), frame(['bucket']));
    expect(staleOf()).toEqual([]);
    // a free-words condition is the model's as well
    forgetOnceFacts();
    staleNodeFacts(TASK, tree({ doneWhen: '食料が足りたら' }), frame([]));
    staleNodeFacts(TASK, tree({ doneWhen: '食料が足りたら' }), frame(['bucket']));
    expect(staleOf()).toHaveLength(1);
    // the model moves the current node: the fact goes, and the base is what is reached then
    staleNodeFacts(TASK, tree({}, 'p9'), frame(['bucket']));
    expect(staleOf()).toEqual([]);
    staleNodeFacts(TASK, tree({}, 'n1'), frame(['bucket']));
    expect(staleOf()).toEqual([]);
  });
  it('a plan that is not the dragon\'s, or no frame, says nothing', () => {
    staleNodeFacts(TASK, null, frame(['bucket']));
    staleNodeFacts(TASK, tree(), null);
    expect(staleOf()).toEqual([]);
  });
});
