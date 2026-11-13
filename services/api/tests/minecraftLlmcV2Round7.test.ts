import { describe, expect, it } from 'vitest';
import type { PlanKind, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { forgetFurnaceStands, furnaceWaitNote } from '../src/surfaces/minecraft/minecraftLlmcFurnaceWait.js';
import { rewriteLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLiveRewrite.js';
import { obsidianWays } from '../src/surfaces/minecraft/minecraftLlmcObsidianWays.js';
import { bedsIn, packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { preflightAct } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import { BODY_RULES } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { candidateAct } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { stageKnowledge, V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { PREP_RULES_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { ownFirstPlanSystem } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { planFacts } from './helpers/planTreeV2.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, the seventh round (run 37, rel41: the first time from nothing into the Nether, in 2,335 s; 535 s over the pass mark): the iron before
 * the Nether about ten, no standing at the furnace, the near lava beside the far obsidian, a walk into the gate's cell not held, the beds that are enough.
 * The scenes are built from the coordinates and words of the run (task of 2026-10-23 16:20): the stand at the furnace at 855–1,030 s, the lava (173,-16,147)
 * 10 m off and the obsidian (253,-55,154) 85 m off, the walk to (229,-54,196) held at 2,308.
 */
type Cell = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): Cell => ({ x, y, z });
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });

describe('a walk into the gate\'s cell (run 37, +2,308: held as 「塞がっている」, six seconds lost)', () => {
  /** x=-4..4: a corridor of air to (3,0,0), the portal cell `p` at (3,0,0) with its head cell, rock round. */
  function gate(): string {
    const lines = ['地図 v1 足=(0,0,0) x=-4..4 z=-2..2 方式=layers 上=北'];
    for (const y of [1, 0, -1]) {
      lines.push(y === 1 ? `y=${y} x=-4..4 z=-2..2` : `y=${y}`);
      for (let z = -2; z <= 2; z += 1) {
        lines.push(` ${z} ${Array.from({ length: 9 }, (_, i) => {
          const x = i - 4;
          if (z !== 0) return '#';
          if (y === -1) return 'O';
          return x === 0 && y === 0 ? '@' : x >= 1 && x <= 2 ? '.' : x === 3 ? 'p' : x < 0 ? '#' : '#';
        }).join(' ')}`);
      }
    }
    return lines.join('\n');
  }
  const walk = { hands: [{ do: 'walk', to: at(3, 0, 0), range: 0 }] };
  it('lets the walk into the portal go in the mode (a portal is entered by walking into it), and holds a walk into a wall as before', () => {
    expect(preflightAct(walk, { map: gate(), feet: at(0, 0, 0), rules: BODY_RULES }, { bodyRules: true })).toBeNull();
    expect(preflightAct({ hands: [{ do: 'walk', to: at(4, 0, 0), range: 0 }] }, { map: gate(), feet: at(0, 0, 0), rules: BODY_RULES }, { bodyRules: true }))
      .toMatchObject({ kind: 'walk', code: 'feet_solid' });
  });
  it('is the same without the mode: the portal symbol is read as the legends before read it (nothing named)', () => {
    expect(preflightAct(walk, { map: gate(), feet: at(0, 0, 0) })).toBeNull();
  });
});

describe('the beds: enough with two (runs 36 and 37: 85–90 s fetching beds with three in the pack)', () => {
  const BEDS = ['purple_bed×1', 'blue_bed×1', 'red_bed×1', 'cobblestone×12'];
  it('counts the beds in the stacks and says they are enough from two, not in front of the End', () => {
    expect(bedsIn(BEDS)).toBe(3);
    expect(packLines(BEDS).at(-1)).toBe('ベッドは 3 個（エンドの竜戦に 10・最低 8）。通る村のベッドは全部取れる。ベッドのためだけに村へ戻った往復は 1 回 85〜90 秒だった（実走 36・37）。'
      + '羊毛からも作れる（同じ色 3＋板 3。ハサミなら羊 1 頭で 1〜3）');
    expect(packLines(['purple_bed×1', 'cobblestone×12']).join('\n')).not.toContain('ベッドは 3 個（');
    expect(packLines(BEDS, { forEnd: true }).join('\n')).not.toContain('ベッドは 3 個（');
  });
  it('is in the rewritten live state, and not when the plan\'s node is the End\'s', () => {
    const live = (planNow: string, kind: PlanKind) => rewriteLlmcLive({ body: { map: undefined, state: { dimension: 'overworld' }, planNow, planFacts: planFacts(kind), inventory: BEDS }, plan: {} }).live.body as Record<string, unknown>;
    expect((live('[p2.1] 村を回る', 'village').pack as string[]).join('\n')).toContain('ベッドは 3 個（');
    expect((live('[p17] エンドへ: アイをはめる', 'stronghold').pack as string[]).join('\n')).not.toContain('ベッドは 3 個（');
  });
});

describe('the seed plan: the iron before the Nether and one bed', () => {
  const rows = (tree: PlanTree) => tree.nodes.map(node => `${node.id} ${node.title}|${node.doneWhen ?? ''}`);
  const on = seedPlan('エンドラを倒して')!;
  // Owner 2026-10-24 (after run 38): the iron helmet, chestplate and leggings worn before the diamonds; the boots are golden (`minecraftLlmcV2Fix12.test.ts`).
  it('about 30 iron, the pickaxe, the bucket, the shield and the helmet, chestplate and leggings worn', () => {
    expect(rows(on)).toContain('p4 鉄（約30・剣・盾・バケツまで）|have:iron_pickaxe&have:iron_sword&have:shield&have:bucket');
    expect(rows(on)).toContain('p6 鉄の兜・胸当てを作って着る|have:iron_helmet&have:iron_chestplate');
    expect(rows(on).some(line => line.includes('最初の鉄3を焼いて鉄のツルハシ（棒・台を確認）'))).toBe(true);
  });
  it('the beds node done by `have:bed>=1` and one or two', () => {
    expect(rows(on)).toContain('p3 食料とベッド（最初の夜の前・鉄より前）|stock:food&have:bed>=1');
    expect(rows(on).some(line => line.includes('ベッド全部'))).toBe(true);
  });
  it('is said to the first plan and the stage knowledge in the same words: the iron, the armour, the golden boots and the beds', () => {
    expect(PREP_RULES_WORDS).toContain('鉄はネザーまでに約 30（ツルハシ 3・バケツ 3・盾 1・兜 5・胸 8・火打ち金 1・剣 2・ハサミ 2・予備の剣 2・予備の盾 1・盾の作り直し 2）');
    expect(PREP_RULES_WORDS).toContain('寝る用 1 個（最初の夜の前。doneWhen have:bed>=1）と、竜戦用 10 個（最低 8。target bed×10）');
    expect(ownFirstPlanSystem()).toContain(PREP_RULES_WORDS);
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })).toContain(PREP_RULES_WORDS);
    expect(stageKnowledge({ body: { state: { dimension: 'overworld' } } })).not.toContain('約 10');
  });
});

