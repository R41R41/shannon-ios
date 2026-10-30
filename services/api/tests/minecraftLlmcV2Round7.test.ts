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
import { stageKnowledge, V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
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
    expect(packLines(BEDS).at(-1)).toBe('ベッドは足りている（3）。これ以上取りに行かない（エンドの前に羊毛から 4〜6 に増やす）');
    expect(packLines(['purple_bed×1', 'cobblestone×12']).join('\n')).not.toContain('ベッドは足りている');
    expect(packLines(BEDS, { forEnd: true }).join('\n')).not.toContain('ベッドは足りている');
  });
  it('is in the rewritten live state, and not when the plan\'s node is the End\'s', () => {
    const live = (planNow: string, kind: PlanKind) => rewriteLlmcLive({ body: { map: undefined, state: { dimension: 'overworld' }, planNow, planFacts: planFacts(kind), inventory: BEDS }, plan: {} }).live.body as Record<string, unknown>;
    expect((live('[p2.1] 村を回る', 'village').pack as string[]).join('\n')).toContain('ベッドは足りている（3）');
    expect((live('[p17] エンドへ: アイをはめる', 'stronghold').pack as string[]).join('\n')).not.toContain('ベッドは足りている');
  });
});

describe('the seed plan: the iron before the Nether and one bed', () => {
  const rows = (tree: PlanTree) => tree.nodes.map(node => `${node.id} ${node.title}|${node.doneWhen ?? ''}`);
  const on = seedPlan('エンドラを倒して')!;
  // Owner 2026-10-24 (after run 38): the iron helmet, chestplate and leggings worn before the diamonds; the boots are golden (`minecraftLlmcV2Fix12.test.ts`).
  it('about 30 iron, the pickaxe, the bucket, the shield and the helmet, chestplate and leggings worn', () => {
    expect(rows(on)).toContain('p3 鉄（約30・兜・胸・脚まで）|have:iron_pickaxe&have:bucket&have:shield&have:iron_helmet&have:iron_chestplate&have:iron_leggings');
    expect(rows(on)).toContain('p3.3 鉄の兜・胸当て・脚を作って着る|have:iron_helmet&have:iron_chestplate&have:iron_leggings');
    expect(rows(on).some(line => line.includes('鉄を約30個掘る（y=16前後・洞窟）'))).toBe(true);
  });
  it('the beds node done by `have:bed>=1` and one or two', () => {
    expect(rows(on)).toContain('p2 食料とベッド（最初の夜の前・鉄より前）|food>=40&have:bed>=1');
    expect(rows(on).some(line => line.includes('ベッド1〜2'))).toBe(true);
  });
  it('is said to the first plan and the stage knowledge in the same words: the iron, the armour, the golden boots and the beds', () => {
    expect(PREP_RULES_WORDS).toContain('鉄はネザーまでに約 30（ツルハシ 3・バケツ 3・盾 1・兜 5・胸 8・脚 7・火打ち金 1・剣 2）');
    expect(PREP_RULES_WORDS).toContain('ベッドの節の doneWhen は have:bed>=1');
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
  it('is not sent the first time (a stand of waits only), and the same act again is sent whole with the note', () => {
    forgetFurnaceStands();
    const first = candidateAct({ hands: ['wait 30', 'wait 30'] }, world(151_000), 'furnace-stand');
    expect(first.guard?.stopped).toBe(true);
    expect(first.guard?.text).toContain('立って待つだけの手（合わせて 60 秒）は送っていない（手は動いていない）。かまどの焼き上がりまで (158,66,200) の raw_iron×22 はあと約 151 秒');
    expect(first.guard?.text).toContain('基数に分けると並んで焼ける');
    // GPT's review 2026-10-28: the result no longer tells that the same act sent again goes.
    expect(first.guard?.text).not.toContain('もう一度出せば送る');
    expect(first.guard?.text).not.toContain('足して出し直す');
    const entry = candidateAct({ hands: ['wait 30', 'wait 30'] }, world(151_000), 'furnace-stand');
    expect(entry.note).toContain('かまどの焼き上がりまで (158,66,200) の raw_iron×22 はあと約 151 秒');
    expect(entry.guard).toBeUndefined();
    // Hands that work beside the wait, an urgent decision, and a short wait are never held.
    forgetFurnaceStands();
    expect(candidateAct({ hands: ['dig 1,0,0 rel', 'wait 30'] }, world(151_000), 'furnace-stand').guard).toBeUndefined();
    expect(candidateAct({ hands: ['wait 30', 'wait 30'] }, world(151_000), 'furnace-stand', { urgent: true }).guard).toBeUndefined();
    expect(candidateAct({ hands: ['wait 5'] }, world(151_000), 'furnace-stand').guard).toBeUndefined();
    expect(V2_ALWAYS).toContain('かまどに入れたら、焼ける間（jobs の残り秒）は別の作業（準備の補い・装備作り・資材集め・移動）を列に足す。wait だけの act は、有用な手を選べない時だけで、why に待つ対象と理由を書く');
  });
});

describe('the near lava beside the far obsidian (run 37, 1,349–1,611 s: 85 m of stair to a natural obsidian, a lava 10 m off)', () => {
  const SELF = at(170, -14, 150);
  const LANDMARKS = ['L 溶岩源 (173,-16,147) 東3・北3・下2 溜まりの源 4', 'O 黒曜石 (253,-55,154) 東83・南4・下41 ×6', 'ほか2件（長いため略）'];
  it('puts both distances side by side with where each was read, and says the lava is the nearer', () => {
    const [line] = obsidianWays({ planFacts: planFacts('obsidian', { id: 'p6.2' }), landmarks: LANDMARKS }, SELF, null);
    expect(line).toContain('溶岩の源 (173,-16,147) まで 5m（目印）');
    expect(line).toContain('自然の黒曜石 (253,-55,154) まで 93m（目印）（溶岩の方が近い）');
    expect(line).toContain('階段掘りは 0.5〜0.9 マス/秒');
  });
  it('reads the scan\'s rows too, and says what is not in sight', () => {
    expect(obsidianWays({ planFacts: planFacts('obsidian', { id: 'p6.2' }), landmarks: [], scan: ['溶岩の溜まり 1か所: 10m 東 (173,-16,147)'] }, SELF, null)[0])
      .toContain('溶岩の源 (173,-16,147) まで 5m（走査） / 自然の黒曜石 見えていない');
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
