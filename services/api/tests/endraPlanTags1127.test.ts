import { afterEach, describe, expect, it } from 'vitest';
import { planFromSeeds, type PlanSeed } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { roadLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { toolLines, fightLines } from '../src/surfaces/minecraft/minecraftLlmcFightFacts.js';
import { digPackLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { endLackLine, readinessParts, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { llmcInputProblem } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { FIRST_PLAN_SYSTEM_R9 } from '../src/surfaces/minecraft/minecraftFirstPlanPrompts.js';
import { candidateMenuTools } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import type { ActHand } from '../src/contracts/minecraftActContract.js';

/**
 * Run 7 of 11/26 (the head's input: the node tags, the tools' wear, the full pack, the End's shortage, the schema problem). The plan below is the one that run's
 * decisions read (its top-level titles are the ones the road printed at d0008 and d0090).
 */
const frame = (world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '2026-11-26T15:30:00Z',
  receivedAt: 't', connected: true, state: { world } as never, facts: facts as never });

const seed = (id: string, title: string, fields: Partial<PlanSeed> = {}): PlanSeed => ({ id, title, ...fields } as PlanSeed);
const plan = () => planFromSeeds([
  seed('p1', '武器と防具の点検', { kind: 'other' }),
  seed('p2', '生肉を焼く', { kind: 'food' }),
  seed('p3', 'ブレイズロッド7本', { kind: 'blaze' }),
  seed('p4', 'エンダーパール14', { kind: 'pearl' }),
  seed('p5', '帰りのゲートへ', { kind: 'nether' }),
  seed('p6', 'ストロングホールド探し', { kind: 'stronghold', children: [seed('n1', '交点の手前まで南へ歩き、目玉を投げ直す', { kind: 'stronghold' })] }),
  seed('p7', '黒曜石12を取る', { kind: 'obsidian', where: '177,63,-398（ネザー）' }),
  seed('p8', 'エンドポータルを開く', { kind: 'stronghold' }),
  seed('p9', 'エンドへ入る', { kind: 'end', children: [seed('p9.1', 'エンドクリスタルを壊す', { kind: 'dragon' }), seed('p9.2', '竜を倒す', { kind: 'dragon' })] }),
  seed('p10', '竜戦用ベッド10', { kind: 'bed', doneWhen: 'have:bed>=8' }),
  seed('p11', '弓と矢を作る', { kind: 'other' }),
] as PlanSeed[])!;
const withState = (done: string[], current: string) => {
  const tree = plan();
  return { ...tree, current, nodes: tree.nodes.map(node => ({ ...node, state: done.includes(node.id) ? 'done' as const : node.state })) };
};

afterEach(() => undefined);

describe('(a) the road names every open top-level node with its id, and the current leaf when it is a child', () => {
  it('d0003: the obsidian node p7 and the End entry p9 are named on the road with their tags (before: 「ほか 5 節」, titles nowhere)', () => {
    const road = roadLine(withState(['p2', 'p3'], 'p1'))!;
    expect(road).toContain('p1 武器と防具の点検◀今');
    expect(road).toContain('p7 黒曜石12を取る');
    expect(road).toContain('p9 エンドへ入る');
    expect(road).not.toContain('ほか');
  });
  it('d0090: the road says [n1] beside p6 when the current node is its child (before: 「ストロングホールド探し◀今」 only)', () => {
    const road = roadLine(withState(['p1', 'p2', 'p3', 'p4', 'p5'], 'n1'))!;
    expect(road).toContain('p6 ストロングホールド探し◀今[n1]');
  });
  it('re-reads a done bed node against the pack: not a ✓ when the beds are gone', () => {
    const tree = withState(['p10'], 'p1');
    const beds = (count: number) => frame({ inventory: [{ name: 'white_bed', count }], dimension: 'overworld' });
    expect(roadLine(tree, beds(10))).toContain('p10 竜戦用ベッド10✓');
    expect(roadLine(tree, beds(2))).toContain('p10 竜戦用ベッド10（今は足りない）');
  });
  it('the road and the first plan and the plan tool say the dimension beside a where', () => {
    expect(FIRST_PLAN_SYSTEM_R9).toContain('where は座標のあとに次元を添える');
    expect(FIRST_PLAN_SYSTEM_R9).toContain('エンドの点検の節（黒曜石・ベッド・弓と矢）は、エンドへ入る節より前');
    const tool = candidateMenuTools([{ name: 'plan.update', description: 'plan', nativeInputSchema: {} } as never]).find(item => item.name === 'plan.update')!;
    expect(tool.description).toContain('where の座標のあとに次元を添える');
  });
});

describe('(b) a tool under a third of its life is said as the shield is', () => {
  const world = { inventory: [{ name: 'diamond_pickaxe', count: 1, durability: { left: 113, max: 1561 } }, { name: 'stone_axe', count: 1, durability: { left: 15, max: 131 } },
    { name: 'iron_sword', count: 1, durability: { left: 250, max: 250 } }, { name: 'diamond', count: 1 }, { name: 'iron_ingot', count: 2 }, { name: 'raw_iron', count: 2 }] };
  it('names the wear and what the recipe needs against what the pack holds; a whole tool has no line', () => {
    const lines = toolLines(world);
    expect(lines).toEqual([
      'diamond_pickaxe 残り 113/1561（1/3 を切っている。作り直すなら ダイヤ 3・棒 2（持ち: ダイヤ 1・棒 0））',
      'stone_axe 残り 15/131（1/3 を切っている。作り直すなら 丸石 3・棒 2（持ち: 丸石 0・棒 0））',
    ]);
    expect(lines.join('')).not.toContain('iron_sword');
  });
  it('is in the fight facts beside the shield line, and says nothing of a pack with a half-used pickaxe', () => {
    expect(fightLines(frame(world), false).some(line => line.startsWith('diamond_pickaxe 残り 113/1561'))).toBe(true);
    expect(toolLines({ inventory: [{ name: 'diamond_pickaxe', count: 1, durability: { left: 764, max: 1561 } }] })).toEqual([]);
  });
});

describe('(c) a digging hand against a full pack says how many it can take and how many the act may dig', () => {
  const inventory = [{ name: 'cobbled_deepslate', count: 98 }, { name: 'cobblestone', count: 54 }, ...Array.from({ length: 34 }, (_, index) => ({ name: `junk_${index}`, count: 1 }))];
  const go = (maxDig: number) => ({ do: 'go', to: { x: 1, y: 2, z: 3 }, canDig: ['stone'], maxDig } as ActHand);
  it('d0085: free 0, the room is what the part-filled stacks hold; a go past it says it stops full', () => {
    const line = digPackLine(frame({ inventory, freeSlots: 0 }), [go(40)], [], 'plan1127-c1')!;
    expect(line).toContain('空き 0/36：掘って出る石・深層岩・土は 1 つも拾えない。拾える見込みは約 40 個まで・この act の掘る上限は合わせて 40（足りる）');
    expect(digPackLine(frame({ inventory, freeSlots: 0 }), [go(100)], [], 'plan1127-c2')).toContain('上限まで掘ると途中で満杯になり止まる');
  });
  it('counts the drop in the same act, and the free slots at 64 a slot', () => {
    const line = digPackLine(frame({ inventory, freeSlots: 2 }), [{ do: 'drop', items: [{ item: 'cobbled_deepslate', count: 34 }] } as unknown as ActHand, go(150)], [], 'plan1127-c3')!;
    expect(line).toContain('拾える見込みは約 202 個まで（この act の drop 34 個を含む）・この act の掘る上限は合わせて 150（足りる）');
  });
});

describe('(d) the End shortage as one line of numbers', () => {
  const world = (extra: Record<string, unknown> = {}) => ({ dimension: 'overworld', worn: '頭: iron_helmet(残り133/165)、胴: iron_chestplate(残り208/240)、脚: なし、足: なし、左手: shield(残り107/336)',
    inventory: [{ name: 'diamond_pickaxe', count: 1, durability: { left: 73, max: 1561 } }, { name: 'ender_eye', count: 11 }, { name: 'white_bed', count: 1 }, { name: 'yellow_bed', count: 5 },
      { name: 'obsidian', count: 7 }, { name: 'flint', count: 2 }, { name: 'blaze_powder', count: 1 }], ...extra });
  it('d0132: beds 6/8, obsidian 7/8, no bow, arrows 0/12, the pickaxe, the armour 2/4, the eyes and what makes up for a broken one', () => {
    const facts = readinessOf(frame(world()))!;
    expect(endLackLine(facts, ['stronghold'])).toBe('エンドへ入る前に要る物のうち足りない分（数）: ベッド 6/8（あと 2）・黒曜石 7/8（あと 1）・弓なし（作るなら糸 0/3・棒 0/3。弓・矢は道中で材料が手に入った時だけ作る物で、取りに出る節は要らない）・矢 0/12（羽根 0・火打石 2・棒 0）'
      + '・diamond_pickaxe 耐久 73/1561・防具 2/4（脚・足が無い）・アイ 11/12（割れた分の作り足し: パール 0・粉 1・ロッド 0）');
  });
  it('says nothing in the Nether, or when every number is met', () => {
    expect(endLackLine(readinessOf(frame(world({ dimension: 'the_nether' })))!, ['stronghold'])).toBeNull();
  });
  it('is part of the live shortage of a task whose node is of the stronghold', () => {
    const tree = withState(['p1', 'p2', 'p3', 'p4', 'p5'], 'n1');
    const parts = readinessParts({ plan: () => undefined, planView: () => null, planTree: () => tree, journeyReadiness: true } as LlmcBodyParts, null, frame(world()), 't1');
    expect(parts.shortage).toContain('エンドへ入る前に要る物のうち足りない分（数）: ベッド 6/8');
  });
});

describe('(e) the schema problem of a count over its cap says what the cap is and looks at the other cap', () => {
  it('d0046: maxDig 250 names maxDig first and says the other cap (maxPlace 100) too, so the retry is not refused for maxPlace', () => {
    const problem = llmcInputProblem('mc.act', { hands: [{ do: 'drop', items: [{ item: 'netherrack', count: 55 }] }, { do: 'go', maxDig: 250, maxPlace: 120, seconds: 120, range: 3,
      canDig: ['netherrack'], canPlace: ['netherrack'], to: { x: 24, y: 46, z: -24 } }], why: '[p1] x' })!;
    expect(problem).toContain('手2（go）の maxDig は 0〜200（今は 250）');
    expect(problem).toContain('上限は 1 手で掘る・置く数の最大で、足りない道は go を区切って続けて積む');
    expect(problem).toContain('同じ手の maxPlace は 100 まで も上限を確かめてから出し直す');
  });
  it('leaves other refusals as they were', () => {
    expect(llmcInputProblem('mc.act', { hands: [{ do: 'go', seconds: 'x', to: { x: 1, y: 2, z: 3 } }], why: '[p1] x' })).not.toContain('上限は 1 手');
  });
});