describe('the furnace: no standing while it works (run 37, 855–1,030 s: 22 iron in one furnace, six waits)', () => {
  const world = (leftMs: number) => frame({ jobs: [{ status: 'waiting_external', remainingEstimateMs: leftMs, input: 'raw_iron', count: 22, position: at(158, 66, 200), completionVerified: false }] });
  const waits = (...seconds: number[]) => ({ hands: seconds.map(value => ({ do: 'wait', seconds: value })) });
  it('adds the seconds left to an act that waits ten seconds or more, and says the wait can hold other hands', () => {
    const note = furnaceWaitNote(waits(30, 30), world(151_000))!;
    expect(note).toBe('手 1 wait（合わせて 60 秒）: かまどの焼き上がりまで (158,66,200) の raw_iron×22 はあと約 151 秒');
  });
  it('says nothing for a short wait, for no furnace, or for a furnace that is done or in another dimension', () => {
    expect(furnaceWaitNote(waits(3), world(151_000))).toBeNull();
    expect(furnaceWaitNote(waits(30), frame({}))).toBeNull();
    expect(furnaceWaitNote(waits(30), world(0))).toBeNull();
    expect(furnaceWaitNote(waits(30), frame({ jobs: [{ status: 'different_dimension', remainingEstimateMs: 90_000, input: 'raw_iron', count: 4, position: at(1, 2, 3) }] }))).toBeNull();
  });
  it('is held at the long wait with the work as hands (run 6: a hold with choices, not a one-time refusal), and the note stays on an act that goes', () => {
    forgetFurnaceStands();
    const marks = ['i 鉄鉱石[iron_ore] (160,60,205) 東2・北5 ×3 見えている'];
    const withWork = frame({ ...(world(151_000).state.world as object), inventory: [{ name: 'stone_pickaxe', count: 1 }], position: at(158, 66, 199), mapLandmarks: marks });
    const first = candidateAct({ hands: ['wait 30', 'wait 30'] }, withWork, 'furnace-stand');
    expect(first.guard?.stopped).toBe(true);
    expect(first.guard?.text).toContain('立って待つ wait（60 秒）は送らない');
    expect(first.guard?.text).toContain('かまど (158,66,200) の raw_iron×22 はあと約 151 秒');
    expect(first.guard?.text).toContain('基数に分けると並んで焼ける');
    expect(first.guard?.text).toContain('A) 鉄鉱石 (160,60,205)');
    // No iron, coal or open section beside the furnace: nothing to put instead, so the wait goes (with the note), as does an urgent decision and a short wait.
    forgetFurnaceStands();
    const entry = candidateAct({ hands: ['wait 30', 'wait 30'] }, world(151_000), 'furnace-stand');
    expect(entry.note).toContain('かまどの焼き上がりまで (158,66,200) の raw_iron×22 はあと約 151 秒');
    expect(entry.guard).toBeUndefined();
    expect(candidateAct({ hands: ['wait 30', 'wait 30'] }, withWork, 'furnace-stand', { urgent: true }).guard).toBeUndefined();
    expect(candidateAct({ hands: ['wait 5'] }, withWork, 'furnace-stand').guard).toBeUndefined();
    expect(V2_STAGES.prep).toContain('焼き待ち・夜待ちの間は、焼き上がりに頼らない採取・作業台・食料と帰路を進める');
    expect(V2_ALWAYS).toContain('A wait-only act only when nothing else can be done');
    expect(V2_ALWAYS).toContain('Do not wait for the night: put one sleep hand');
  });
});

