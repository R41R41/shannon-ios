import { describe, expect, it } from 'vitest';
import type { PlanTree } from '@shannon/mind';
import { expandShortAct, SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import { minecraftV2System } from '../src/infra/models/anthropic/anthropicFcaMinecraftSystem.js';
import { PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { gateFirst, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { currentNodeLine } from '../src/surfaces/minecraft/minecraftLlmcNode.js';
import { lavaPools, obsidianWays } from '../src/surfaces/minecraft/minecraftLlmcObsidianWays.js';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { PREP_RULES_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { candidateMenuTools } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { stageKnowledge, V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { doneStatusWords, type DoneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { planFacts } from './helpers/planTreeV2.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, the twelfth round (2026-10-24, after run 38):
 * - the owner's armour: the iron helmet, chestplate and leggings worn before the diamonds, golden boots before the gate (run 38 had iron boots from a
 *   chest and no golden piece in the Nether);
 * - Notion 09-1c: the rules the code keeps said as it keeps them (calls of a response, the act's failures, the children of a done node, health 8),
 *   an absent field not read as an absent fact, one set of numbers for the first plan, the current node with its condition read against the frame;
 * - run 38: the size of each lava pool beside the nearest source, and the tree she can reach.
 */
const owned = (items: Array<[string, number]>, worn = '') => carriedItemCounts({ inventory: items.map(([name, count]) => ({ name, count })), worn }, {});
const rows = (tree: PlanTree) => tree.nodes.map(node => `${node.id} ${node.title}|${node.doneWhen ?? ''}`);

describe('the armour: iron helmet, chestplate and leggings before the diamonds, golden boots before the gate', () => {
  const on = seedPlan('エンドラを倒して')!;
  it('puts the three iron pieces under the iron, and the golden boots between the diamonds and the obsidian', () => {
    const tops = on.nodes.filter(node => node.parentId === null).map(node => node.title);
    expect(tops.indexOf('金のブーツ（ネザーの前）')).toBe(tops.indexOf('ダイヤ（y=-58）') + 1);
    expect(tops.indexOf('黒曜石10とゲート')).toBe(tops.indexOf('金のブーツ（ネザーの前）') + 1);
    expect(rows(on)).toContain('p3.3 鉄の兜・胸当て・脚を作って着る|have:iron_helmet&have:iron_chestplate&have:iron_leggings');
    expect(rows(on)).toContain('p6 金のブーツ（ネザーの前）|have:golden_boots');
    expect(rows(on)).toContain('p6.1 金鉱石4を掘る（y=-16前後・ダイヤへ下りる途中）|have:raw_gold>=4|have:gold_ingot>=4|have:golden_boots');
    expect(gateFirst([]).length).toBe(0);
  });
  it('asks the three pieces worn at the diamonds\' node, and says one carried and not worn', () => {
    const base = { dimension: 'overworld', food: 50, nowKinds: ['diamond' as const] };
    const kit: Array<[string, number]> = [['iron_pickaxe', 1], ['bucket', 1], ['shield', 1]];
    expect(preparationShortage({ ...base, counts: owned(kit), worn: [] })).toBe('準備の不足（ダイヤを掘る前）: 鉄の兜・胸当て・脚が無い');
    const armour: Array<[string, number]> = [...kit, ['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1]];
    expect(preparationShortage({ ...base, counts: owned(armour), worn: ['iron_helmet', 'iron_chestplate'] }))
      .toBe('準備の不足（ダイヤを掘る前）: 持っているが着ていない: iron_leggings');
    expect(preparationShortage({ ...base, counts: owned(armour), worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings'] })).toBeNull();
  });
  it('asks the golden boots at the gate, iron boots do not stand for them', () => {
    const gate: Array<[string, number]> = [['iron_pickaxe', 1], ['shield', 1], ['iron_sword', 1], ['cobblestone', 64], ['iron_helmet', 1],
      ['iron_chestplate', 1], ['iron_leggings', 1], ['iron_boots', 1]];
    const parts = { dimension: 'overworld', food: 50, nowKinds: ['portal' as const], v2: true };
    expect(preparationShortage({ ...parts, counts: owned(gate) })).toBe('準備の不足（ネザーに入る前）: 金のブーツが無い');
    expect(preparationShortage({ ...parts, counts: owned([...gate, ['golden_boots', 1]]) })).toBeNull();
    // Worn counts: the worn line of the frame is read as carried.
    expect(owned([], '頭: iron_helmet(残り 160/165)、足: golden_boots(残り 91/91)').get('golden_boots')).toBe(1);
  });
  it('says the rules once, the same words in the first plan and the stage knowledge, with no old numbers', () => {
    expect(PREP_RULES_WORDS).toContain('ダイヤを掘りに下りる前: 鉄のツルハシ・バケツ・盾・鉄の兜・胸当て・脚（着る）');
    expect(PREP_RULES_WORDS).toContain('靴は鉄でなく金のブーツ（金の延べ棒 4）');
    const plan = ownFirstPlanSystem();
    expect(plan).toContain(PREP_RULES_WORDS);
    for (const old of ['鉄 24〜36', '24〜36 個', 'ネザーの前の鉄は約 10', '防具は箱で見つけた物か余裕がある時だけ', 'ベッド全部']) expect(plan, old).not.toContain(old);
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })).toContain(PREP_RULES_WORDS);
  });
});

describe('Notion 09-1c: the rules said as the code keeps them', () => {
  const system = minecraftV2System(V2_ALWAYS);
  it('one act a decision, plan.update first in the same response, a probe\'s answer before the hand that needs it', () => {
    expect(system).toContain('mc_act を 1〜2 つ（列に足す）。plan_update は mc_act の前に置けば同じ応答で、書いた順に実行');
    expect(system).not.toContain('のどれか。');
    expect(SHORT_ACT_DESCRIPTION).toContain('手が自分で失敗した時は onFail に従い、反射・stopIf・満杯・時間切れは act 全体をいつでも止める');
  });
  it('one health line: no fight at 8 or less, strike back over 8', () => {
    expect(V2_ALWAYS).toContain('体力 8 以下では戦わない');
    expect(V2_ALWAYS).toContain('鉄以上の剣があり体力 8 超で遮れない時は打ち返す');
    expect(V2_ALWAYS).not.toContain('体力 6 超');
  });
  it('an absent field is not an absent fact, the plan\'s done is not the goal\'s progress, next is the order', () => {
    expect(V2_ALWAYS).not.toContain('出ていない項目 = その事実が今は無い');
    expect(V2_ALWAYS).toContain('出ていない項目は「無い」とは限らない');
    expect(V2_ALWAYS).toContain('done（済み扱いの節/全体。達成率ではない）');
    expect(V2_ALWAYS).toContain('next（予定の次 3 節。すぐできるとは限らない）');
    expect(candidateMenuTools([PLAN_UPDATE_RULES_DEFINITION])[0]!.description).toContain('親が済むと、その下の開いた子（blocked を除く）は「不要になった」として閉じる');
  });
  it('the plan tool says the children of a done node are closed, and plan.update goes before the act', () => {
    const [plan] = candidateMenuTools([PLAN_UPDATE_RULES_DEFINITION]);
    expect(plan!.description).not.toContain('親が済みでも子は済みにならない');
    expect(plan!.description).toContain('親が済むと、その下の開いた子（blocked を除く）は「不要になった」として閉じる');
    expect(plan!.description).toContain('同じ応答で mc_act を続けてよい（plan_update を先に書く。書いた順に実行される）');
    expect(PLAN_UPDATE_RULES_DEFINITION.description).toContain('親が済みでも子は済みにならない');
  });
  it('the first plan reads the scan as not found there, and the closing of the children under a done node', () => {
    const plan = ownFirstPlanSystem();
    expect(plan).not.toContain('走査に無い物は 160m の外にある');
    expect(plan).toContain('走査した範囲では見つからなかった物');
    expect(plan).not.toContain('親が済んでも子は済みにならない');
  });
});

describe('the current node with its condition read against the frame', () => {
  const facts = (items: Array<[string, number]>, food = 30): DoneFacts => ({ counts: owned(items), dimension: 'overworld', feet: { x: 0, y: 64, z: 0 }, food });
  it('says met, or what is missing with how many, or that the frame cannot show it', () => {
    const when = 'have:iron_helmet&have:iron_chestplate&have:iron_leggings';
    expect(doneStatusWords(when, facts([['iron_helmet', 1]]))).toBe('未: iron_chestplate 0/1・iron_leggings 0/1');
    expect(doneStatusWords(when, facts([['iron_helmet', 1], ['iron_chestplate', 1], ['iron_leggings', 1]]))).toBe('満たしている');
    expect(doneStatusWords('food>=40&have:bed>=1', facts([['red_bed', 1]]))).toBe('未: 食料 30/40 点（あと 10 点: bread 1 個）');
    expect(doneStatusWords('have:obsidian>=10|dim:the_nether', facts([['obsidian', 7]]))).toBe('未: obsidian 7/10');
    expect(doneStatusWords('村を回る', facts([]))).toBe('観測では確かめられない（済んだら set state=done）');
    expect(doneStatusWords('have:bed', null)).toBeNull();
    expect(doneStatusWords(undefined, facts([]))).toBeNull();
  });
  it('keeps the condition whole when the place and the path are long: the path goes first, then the place is shortened', () => {
    const node = { id: 'p3.3', title: '鉄の兜・胸当て・脚を作って着る', where: `洞窟の奥 ${'(120,16,-40) '.repeat(12)}`,
      doneWhen: 'have:iron_helmet&have:iron_chestplate&have:iron_leggings' };
    const line = currentNodeLine(node, ['鉄（約30・兜・胸・脚まで）', '鉄の兜・胸当て・脚を作って着る'], '未: iron_leggings 0/1');
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toContain('（済む条件: have:iron_helmet&have:iron_chestplate&have:iron_leggings／今: 未: iron_leggings 0/1）');
    expect(line.startsWith('[p3.3] 鉄の兜・胸当て・脚を作って着る（済む条件:')).toBe(true);
    expect(line).not.toContain('（道:');
    const short = currentNodeLine({ ...node, where: '(120,16,-40)' }, ['鉄（約30・兜・胸・脚まで）'], null);
    expect(short).toBe('[p3.3] 鉄の兜・胸当て・脚を作って着る（済む条件: have:iron_helmet&have:iron_chestplate&have:iron_leggings）＠(120,16,-40)（道: 鉄（約30・兜・胸・脚まで））');
  });
});

describe('run 38: the size of the lava pools (1,090–1,310 s on single sources before a pool of 64)', () => {
  const SELF = { x: 0, y: 0, z: 0 };
  const mapOf = (cells: Record<string, string>): string => {
    const lines = ['地図 v1 足=(0,0,0) x=-3..3 z=-3..3 方式=layers 上=北'];
    for (const y of [1, 0, -1]) {
      lines.push(`y=${y}`);
      for (let z = -3; z <= 3; z += 1) {
        const row: string[] = [];
        for (let x = -3; x <= 3; x += 1) row.push(cells[`${x},${y},${z}`] ?? (y === -1 ? '#' : '.'));
        lines.push(`${z} ${row.join(' ')}`);
      }
    }
    return lines.join('\n');
  };
  const view = (cells: Record<string, string>) => mapView(readLayers(mapOf(cells), BODY_RULES)!);
  it('joins the map\'s sources into pools by their faces, each with its nearest cell and count', () => {
    const pools = lavaPools(view({ '1,0,0': 'L', '-3,0,-3': 'L', '-3,0,-2': 'L', '-2,0,-2': 'L' }), SELF);
    expect(pools.map(pool => [pool.sources, pool.at])).toEqual([[1, { x: 1, y: 0, z: 0 }], [3, { x: -2, y: 0, z: -2 }]]);
  });
  it('says the nearest pool of ten or more beside the nearest source, and that a small one makes only so many', () => {
    const [line] = obsidianWays({ planFacts: planFacts('obsidian', { id: 'p5.2' }), landmarks: ['L 溶岩源 (1,0,0) 東1 溜まりの源 2'],
      scan: ['溶岩の溜まり 3 つ以上（最寄り 東 40m・源 64） (40,0,0)'] }, SELF, null);
    expect(line).toContain('溶岩の源 (1,0,0) まで 1m（目印）');
    expect(line).toContain('源が 10 以上の溜まり (40,0,0) まで 40m（走査）・源 64');
    expect(line).toContain('（いちばん近い源の溜まりは源 2: 黒曜石も 2 個まで）');
    const [none] = obsidianWays({ planFacts: planFacts('obsidian', { id: 'p5.2' }), landmarks: ['L 溶岩源 (1,0,0) 東1'] }, SELF, null);
    expect(none).toContain('源が 10 以上の溜まり 見えていない');
  });
  it('compares accessible local supply with the shortage, and leaves a tree that cannot be reached', () => {
    const prep = stageKnowledge({ body: { state: { dimension: 'overworld' } } })!;
    expect(prep).toContain('現在数と不足分を数え');
    expect(prep).toContain('同じ作業位置から続けて取れる源も比べる');
    expect(prep).toContain('多い溜まりでも道が未確認なら早いとは限らない');
    expect(prep).toContain('崖の上・高い所の木へ土で登る手が 2 回止まったら、その木はやめて別の木へ');
    expect(prep).not.toMatch(/実走\d/u);
  });
});

describe('the bench of 2026-10-24: the slot words of equip', () => {
  it('reads the worn line\'s words and the usual English ones as the body\'s slots, and leaves the body\'s own as they are', () => {
    const slots = (hands: string[]) => ((expandShortAct({ hands }).input as { hands: Array<{ slot?: string }> }).hands).map(hand => hand.slot);
    expect(slots(['equip iron_helmet head', 'equip iron_chestplate torso', 'equip iron_leggings legs', 'equip golden_boots 足', 'equip shield 左手']))
      .toEqual(['head', 'chest', 'legs', 'feet', 'offhand']);
    expect(slots(['equip iron_chestplate'])).toEqual([undefined]);
    expect(expandShortAct({ hands: ['equip iron_chestplate torso'] }).errors).toEqual([]);
  });
});
