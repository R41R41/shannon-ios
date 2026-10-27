import { describe, expect, it } from 'vitest';
import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createFoodTrend, llmcTokens, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { fixLandmarks } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { PLAN_PREP_WORDS, PREP_RULES_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { DRAGON_MILESTONES, isPrepMilestoneNode, meterLine, milestoneWords, PREP_MILESTONE_NAME, roadLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';

/**
 * Run 41 (2026-10-27, Sonnet, rel57): she went down to the iron with no food hunted and no table, stood 372 s without one and died on the way up. The speed had its
 * milestones with seconds and 「あと」; the preparation was one condition among others. The preparation is a milestone of the meter like the speed's, passed over it
 * stays on the road, its reason is in real numbers, the live's two 「food」 are two words, and the new stops of the body are in the contract.
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });
const have = (items: Array<[string, number]>, dimension = 'overworld') => frame({ position: { x: 0, y: 64, z: 0 }, dimension, inventory: items.map(([name, count]) => ({ name, count })) });
const tree = seedPlan('エンドラを倒して')!;
const withState = (done: string[], current: string | null, base: PlanTree = tree): PlanTree => ({ ...base, current,
  nodes: base.nodes.map((node): PlanNode => ({ ...node, state: done.includes(node.id) ? 'done' : node.state })) });

describe('the preparation is a milestone of the meter, with its seconds and its lateness', () => {
  it('is the next milestone after the bed, with the target, how late, what she has now and what leaving it out costs', () => {
    const line = meterLine(tree, have([['blue_bed', 1], ['spruce_planks', 2]]), 260 / 60)!;
    expect(line).toBe('目安: 今 260 秒・次の節目 地下の準備（食料 40 点・作業台か板 4） 目安 200 秒（60 秒遅れ）・今 食料 0/40 点・作業台 無・板 2。省くと上りの往復で約 150 秒失う');
    expect(meterLine(tree, have([['blue_bed', 1]]), 150 / 60)).toContain('目安 200 秒（あと 50 秒）');
  });
  it('is met by 40 food points with a table or 4 planks; a table alone or the food alone is not', () => {
    const food = ['cooked_beef', 2] as [string, number];
    expect(meterLine(tree, have([['blue_bed', 1], food, ['crafting_table', 1]]), 260 / 60)).toBe('目安: 今 260 秒・次の節目 鉄のツルハシ 目安 250 秒（10 秒遅れ）');
    expect(meterLine(tree, have([['blue_bed', 1], food, ['oak_planks', 4]]), 260 / 60)).toContain('次の節目 鉄のツルハシ');
    expect(meterLine(tree, have([['blue_bed', 1], ['crafting_table', 1]]), 260 / 60)).toContain('次の節目 地下の準備');
    expect(meterLine(tree, have([['blue_bed', 1], food]), 260 / 60)).toContain('次の節目 地下の準備');
    // The planks a bed was made of are not planks in the pack.
    expect(meterLine(tree, have([['blue_bed', 1], food, ['spruce_planks', 3]]), 260 / 60)).toContain('次の節目 地下の準備');
  });
  it('is still said when she is past it (the iron pickaxe in the pack) while the plan\'s node for it is open, and not once the plan holds it done', () => {
    const kit = have([['blue_bed', 1], ['iron_pickaxe', 1]]);
    const open = meterLine(tree, kit, 400 / 60)!;
    expect(open).toContain('次の節目 バケツ');
    expect(open).toContain('・まだの節目: 地下の準備（食料 40 点・作業台か板 4）（目安 200 秒。今 食料 0/40 点・作業台 無・板 0。省くと上りの往復で約 150 秒失う。飛ばしたなら plan.update に書く）');
    expect(meterLine(withState(['p2'], null), kit, 400 / 60)).not.toContain('まだの節目');
  });
  it('points the meter at the preparation while the plan\'s current node is one, though a later milestone is met', () => {
    const food = tree.nodes.find(node => node.title.includes('肉を焼く'))!;
    expect(isPrepMilestoneNode(food)).toBe(true);
    const line = meterLine(withState([], food.id), have([['blue_bed', 1], ['iron_pickaxe', 1]]), 400 / 60)!;
    expect(line).toContain('次の節目 地下の準備（食料 40 点・作業台か板 4） 目安 200 秒（200 秒遅れ）');
  });
  it('names the preparation by its title or by 40 to 99 food points, not by the 100 of the gate', () => {
    expect(isPrepMilestoneNode({ id: 'p3', parentId: null, order: 0, title: '地下の準備', state: 'continue' })).toBe(true);
    expect(isPrepMilestoneNode({ id: 'p3', parentId: null, order: 0, title: 'x', state: 'continue', doneWhen: 'have:crafting_table&food>=40' })).toBe(true);
    expect(isPrepMilestoneNode({ id: 'p3', parentId: null, order: 0, title: '食料100点以上に足す', state: 'continue', doneWhen: 'food>=100' })).toBe(false);
  });
  it('has its place between the bed and the iron pickaxe, in the one constant that the instructions read', () => {
    expect(DRAGON_MILESTONES.map(item => item.name).slice(0, 3)).toEqual(['ベッド', PREP_MILESTONE_NAME, '鉄のツルハシ']);
    expect(DRAGON_MILESTONES.find(item => item.name === PREP_MILESTONE_NAME)!.seconds).toBe(200);
    expect(milestoneWords()).toContain('ベッド 150・地下の準備 200・鉄のツルハシ 250');
    expect(V2_ALWAYS).toContain(milestoneWords());
  });
});

describe('the road keeps a node that was passed over', () => {
  it('writes an open node before the one she is in with 「（未・飛ばした）」, and a done one with ✓ as before', () => {
    const road = roadLine(withState(['p1'], 'p3.1'))!;
    expect(road).toContain('木と石の道具✓ 食料とベッド（未・飛ばした） → 鉄◀今');
    expect(road).not.toContain('済み ');
  });
  it('does not count it among the done nodes of 「済み n 節」, and shows it when the done ones are many', () => {
    const road = roadLine(withState(['p1', 'p3', 'p4', 'p5'], 'p6.1'))!;
    expect(road).toContain('食料とベッド（未・飛ばした）');
    expect(road).toContain('済み 1 節');
  });
});

describe('the live says the hunger bar and the food she carries in two words', () => {
  const live = minecraftLlmcLive({ elapsedMinutes: 2, trend: createFoodTrend(), events: [],
    observation: frame({ position: { x: 1, y: 70, z: 3 }, dimension: 'overworld', health: 20, food: 20, saturation: 5, inventory: [{ name: 'dirt', count: 3 }] }) });
  it('has fullness in the state and foodPoints beside it, and no key 「food」', () => {
    expect(live.state).toMatchObject({ fullness: 20, saturation: 5 });
    expect(live.state).toHaveProperty('fullnessLostIn5min');
    expect(live.foodPoints).toEqual({ total: 0, items: [] });
    expect(live).not.toHaveProperty('food');
    expect(JSON.stringify(live.state)).not.toContain('"food"');
  });
  it('says so in the dictionary', () => {
    expect(V2_ALWAYS).toMatch(/^- foodPoints: total（食料の点＝持ち物の食べ物の合計。満腹とは別）/mu);
    expect(V2_ALWAYS).toContain('fullness（満腹 0〜20。食料の点とは別）');
    expect(V2_STAGES.prep).toContain('食料の点（live の foodPoints.total。満腹 fullness とは別）');
  });
});

describe('the reason is in real numbers, and the rule is plain', () => {
  it('says the fullness lasts 30 minutes, that there is no food or wood underground, 150 s of climbs, and the 372 s without a table', () => {
    expect(PREP_RULES_WORDS).toContain('満腹は 30 分もつので、飢えのためではない');
    expect(PREP_RULES_WORDS).toContain('地下には食べ物も木も無く');
    expect(PREP_RULES_WORDS).toContain('上りの往復で約 150 秒');
    expect(PREP_RULES_WORDS).toContain('372 秒止まり');
    expect(PREP_RULES_WORDS).not.toContain('戻りが長い');
    expect(PREP_RULES_WORDS).not.toContain('鉄の夜');
    expect(PREP_RULES_WORDS).not.toContain('の時だけ');
  });
  it('asks for the numbers in the why of a hand that goes down, as a request', () => {
    expect(PREP_RULES_WORDS).toContain('「[p4.1] 鉄へ下りる（食料 0/40・作業台 無・板 2）」');
    expect(V2_STAGES.prep).toContain('「[p4.1] 鉄へ下りる（食料 0/40・作業台 無・板 2）」');
  });
  it('puts the priority plainly in the goal, beside the speed, without a condition under which it holds', () => {
    expect(V2_ALWAYS).toContain('ネザーへ入るまでを 30 分以内に');
    expect(V2_ALWAYS).toContain('準備は速さのために省かない（地下の準備: 食料 40 点・作業台か板 4。shortage の防具・盾）。足りないと上りの往復で 150 秒以上かかり、死ぬこともある。30 分は準備を含む。');
    expect(V2_ALWAYS).not.toContain('鉄の夜');
    expect(minecraftV2System(V2_ALWAYS)).not.toMatch(/実走\d|run ?\d/u);
  });
  it('keeps the instructions within the cap of the mode\'s system text (8,800 by llmcTokens: about 7.1k real tokens, inside the 8k of D3)', () => {
    expect(llmcTokens(minecraftV2System(V2_ALWAYS))).toBeLessThan(8_800);
  });
});

describe('the first plan is asked for the preparation in the descent\'s caution, and food where food is', () => {
  it('has the request in the planner\'s instructions (the own prompt) once', () => {
    const system = ownFirstPlanSystem();
    expect(system).toContain(PLAN_PREP_WORDS);
    expect(system.split(PLAN_PREP_WORDS).length - 1).toBe(1);
    expect(PLAN_PREP_WORDS).toContain('地下へ下りる節（鉄・ダイヤを掘る節）の caution に、その前に済ませる準備を書く');
    expect(PLAN_PREP_WORDS).toContain('食料の節の where は、食料のある所（箱・畑・干し草の座標）にする。ベッドの座標にしない。見当たらなければ ""');
  });
  it('is in the seed plan too: the iron node cautions the descent', () => {
    expect(tree.nodes.find(node => node.title.startsWith('鉄（'))?.caution).toEqual(['食料40点・作業台か板4を持ってから下りる']);
  });
});

describe('the body\'s new stops and names are in the contract', () => {
  it('names search_timeout (「時間切れ」, not a road that is not there), low_floor (「足場が無い」) and falling_above (「上から落ちる」) with what to do next', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('search_timeout（時間切れ: 道探しが持ち時間で終わり、道があるかは分からない。');
    expect(SHORT_ACT_DESCRIPTION).toContain('近い中継点を行き先に go を出し直すか、dig と walk の階段・縦穴で進む');
    expect(SHORT_ACT_DESCRIPTION).toContain('low_floor（足場が無い: 立つ所が丸ごとのブロックでない。隣の丸ごとの床へずれる）');
    expect(SHORT_ACT_DESCRIPTION).toContain('dead_end（許した手では道が無い）');
    expect(SHORT_ACT_DESCRIPTION).toContain('「上から落ちる」で止まる）: 横へ 1 マスずれて掘るか、先に横から砂利を落とす');
    expect(SHORT_ACT_DESCRIPTION).toContain('「足場が無い」で止まる: 隣の丸ごとの床へずれる');
    expect(SHORT_ACT_DESCRIPTION).toContain('「時間切れ」は秒の上限か道探しの持ち時間（go の search_timeout は道が無いとは限らない）');
  });
  it('says in mine and in the map\'s legend that an ore below y=0 is named with deepslate_, and which name to write', () => {
    expect(SHORT_ACT_DESCRIPTION).toContain('y<0 の鉱石は deepslate_ が付く（deepslate_iron_ore）: landmarks の [ ] の中が mine に書く名前');
    expect(V2_ALWAYS).toContain('鉱石の id は y<0 で deepslate_ が付く（deepslate_iron_ore）。mine には landmarks の [ ] の中の名前を書く。');
  });
  it('reads a landmark line that carries the ore\'s id in brackets, as it reads one without', () => {
    const self = { x: 150, y: -6, z: 208 };
    const lines = fixLandmarks(['i 鉄鉱石[deepslate_iron_ore] (152,-14,210) 西2・北2・下8 ×17 見えている', 'i 鉄鉱石 (152,-14,210) 西9・北9・下9 ×17 見えている'], self,
      { fixed: [], added: [], omitted: 0 } as never);
    expect(lines[0]).toBe('i 鉄鉱石[deepslate_iron_ore] (152,-14,210) 東2・南2・下8 ×17 見えている');
    expect(lines[1]).toBe('i 鉄鉱石 (152,-14,210) 東2・南2・下9 ×17 見えている');
  });
});