describe('the near lava beside the far obsidian (run 37, 1,349–1,611 s: 85 m of stair to a natural obsidian, a lava 10 m off)', () => {
  const SELF = at(170, -14, 150);
  const LANDMARKS = ['L 溶岩源 (173,-16,147) 東3・北3・下2 溜まりの源 4', 'O 黒曜石 (253,-55,154) 東83・南4・下41 ×6', 'ほか2件（長いため略）'];
  it('puts both distances side by side with where each was read, and says the lava is the nearer', () => {
    const [line] = obsidianWays({ planFacts: planFacts('obsidian', { id: 'p6.2' }), landmarks: LANDMARKS }, SELF, null);
    // Run 8 (11/13): the line begins with the obsidian carried, the gate's least, the aim and the obsidian in view.
    expect(line.startsWith('黒曜石: 持ち物 0／ゲートの分 10（これで足りる。竜戦の 12 は出発の点検で別に取る）。見えている自然の黒曜石 最寄り (253,-55,154) まで 93m（目印）。')).toBe(true);
    expect(line).toContain('溶岩の源 (173,-16,147) まで 5m（目印）');
    expect(line).toContain('（溶岩の方が近い）');
    expect(line).toContain('階段掘りは 0.5〜0.9 マス/秒');
  });
  it('reads the scan\'s rows too, and says what is not in sight', () => {
    expect(obsidianWays({ planFacts: planFacts('obsidian', { id: 'p6.2' }), landmarks: [], scan: ['溶岩の溜まり 1か所: 10m 東 (173,-16,147)'] }, SELF, null)[0])
      .toContain('自然の黒曜石 見えていない。溶岩の源 (173,-16,147) まで 5m（走査）');
    expect(obsidianWays({ planFacts: planFacts('obsidian', { id: 'p6.2' }), landmarks: [] }, SELF, null)).toEqual([]);
  });
  it('is only for the obsidian\'s node, and is `body.obsidian` in the rewritten live state', () => {
    expect(obsidianWays({ planFacts: planFacts('iron', { id: 'p5.1', next: ['diamond'] }), landmarks: LANDMARKS }, SELF, null)).toEqual([]);
    // The next node being the obsidian or the gate is enough too (chapter 7); a title that says 黒曜石 with no kind is not.
    expect(obsidianWays({ planFacts: planFacts('iron', { next: ['portal'] }), landmarks: LANDMARKS }, SELF, null)).toHaveLength(1);
    expect(obsidianWays({ planNow: '[p6.2] 黒曜石', planFacts: planFacts('other'), landmarks: LANDMARKS }, SELF, null)).toEqual([]);
    const body = { map: undefined, state: { at: '(170,-14,150)', dimension: 'overworld' }, planNow: '[p6.2] 黒曜石', landmarks: LANDMARKS };
    expect((rewriteLlmcLive({ body, plan: {} }).live.body as Record<string, unknown>).obsidian).toBeUndefined();
  });
  it('does not turn a shorter resource distance into a claim of faster access', () => {
    const knowledge = stageKnowledge({ body: { state: { dimension: 'overworld' } } });
    expect(knowledge).not.toContain('溶岩が 20m 内にあれば');
    expect(knowledge).toContain('資源のマスと作業の立ち位置は別');
    expect(knowledge).toContain('道が未確認なら早いとは限らない');
  });
});

