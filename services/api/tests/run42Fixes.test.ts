import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, PLAN_TREE_SCHEMA, type PlanNode, type PlanTree, type PlanUpdate } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { chestNodesDone, followNode, forgetActNodes, noteChestsOpened, noteItemStart } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { PREP_DESCENT_RULE, PREP_RULES_WORDS, PREP_SKIP_SECONDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { descentNote, recoveryLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { DRAGON_MILESTONES } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { withChestsDone } from '../src/surfaces/minecraft/minecraftPlanDone.js';

/**
 * Run 42 (2026-10-27, Sonnet, rel59): she went down at health 11.3 that did not come back (the live said the fact alone, 7 decisions in a row) and was shot dead;
 * p1.2 「村の箱を開ける」 stayed the plan's now for 700 s after its chest was emptied, so the now never came to the food; the descent's note ended with a way
 * past it (「このまま行くなら why に…書く」) and put the loss at 150 s, where the runs measured 540 s and a death.
 */
const T = 'run42-task';
afterEach(() => forgetActNodes());

/** The plan of run 42 at +97 (revision 5, from its commands): p1.2 the now, p2.3 the work. */
const node = (id: string, title: string, extra: Partial<PlanNode> = {}): PlanNode => {
  const parentId = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null;
  return { id, parentId, order: Number(id.slice(id.lastIndexOf(id.includes('.') ? '.' : 'p') + 1)) - 1, title, state: 'continue', ...extra };
};
const run42Tree = (): PlanTree => ({ schema: PLAN_TREE_SCHEMA, revision: 5, current: 'p1.2', nodes: [
  node('p1', '村を回る', { where: '141,75,204', doneWhen: 'have:bed>=1&food>=20' }),
  node('p1.1', 'ベッドを取る', { where: '141,75,204', doneWhen: 'have:bed>=1', state: 'done' }),
  node('p1.2', '村の箱を開ける', { where: '157,67,200' }),
  node('p2', '木と石の道具', { doneWhen: 'have:stone_pickaxe&have:stone_axe&have:stone_sword' }),
  node('p2.1', '原木を集める', { doneWhen: 'have:log>=8|have:wooden_pickaxe', state: 'done' }),
  node('p2.2', '作業台と木のツルハシ', { doneWhen: 'have:wooden_pickaxe', state: 'done' }),
  node('p2.3', '丸石で石の道具', { doneWhen: 'have:stone_pickaxe&have:stone_axe&have:stone_sword' }),
  node('p3', '食料を集める', { where: '157,67,200', doneWhen: 'food>=40' }),
  node('p4', '下りる準備', { doneWhen: 'food>=40&have:crafting_table|food>=40&have:planks>=4' }),
  node('p5', '鉄を掘り焼く', { where: '155,12,223', doneWhen: 'have:iron_ingot>=30|have:iron_chestplate' }),
  node('p6', '鉄の装備を作り着る', { doneWhen: 'have:iron_pickaxe&have:bucket&have:shield&have:iron_chestplate' }),
] });
const apply = (tree: PlanTree, update: PlanUpdate): PlanTree => {
  const result = applyPlanUpdate(tree, update);
  expect(result.problem ?? null).toBeNull();
  return result.tree;
};
/** q7's result at +97, as the head read it. */
const Q7 = [
  'act 全部済み（2/2、33.5秒）',
  '1 go 済 go 着いた (156,66,198) 道 82 歩・掘 0・置 0・引き直し 7 回（32.8秒）',
  '2 chest 済 sweet_berries×6 を取った、pumpkin_seeds×2 を取った、potato×2 を取った、bundle×1 を取った、spruce_log×1 を取った。(157,67,200) の chest の中身: 空（前は sweet_berries×6 pumpkin_seeds×2 potato×2…',
  '今 (156,66,198) 体力20 満腹20',
  'chest (157,67,200): 空',
].join('\n');

describe('a chest node is done when an act opened the chest at its place', () => {
  it('closes run 42\'s p1.2 from q7\'s result, and the plan\'s now leaves it', () => {
    noteChestsOpened(T, Q7, '[p1.2] 村の箱を開ける');
    const closed = chestNodesDone(T, run42Tree())!;
    expect(closed.ids).toEqual(['p1.2']);
    const tree = apply(run42Tree(), closed.update);
    expect(tree.nodes.find(item => item.id === 'p1.2')!.state).toBe('done');
    expect(tree.current).not.toBe('p1.2');
  });
  it('merges with the nodes the frame shows done, each once', () => {
    noteChestsOpened(T, Q7, '[p1.2] 村の箱を開ける');
    const merged = withChestsDone({ update: { ops: [{ op: 'set', id: 'p2.3', state: 'done' }] }, ids: ['p2.3'] }, chestNodesDone(T, run42Tree()));
    expect(merged!.ids).toEqual(['p2.3', 'p1.2']);
    expect(withChestsDone(null, chestNodesDone(T, run42Tree()))!.ids).toEqual(['p1.2']);
  });
  it('leaves a chest node at another place, one with its own doneWhen, and an act whose chest hand did not run', () => {
    noteChestsOpened(T, Q7.replace(/157,67,200/gu, '120,64,90'), '[p1.2] 村の箱を開ける');
    expect(chestNodesDone(T, run42Tree())).toBeNull();
    forgetActNodes();
    noteChestsOpened(T, Q7.replace('2 chest 済', '2 chest 止'), '[p1.2] 村の箱を開ける');
    expect(chestNodesDone(T, run42Tree())).toBeNull();
    forgetActNodes();
    noteChestsOpened(T, Q7, '[p1.2] 村の箱を開ける');
    const own = run42Tree();
    expect(chestNodesDone(T, { ...own, nodes: own.nodes.map(item => item.id === 'p1.2' ? { ...item, doneWhen: 'have:bread>=3' } : item) })).toBeNull();
  });
  it('closes a chest node with no place when the act was tagged for it', () => {
    noteChestsOpened(T, Q7, '[p1.2] 村の箱を開ける');
    const tree = run42Tree();
    const closed = chestNodesDone(T, { ...tree, nodes: tree.nodes.map(item => item.id === 'p1.2' ? { ...item, where: undefined } : item) });
    expect(closed!.ids).toEqual(['p1.2']);
  });
});

describe('the now comes to the preparation in run 42\'s order of acts', () => {
  it('before: p1.2 open, the now stays on it through the stone tools and the descent tags (p4.1 and p5.1, which the plan does not have)', () => {
    let tree = run42Tree();
    for (const tag of ['p2.3', 'p2.3']) noteItemStart(T, tag, tree.current);
    expect(followNode(T, tree)).toBeNull();
    tree = apply(tree, { ops: [{ op: 'set', id: 'p2.3', state: 'done' }] });
    expect(tree.current).toBe('p1.2');
  });
  it('after: p1.2 closed by its chest, the stone tools take the now, then 食料を集める (+190), and the descent tags (p4.1) put it on 下りる準備, where the iron (p5.1) does not move it', () => {
    noteChestsOpened(T, Q7, '[p1.2] 村の箱を開ける');
    let tree = apply(run42Tree(), chestNodesDone(T, run42Tree())!.update);
    expect(tree.current).toBe('p2.3');
    for (const tag of ['p2.3', 'p2.3']) noteItemStart(T, tag, tree.current);
    const toTools = followNode(T, tree);
    if (toTools) tree = apply(tree, { ops: [], current: toTools.to });
    expect(tree.current).toBe('p2.3');
    tree = apply(tree, { ops: [{ op: 'set', id: 'p2.3', state: 'done' }] });
    expect(tree.current).toBe('p3');
    // +294: 「[p4.1] 鉄へ下りる（食料 18/40・作業台 無・板 20）」 twice.
    for (const tag of ['p4.1', 'p4.1']) noteItemStart(T, tag, tree.current);
    const moved = followNode(T, tree);
    if (moved) tree = apply(tree, { ops: [], current: moved.to });
    expect(tree.current).toBe('p4');
    // +305: 「[p5.1] 鉄を掘る（食料 18/40）」: the preparation holds the now.
    for (const tag of ['p5.1', 'p5.1']) noteItemStart(T, tag, tree.current);
    expect(followNode(T, tree)).toBeNull();
  });
  it('reads a tag the plan does not have as its nearest ancestor (p5.1 → p5), which an earlier open preparation (p3) takes', () => {
    let tree = run42Tree();
    tree = apply(tree, { ops: [{ op: 'set', id: 'p1.2', state: 'done' }, { op: 'set', id: 'p2.3', state: 'done' }], current: 'p2' });
    for (const tag of ['p5.1', 'p5.2']) noteItemStart(T, tag, tree.current);
    const moved = followNode(T, tree)!;
    expect(moved.to).toBe('p3');
    expect(moved.words).toContain('[p3] 食料を集める');
  });
});

const world = (health: number, food: number, items: Array<[string, number]>) => ({ health, food, inventory: items.map(([name, count]) => ({ name, count })) });
const counts = (items: Array<[string, number]>) => carriedItemCounts(world(20, 20, items), {});

describe('health that does not come back says what to eat, how long it then takes, and what going on without it cost', () => {
  it('says run 42\'s +1,563 (health 11.3, fullness 16, potatoes, mutton and berries in the pack)', () => {
    const line = recoveryLine(16, 11.3, 28.8, counts([['potato', 5], ['mutton', 2], ['sweet_berries', 6]]))!;
    expect(line).toBe('体力 11.3/20 は自然に戻らない（満腹 16＜18、食料 28.8 点）。mutton×2 を食べると満腹 20 になり、満腹 18 以上の間は体力が 4 秒に 1 戻る'
      + '（20 まで約 35 秒。満腹が 18 を切ったらまた食べる）');
  });
  it('picks the fuller food first and says when the pack does not reach 18', () => {
    expect(recoveryLine(8, 14, 13, counts([['bread', 3], ['cooked_beef', 1]]))).toContain('cooked_beef×1・bread×1 を食べると満腹 20 になり');
    expect(recoveryLine(10, 14, 2, counts([['sweet_berries', 1]]))).toContain('持ち物の食べ物（sweet_berries×1）では満腹 12 までで 18 に届かない');
    expect(recoveryLine(10, 14, 0, counts([]))).toContain('持ち物に食べ物が無い');
  });
  it('is null at full health or a fullness of 18', () => {
    expect(recoveryLine(16, 20, 10, counts([]))).toBeNull();
    expect(recoveryLine(18, 11, 10, counts([]))).toBeNull();
  });
});

const descent = (health: number, hunger: number) => {
  const observation: BodyObservation = { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
    state: { world: { position: { x: 156, y: 66, z: 198 }, dimension: 'overworld', health, food: hunger,
      inventory: [{ name: 'spruce_planks', count: 0 }, { name: 'sweet_berries', count: 6 }, { name: 'potato', count: 2 }] } as never }, facts: {} };
  return descentNote({ hands: [{ do: 'go', to: { x: 155, y: 14, z: 223 } }] }, observation);
};

describe('the descent\'s note has no way past it, the measured loss, and the health', () => {
  it('says run 42\'s +294 without 「このまま行くなら」 and with about 500 s', () => {
    const note = descent(20, 20)!;
    expect(note).toContain('準備の状態（この act は地下 y=14 へ下りる手）: 未達 — 食料');
    expect(note).toContain('この受付は、準備が満たされたことを表さない');
    // GPT's review 2026-10-28: the result says the state, not the rule or the story of a run.
    expect(note).not.toContain('実走');
    expect(note).not.toContain('下りる前に狩る');
    expect(note).not.toContain('このまま行くなら');
    expect(note).not.toContain('150 秒');
  });
  it('says health that does not come back', () => {
    expect(descent(11.3, 16)).toContain('。体力 11.3/20 は戻らない（満腹 16＜18）');
    expect(descent(20, 16)).not.toContain('体力');
  });
});

describe('the cost of leaving the preparation out is one number everywhere', () => {
  it('is 500 s in the meter, the rules and the always text, and no 150 s is left', () => {
    expect(PREP_SKIP_SECONDS).toBe(500);
    // The meter says the state of the preparation only; the 500 s and its reason are said once, in the rule of the instructions.
    expect(DRAGON_MILESTONES.find(item => item.kept)!.cost).toBeUndefined();
    expect(PREP_DESCENT_RULE).toContain('地上へ戻るのに約 500 秒かかり');
    expect(V2_ALWAYS.split('約 500 秒').length - 1).toBe(1);
    expect(`${V2_ALWAYS}\n${PREP_RULES_WORDS}`).not.toMatch(/150 秒/u);
  });
  it('keeps the always text within 8,800', () => {
    expect(llmcTokens(minecraftV2System(V2_ALWAYS))).toBeLessThan(8_800);
  });
});
