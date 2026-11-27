import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ARCHERY_CLOSING, ARCHERY_ON_THE_WAY, ARROWS_TO_CARRY, END_PREP_AFTER_STRONGHOLD } from '../src/surfaces/minecraft/minecraftEndPrepWords.js';
import { ARROWS, BOW, END_BOW_KNOWLEDGE, PLAN_PREP_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { CURRENT_PLAN_STRUCTURE } from '../src/surfaces/minecraft/minecraftCurrentPlanPrompt.js';
import { firstPlanInput, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { endLackLine } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { flintLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { archeryHeld, packFacts, packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { arrowBudgetLine } from '../src/surfaces/minecraft/minecraftEndFacts.js';
import { madeProgress, type ProgressMark } from '../src/surfaces/minecraft/minecraftProgress.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { STRATEGY_KNOWLEDGE_V2 } from '../src/surfaces/minecraft/minecraftStrategy.js';
import { watchLine } from '../src/surfaces/minecraft/minecraftBlazeFacts.js';
import { END_WEAPONS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';

/**
 * The bow and arrows made on the way (the owner, 11/27): one direction in every sentence that reads of them, 12 arrows as the close, a short node before the stronghold, the flint and the
 * materials kept, and no sentence before the fight with the dragon that reads as if an arrow may be shot.
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '2026-11-27T10:00:00Z', receivedAt: 't', connected: true,
  facts: {}, state: { world: { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, ...world } as never } });
const stacks = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
const FORBIDDEN = /節は要らない|寄り道しない|取りに出る節|夜を待たない|書かなくてよい/u;
/** The sentences of a text that name the bow or the arrows. */
const bowSentences = (text: string): string[] => text.split(/[。\n]/u).filter(sentence => /弓|矢/u.test(sentence));

describe('the bow and arrows sentences say one thing (made on the way, kept for the dragon)', () => {
  it('keeps no "no node needed / no detour" wording in any sentence that names the bow or the arrows', () => {
    const texts: Record<string, string> = { END_BOW_KNOWLEDGE, PLAN_PREP_WORDS, CURRENT_PLAN_STRUCTURE, ARCHERY_ON_THE_WAY, ARCHERY_CLOSING,
      END_PREP_AFTER_STRONGHOLD, STRATEGY_KNOWLEDGE_V2, prepStage: V2_STAGES.prep };
    for (const [name, text] of Object.entries(texts)) for (const sentence of bowSentences(text)) expect(sentence, `${name}: ${sentence}`).not.toMatch(FORBIDDEN);
    const input = firstPlanInput('エンドラを討伐して', { dimension: 'overworld', inventory: stacks({ ender_eye: 11 }) }, { readiness: true, journeyReadiness: true, now: 0 });
    for (const sentence of bowSentences(input)) expect(sentence, sentence).not.toMatch(FORBIDDEN);
    expect(input).toContain(ARCHERY_ON_THE_WAY);
  });
  it('names the use, the place, the no-shot and the no-far-trip with the reason, in one sentence', () => {
    expect(ARCHERY_ON_THE_WAY).toContain('弓＝糸 3＋棒 3');
    expect(ARCHERY_ON_THE_WAY).toContain('火打石・棒・羽根 各 1 で 4 本');
    expect(ARCHERY_ON_THE_WAY).toContain('要塞へ向かう道中の短い節で作っておく');
    expect(ARCHERY_ON_THE_WAY).toContain('作ったら竜との戦いまで撃たない');
    expect(ARCHERY_ON_THE_WAY).toContain('村など遠い所へは往復しない');
    expect(ARCHERY_ON_THE_WAY).toContain('理由: 弓矢が無いと柱を積んで登る形になり、足場の材料が尽きて高所で竜に落とされる危険が高い');
    expect(ARCHERY_ON_THE_WAY).not.toMatch(/\d{1,2}\/\d{1,2}|実走|秒/u);
    // the inspection items keep their own sentence, the bow is a sentence of its own after it
    const [inspection, bow] = END_PREP_AFTER_STRONGHOLD.split('弓矢の節は別: ');
    expect(inspection).toContain('エンドの点検物（ベッドの 8 個目・黒曜石・足場）は、要塞の後ろでよい');
    expect(inspection).not.toMatch(/弓|矢/u);
    expect(bow).toContain(ARCHERY_ON_THE_WAY);
  });
  it('closes at 12 arrows, holds 16 when it can, and says what to do when the share is short (no reopening, nothing sought far, no arrows without a bow)', () => {
    expect(ARROWS_TO_CARRY).toBe(12);
    expect(ARROWS.count).toBe(12);
    expect(BOW.count).toBe(1);
    expect(ARCHERY_CLOSING).toContain('矢は 12 本（結晶 10＋予備 2）そろえば節を閉じる（持てれば 16 本まで持つ）');
    expect(ARCHERY_CLOSING).toContain('見えた分だけ作って次へ進み、30m 以内に見えない物は探しに行かない');
    expect(ARCHERY_CLOSING).toContain('矢が 4〜8 本でも持つ価値はある');
    expect(ARCHERY_CLOSING).toContain('そろわなくても節を閉じて要塞へ進んでよい（要塞の前に何度も開き直さない）');
    expect(ARCHERY_CLOSING).toContain('弓が無く糸も無い時は、羽根・火打石だけを集めに行かない');
    expect(ARCHERY_CLOSING).toContain('骸骨の弓が荷にあれば糸は要らない');
    expect(END_BOW_KNOWLEDGE).toContain('石のシャベル（make stone_shovel: 丸石 1＋棒 2、作業台が要る）は砂利を掘る時に体が自動で持ち替える');
    expect(END_BOW_KNOWLEDGE).toContain('羽根はニワトリを hunt chicken');
    expect(END_BOW_KNOWLEDGE).toContain('mine gravel X,Y,Z');
    expect(END_BOW_KNOWLEDGE).toContain('昼の地表で見えて道がある 1 体を剣で fight');
    expect(END_BOW_KNOWLEDGE).toContain('夜の地上と洞窟のクモは、鉄の剣と盾を持ってから');
    expect(END_WEAPONS.find(need => need.label === '矢')?.count).toBe(12);
  });
  it('the arrows seen at the End are counted against 12 everywhere (the End check, the gate, the knowledge, the strategy)', () => {
    const everything = [END_BOW_KNOWLEDGE, PLAN_PREP_WORDS, STRATEGY_KNOWLEDGE_V2, ...Object.values(V2_STAGES)].join('\n');
    expect(everything).not.toMatch(/(?:弓と矢|弓・矢|矢)\s?30|30 本残す|30 本以上/u);
  });
});

describe('the short node before the stronghold', () => {
  const nodes = seedPlan('エンドラを倒して')!.nodes;
  const bow = nodes.find(node => node.title.startsWith('弓と矢'))!;
  it('is a top-level node, closes at 12, and sits before the stronghold and after the End check', () => {
    expect(bow.parentId).toBeNull();
    expect(bow.doneWhen).toBe('have:bow&have:arrow>=12');
    const tops = nodes.filter(node => node.parentId === null).map(node => node.title);
    expect(tops.indexOf(bow.title)).toBe(tops.indexOf('ストロングホールド') - 1);
    expect(tops.indexOf('出発の点検（エンドへ）')).toBeLessThan(tops.indexOf(bow.title));
    expect(nodes.filter(node => node.parentId !== null && node.title.startsWith('弓と矢'))).toHaveLength(0);
  });
  it('says in its note and cautions: take what is seen, nothing far, no reopening, no shot before the dragon, the eight free slots, the shovel; within the limits', () => {
    expect(bow.title.length).toBeLessThanOrEqual(60);
    expect(bow.note!.length).toBeLessThanOrEqual(120);
    for (const rule of bow.caution ?? []) expect(rule.length).toBeLessThanOrEqual(80);
    expect((bow.caution ?? []).length).toBeLessThanOrEqual(4);
    const words = [bow.title, bow.note, ...(bow.caution ?? [])].join('\n');
    expect(words).toContain('先に空きを 8 マス作る');
    expect(words).toContain('見えた分だけ作って次へ進む（30m 内に見えない物は探さない）');
    expect(words).toContain('矢が 4〜8 本でも持つ価値あり');
    expect(words).toContain('そろわなくても閉じて要塞へ');
    expect(words).toContain('骸骨の弓が荷にあれば糸は不要');
    expect(words).toContain('ニワトリは hunt chicken');
    expect(words).toContain('石のシャベルは体が持ち替える');
    expect(words).toContain('弓も糸も無い時は羽根・火打石だけを集めに行かない');
    expect(words).toContain('村など遠い所へは往復しない');
    expect(words).toContain('作ったら竜との戦いまで撃たない');
    expect(words).not.toMatch(FORBIDDEN);
  });
});

describe('the End check and the shortage lines', () => {
  const world = { worn: '頭: iron_helmet(残り133/165)', inventory: stacks({ white_bed: 6, obsidian: 7, flint: 2, ender_eye: 11 }) };
  it('the lack line says the bow and arrows are made on the way and that no far trip is made', () => {
    const line = endLackLine(readinessOf(frame(world))!, ['stronghold'])!;
    expect(line).toContain('弓なし（作るなら糸 0/3・棒 0/3。弓矢は道中の短い節で作る物で、遠い所へは往復しない）');
    expect(line).toContain('矢 0/12（羽根 0・火打石 2・棒 0）');
    expect(line).toContain('弓矢は別で、要塞の前の道中の短い節で作る（遠い所へは往復しない）');
    expect(line).toContain('点検物（ベッド・黒曜石・足場）は要塞の後ろでよい');
    for (const sentence of bowSentences(line)) expect(sentence, sentence).not.toMatch(/取りに出る|寄り道|探しに行/u);
  });
});

describe('the flint the arrows lack', () => {
  it('is said in the overworld whatever the plan is at, while the bow or the arrows fall short and the flint is under the arrows\' share', () => {
    const line = flintLine(frame({ inventory: stacks({ flint: 1, bow: 1, arrow: 2, stick: 2 }) }), ['wood'])!;
    expect(line).toContain('火打石 1。砂利は掘ると 10% で火打石。矢の火打石あと 2');
    expect(line).toContain('矢の火打石あと 2（弓矢の節の分で、今の節は止めない。今 1・矢 2/12）');
    const noBow = flintLine(frame({ inventory: stacks({ stick: 2 }) }), undefined)!;
    expect(noBow).toContain('矢の火打石あと 3');
  });
  it('is not said once the share is there, with a bow and 12 arrows, in the Nether, or when nothing says the dimension', () => {
    expect(flintLine(frame({ inventory: stacks({ flint: 3 }) }), ['wood'])).toBeNull();
    expect(flintLine(frame({ inventory: stacks({ flint: 0, bow: 1, arrow: 12 }) }), ['wood'])).toBeNull();
    expect(flintLine(frame({ dimension: 'the_nether', inventory: stacks({}) }), ['wood'])).toBeNull();
    expect(flintLine(frame({ dimension: undefined, inventory: stacks({}) }), ['stone_tools'])).toBeNull();
  });
  it('keeps the old wording at the obsidian with no flint and no arrows lacking (a bow with 12 arrows)', () => {
    expect(flintLine(frame({ inventory: stacks({ bow: 1, arrow: 12 }) }), ['obsidian'])).toContain('火打石 0。砂利は掘ると 10% で火打石（10 個で約 35 秒）。片付けは砂利を 10 個まで残す。通り道の砂利を先に掘る');
  });
});

describe('the pack keeps the bow\'s materials', () => {
  it('keeps gravel as no spare while the flint for the arrows is short, even with the flint and steel made', () => {
    const made = ['flint_and_steel×1', 'gravel×40', 'dirt×200', 'flint×2'];
    expect(packFacts(made).filler.map(([name]) => name)).not.toContain('gravel');
    expect(packFacts([...made.filter(line => line !== 'flint×2'), 'flint×3']).filler.map(([name]) => name)).toContain('gravel');
    expect(packFacts([...made, 'bow×1', 'arrow×12']).filler.map(([name]) => name)).toContain('gravel');
    // before the flint and steel is made, gravel is kept as it was
    expect(packFacts(['gravel×40', 'flint×3']).filler.map(([name]) => name)).not.toContain('gravel');
  });
  it('holds back what the bow takes (not more than carried) once a bow, arrows, feather or string is carried or the node is the plan\'s now', () => {
    const carried = new Map([['flint', 2], ['stick', 9], ['feather', 5], ['string', 1], ['arrow', 2], ['bow', 1]]);
    expect([...archeryHeld(carried)]).toEqual([['flint', 2], ['feather', 3], ['string', 1], ['stick', 3], ['bow', 1], ['arrow', 2]]);
    expect(archeryHeld(new Map([['flint', 2], ['stick', 4]])).size).toBe(0);
    expect([...archeryHeld(new Map([['flint', 2], ['stick', 4]]), 'have:bow&have:arrow>=12')]).toEqual([['flint', 2], ['stick', 3]]);
  });
  it('says in the tidy words that the materials are not thrown, why, and what makes the room first', () => {
    const lines = ['dirt×300', 'oak_leaves×70', 'cobblestone×200', 'flint×2', 'feather×2', 'stick×2'];
    const out = packLines(lines, { free: 1, archery: true, held: item => (['flint', 'feather', 'stick'].includes(item) ? 2 : 0), keepWords: 'flint:2,feather:2,stick:2' }).join('\n');
    expect(out).toContain('弓矢の材料（flint・feather・string・stick・bow・arrow）は捨てない');
    expect(out).toContain('作り直すにはクモ・ニワトリ・砂利を探し直すことになり');
    expect(out).toContain('火打石が矢の分に満たない間は gravel も捨てない');
    expect(out).toContain('空きは dirt・leaves など山のある物から先に作る');
    expect(packLines(lines, { free: 1 }).join('\n')).not.toContain('弓矢の材料');
  });
});

describe('the arrows against the crystals, one line at the End', () => {
  const end = (remaining: number, caged: number) => ({ feet: null, dragon: null, crystals: { remaining, gone: 10 - remaining, caged, unseen: null, visible: null, list: [] }, breath: [], fireballs: 0 }) as never;
  it('says the uncaged crystals, the arrows, one shot each, and the climb for the share the arrows do not cover', () => {
    expect(arrowBudgetLine(end(10, 2), 5)).toBe('檻なしの結晶 8 本・矢 5 本（1 本 1 発で壊れる）。矢が 3 本足りない分は柱を登る形になる');
    expect(arrowBudgetLine(end(10, 2), 12)).toBe('檻なしの結晶 8 本・矢 12 本（1 本 1 発で壊れる）。矢は結晶の数に足りている');
    expect(arrowBudgetLine(end(10, 2), 0)).toContain('矢 0 本');
  });
  it('is null when nothing is counted or no uncaged crystal is left', () => {
    expect(arrowBudgetLine(null, 5)).toBeNull();
    expect(arrowBudgetLine(end(10, 2), null)).toBeNull();
    expect(arrowBudgetLine(end(2, 2), 5)).toBeNull();
  });
});

describe('the sentences that read as if an arrow may be shot before the dragon', () => {
  it('say not to shoot the blaze, the skeleton, the spider, the enderman or the hoglin, and agree with the blaze watch', () => {
    expect(V2_STAGES.blaze).toContain('弓と矢: ブレイズには使わない。竜との戦い（エンドのクリスタルと竜）まで撃たない（骸骨・クモ・エンダーマン・ホグリンなどにも使わず、剣で戦う）');
    expect(V2_STAGES.blaze).toContain('shoot の手は、竜との戦いの前には出さない');
    expect(V2_STAGES.blaze).not.toMatch(/6 体だけ（実測|shoot で倒した|を超える分だけ、剣の届かない/u);
    expect(watchLine(3, 10_000, 0, 0, 12)).toContain('矢 12 本は竜との戦いまで撃たない（クリスタルとドラゴン用に 12 本。ブレイズにも使わず剣で戦う）');
    expect(V2_STAGES.prep).toContain('弓で撃ち返さない（矢はエンド用）');
  });
  it('keeps the End\'s own shooting at the crystals (that is the dragon fight)', () => {
    expect(V2_STAGES.end).toContain('クリスタル: shoot target="#id"');
  });
});

describe('a call that failed after getting the bow\'s materials (the progress count)', () => {
  const mark = (items: Record<string, number>): ProgressMark => ({ counts: new Map(Object.entries(items)), shown: new Set(), at: { x: 0, y: 64, z: 0 }, sequence: 1 });
  it('counts a feather and a flint as progress, and string only with others: the failed-step tally is not what stops a node, so WASTE is left as it was', () => {
    expect(madeProgress(mark({}), mark({ feather: 1 }))).toBe('feather+1');
    expect(madeProgress(mark({}), mark({ flint: 1 }))).toBe('flint+1');
    expect(madeProgress(mark({}), mark({ string: 2 }))).toBeNull();
    expect(madeProgress(mark({}), mark({ string: 2, feather: 1 }))).toBe('feather+1');
  });
});