describe('the seed plan after run 9 (11/13): water before the armour, the village on top, eyes 13, the frame taken back', () => {
  const plan = seedPlan('エンドラを倒して')!;
  const tops = plan.nodes.filter(node => node.parentId === null);
  const top = (title: string) => tops.find(node => node.title === title)!;
  it('orders the top: stone tools, the village, food and bed, the iron, the water, the armour, the diamonds', () => {
    expect(tops.slice(0, 7).map(node => node.kind)).toEqual(['stone_tools', 'village', 'prep_descent', 'iron', 'water', 'iron_armor', 'diamond']);
    expect(top('村を回る（ベッド全部・干し草・畑・箱）').doneWhen).toBe('have:bed>=8');
    // the iron is closed by its tools and the bucket, not by the armour; its last child has the same words and keeps its title
    expect(tops[3]!.doneWhen).toBe('have:iron_pickaxe&have:iron_sword&have:shield&have:bucket');
    expect(plan.nodes.some(node => node.title === '残りの鉄をまとめて採り焼く・剣・盾・バケツ')).toBe(true);
    expect(tops[4]!.note).toContain('12m 以内');
    expect(tops[5]!.doneWhen).toBe('have:iron_helmet&have:iron_chestplate');
  });
  it('asks 13 eyes and the pearls for them, and takes the gate frame back after the way back', () => {
    const pearls = top('エンダーパール13以上');
    expect(pearls.doneWhen).toBe('have:ender_pearl>=13|have:ender_eye>=13');
    expect(top('エンダーアイ14個').doneWhen).toBe('have:ender_eye>=13');
    const titles = tops.map(node => node.title), back = titles.indexOf('オーバーワールドへ戻る');
    expect(titles[back + 1]).toBe('帰ったゲートの枠の黒曜石を回収（竜戦用 12 に）');
    expect(tops[back + 1]!.doneWhen).toBe('have:obsidian>=12|dim:the_end');
    expect(tops[back + 1]!.kind).toBe('obsidian');
  });
  it('checks food 150 before the End and puts the food 330 under the stronghold as its first child', () => {
    expect(top('出発の点検（エンドへ）').doneWhen).toContain('food>=150');
    const stronghold = top('ストロングホールド'), first = plan.nodes.find(node => node.parentId === stronghold.id)!;
    expect(first.kind).toBe('food');
    expect(first.doneWhen).toBe('food>=330|see:end_portal_frame');
    expect(plan.nodes.filter(node => node.title.startsWith('食料330点')).length).toBe(1);
  });
});
