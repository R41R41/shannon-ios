import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ACT_CONTRACT_VERSION } from '../src/contracts/minecraftActContract.js';
import { beforeStronghold, preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { endLackLine, planNowOrdered } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { firstPlanInput } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { CURRENT_PLAN_STRUCTURE } from '../src/surfaces/minecraft/minecraftCurrentPlanPrompt.js';
import { END_PREP_AFTER_STRONGHOLD } from '../src/surfaces/minecraft/minecraftEndPrepWords.js';
import { meterLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { dayBedLine } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { forgetSleepHolds, noteSleepResult, sleepFirstHold, sleepStateLine } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';
import { V2_ALWAYS, V2_STAGES, stageKnowledge } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * Run 9 (11/27): the End's shortage read as what to do now (70 hands of the End's preparation, 0 of the stronghold). The heading says where the check goes while the stronghold is
 * ahead; the sleep paragraph goes after the node; the meter and the day line do not talk of the Nether with eyes in the pack; a slept night is said as slept.
 */
const THROWS = [
  { dim: 'overworld', x: 0, z: 0, yawDeg: 0, flewM: 12, atMs: 1, broke: false },
  { dim: 'overworld', x: 300, z: 0, yawDeg: 348.7, flewM: 12, atMs: 2, broke: false },
];
const FRAMES = ['Q エンドポータルの枠 (216,39,-14) 北3m ×12 アイ入り 0'];
const counts = (eyes: number) => new Map<string, number>([['white_bed', 7], ['obsidian', 7], ['cobblestone', 42], ['ender_eye', eyes], ['water_bucket', 1], ['iron_sword', 1]]);
const shortage = (eyes: number, kinds: unknown, world: Record<string, unknown> = {}) =>
  preparationShortage({ dimension: 'overworld', counts: counts(eyes), food: 500, nowKinds: kinds as never, worn: [], world });

describe('the End shortage heading before the stronghold', () => {
  it('says where the check goes when the current node is the stronghold, and keeps the numbers', () => {
    const line = shortage(11, ['stronghold'])!;
    expect(line).toContain(`準備の不足（エンドへ入る前に要る物（${END_PREP_AFTER_STRONGHOLD}））`);
    expect(line).toContain('ベッド（エンドの点検は 8・戦いの目標は 10） 7/8（あと 1）');
    expect(line).toContain('取りに出る節は要らない');
  });
  it('says it with 10 or more eyes and a point from two throws, whatever the current node is', () => {
    expect(shortage(11, ['food'], { eyeThrows: THROWS })).toContain(END_PREP_AFTER_STRONGHOLD);
    expect(beforeStronghold({ eyeThrows: THROWS }, counts(11), ['iron'] as never)).toBe(true);
  });
  it('does not say it with no point yet, with fewer than 10 eyes, or once the frames are in view', () => {
    expect(shortage(11, ['food'])).not.toContain(END_PREP_AFTER_STRONGHOLD);
    expect(shortage(9, ['food'], { eyeThrows: THROWS })).not.toContain(END_PREP_AFTER_STRONGHOLD);
    expect(shortage(11, ['stronghold'], { mapLandmarks: FRAMES })!.startsWith('準備の不足（エンドへ入る前に要る物）: ')).toBe(true);
    expect(shortage(11, ['food'], { eyeThrows: THROWS, mapLandmarks: FRAMES })).not.toContain(END_PREP_AFTER_STRONGHOLD);
  });
  it('leaves the early game and other stages as they were (no eyes: the stage is the node\'s own)', () => {
    const early = preparationShortage({ dimension: 'overworld', counts: new Map([['iron_pickaxe', 1]]), food: 50, nowKinds: ['portal'] as never, worn: [] })!;
    expect(early).not.toContain(END_PREP_AFTER_STRONGHOLD);
    expect(preparationShortage({ dimension: 'overworld', counts: new Map(), food: 5, nowKinds: ['wood'] as never, worn: [] }) ?? '').not.toContain(END_PREP_AFTER_STRONGHOLD);
  });
  it('puts the same words beside the lack line', () => {
    const facts = { dimension: 'overworld', counts: counts(11), world: { eyeThrows: THROWS }, food: 500 } as never;
    expect(endLackLine(facts, ['stronghold'] as never)).toContain('点検物（ベッド・黒曜石・足場）は要塞の後ろでよい。取りに出る節は要らない。弓矢は別で、要塞の前の道中の短い節で作る（遠い所へは往復しない）。身を守る物（防具の欠け・食料・掘る道具）は、近くの材料で作れる分だけ発つ前に作ってよい');
    expect(endLackLine(facts, ['stronghold'] as never)).toContain('ベッド 7/8（あと 1）');
    expect(endLackLine({ ...(facts as object), world: { mapLandmarks: FRAMES } } as never, ['stronghold'] as never)).not.toContain('要塞の後ろでよい');
  });
  it('says armour, food and digging tools lacking may be made before leaving, only from near material, and the End items go behind with no trip for one bed', () => {
    const line = shortage(11, ['stronghold'])!;
    expect(END_PREP_AFTER_STRONGHOLD).toContain('身を守る物の欠け（防具の部位・食料・掘る道具）は別で、要塞へ発つ前に作ってよい');
    expect(END_PREP_AFTER_STRONGHOLD).toContain('30m 以内');
    expect(END_PREP_AFTER_STRONGHOLD).toContain('遠いかまどへ通わない');
    expect(END_PREP_AFTER_STRONGHOLD).toContain('遠くへ掘りに行く節は作らない');
    expect(line).toContain('ベッド 1 個のために村へ往復しない');
    expect(line).toContain('ベッド（エンドの点検は 8・戦いの目標は 10） 7/8（あと 1）');
  });
  it('shows no armour permission with no eyes (a new world), a cake or a house: the sentence is only for the stronghold-first case', () => {
    for (const kinds of [['food'], ['cake'], ['house'], ['wood']]) {
      expect(preparationShortage({ dimension: 'overworld', counts: new Map(), food: 5, nowKinds: kinds as never, worn: [] }) ?? '').not.toContain('発つ前に作ってよい');
    }
    expect(endLackLine({ dimension: 'overworld', counts: new Map(), world: {}, food: 5 } as never, ['food'] as never) ?? '').not.toContain('発つ前に作ってよい');
  });
});

describe('the plan words: armour before the walk, the End items behind', () => {
  const pack = [{ name: 'ender_eye', count: 11 }, { name: 'iron_ingot', count: 6 }];
  it('writes the short departure node for armour, and the End items behind, in the first plan input and the plan system', () => {
    const text = firstPlanInput('エンドラを討伐して', { dimension: 'overworld', inventory: pack, worn: '頭: iron_helmet、胴: iron_chestplate、脚: なし、足: なし' }, { readiness: true, journeyReadiness: true, now: 0 });
    expect(text).toContain('要塞の前の短い節（出発の準備）にしてよい');
    expect(text).toContain('30m 以内');
    expect(text).toContain('エンドの点検物は要塞の後ろの節');
    expect(CURRENT_PLAN_STRUCTURE).toContain('要塞の前の短い節（出発の準備）にしてよい');
    expect(CURRENT_PLAN_STRUCTURE).toContain('ベッド 1 個のために村へ往復しない');
  });
  it('does not write it with no eyes (a new world) or for a cake or a house', () => {
    for (const goal of ['エンドラを討伐して', 'ケーキを作って', '家を建てて']) {
      expect(firstPlanInput(goal, { dimension: 'overworld', inventory: [] }, {})).not.toContain('出発の準備');
    }
  });
});

describe('planNow: the node first, the sleep paragraph after', () => {
  const NODE = '[p1.1] 要塞の場所を絞る';
  it('puts the sleep and bed paragraph after the node, the furnace and food steps before it', () => {
    const line = planNowOrdered(NODE, 'かまどの間の手', '夜の睡眠: 寝る予定', '食料が先', false);
    expect(line.indexOf('かまどの間の手')).toBeLessThan(line.indexOf(NODE));
    expect(line.indexOf('食料が先')).toBeLessThan(line.indexOf(NODE));
    expect(line.indexOf(NODE)).toBeLessThan(line.indexOf('夜の睡眠'));
  });
  it('keeps the night\'s own choice first, and the node alone when nothing else is said', () => {
    const choice = planNowOrdered(NODE, null, '夜の選び', null, true);
    expect(choice.indexOf('夜の選び')).toBeLessThan(choice.indexOf(NODE));
    expect(planNowOrdered(NODE, null, null, null, false)).toBe(NODE);
  });
  it('the day\'s sleep paragraph is shorter and says the rule once', () => {
    const world = { timeOfDay: 4000 };
    const full = dayBedLine(world, new Map([['white_bed', 8]]), 'overworld', false, false)!;
    expect(full.length).toBeLessThan(560);
    expect(full.split('先頭か末尾に').length).toBe(2);
    expect(full).toContain('sleep on=false');
    expect(full.split('sleep だけの手').length).toBe(2);
  });
});

describe('the meter and the day line with eyes in the pack', () => {
  const frame = (world: object): BodyObservation => ({ connected: true, state: { world }, facts: {}, bodyId: 'b', sequence: 1, stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
  const items = (record: Record<string, number>) => Object.entries(record).map(([name, count]) => ({ name, count }));
  const tree = seedPlan('エンドラを討伐して', 'overworld')!;
  it('points at the eyes, not at the obsidian of the Nether, while an eye is carried in the overworld', () => {
    const withEyes = meterLine(tree, frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: items({ ender_eye: 11 }) }), 10)!;
    expect(withEyes).toContain('次の節目 エンダーアイ 13 個');
    expect(withEyes).not.toContain('黒曜石 10 個');
    const none = meterLine(tree, frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, inventory: items({}) }), 10)!;
    expect(none).not.toContain('エンダーアイ 13 個');
  });
  it('says the Nether share only when the caller says the Nether is the goal (no eyes)', () => {
    const world = { timeOfDay: 4000 };
    expect(dayBedLine(world, new Map([['white_bed', 8]]), 'overworld', false, true)).toContain('ネザーまで');
    expect(dayBedLine(world, new Map([['white_bed', 8]]), 'overworld', false, false)).not.toContain('ネザーまで');
  });
});

describe('the night\'s sleep said as slept', () => {
  const pack = [{ name: 'white_bed', count: 1 }];
  const frame = (time: string): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
    state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, time, inventory: pack, worn: '' } as never } as never });
  const result = (hand: string, goal: string) => JSON.stringify({ v: ACT_CONTRACT_VERSION, lines: [{ i: 0, do: hand, status: goal === 'done' ? 'done' : 'failed', goal, end: 'finished' }], done: 1, of: 1 });
  const BOOKING = { why: 'night', hands: [{ do: 'sleep' }] };
  let clock = 1_000_000;
  const now = () => clock;
  const book = () => { clock = 1_000_000; sleepFirstHold(BOOKING, frame('6000'), 't', now); };
  beforeEach(() => forgetSleepHolds());

  it('a sleep hand done, then the clock from day to morning: said as slept, with the next night', () => {
    book();
    noteSleepResult('t', result('sleep', 'done'), frame('6000'), clock);
    clock += 30_000;
    expect(sleepStateLine(frame('11000'), 't', null, now)).toContain('予約が残っているかもしれない');
    clock += 60_000;
    const line = sleepStateLine(frame('2000'), 't', null, now)!;
    expect(line).toContain('寝た（sleep の手が完了）');
    expect(line).toContain('今は朝');
    expect(line).toContain('予約は済んだ');
    expect(line).toContain('次の夜は');
    expect(line).not.toContain('分前に sleep の手を送った');
  });
  it('a sleep hand that did not finish: the booking line stays', () => {
    book();
    noteSleepResult('t', result('sleep', 'failed'), frame('6000'), clock);
    clock += 30_000;
    sleepStateLine(frame('11000'), 't', null, now);
    clock += 60_000;
    expect(sleepStateLine(frame('2000'), 't', null, now)).toContain('予約が残っているかもしれない');
  });
  it('another hand done and the clock jumped: the booking line stays (no sleep hand came back)', () => {
    book();
    noteSleepResult('t', result('go', 'done'), frame('6000'), clock);
    clock += 30_000;
    sleepStateLine(frame('11000'), 't', null, now);
    clock += 60_000;
    expect(sleepStateLine(frame('2000'), 't', null, now)).toContain('予約が残っているかもしれない');
  });
  it('a sleep hand done and no jump of the clock: the booking line stays', () => {
    book();
    noteSleepResult('t', result('sleep', 'done'), frame('6000'), clock);
    clock += 30_000;
    sleepStateLine(frame('11000'), 't', null, now);
    clock += 60_000;
    const line = sleepStateLine(frame('11400'), 't', null, now)!;
    expect(line).toContain('予約が残っているかもしれない');
    expect(line).not.toContain('寝た（');
  });
});

describe('the knowledge: the new words reach nothing before the stronghold', () => {
  it('says the stronghold first in a line that names the stronghold, with its reason', () => {
    const line = V2_ALWAYS.split('\n').find(row => row.includes('今の節が要塞（stronghold）の間は'))!;
    expect(line).toContain('同じ道の途中にある・危険や夜の囲い・今の節が止まっている');
    expect(line).toContain('why に書く');
    expect(line).toContain('理由:');
    expect(V2_ALWAYS).toContain('今の節が stronghold の間は奥への移動に数えない');
    expect(V2_ALWAYS).toContain('the End check may wait until behind the stronghold');
  });
  it('keeps the system\'s order of rules and the old lines it must not collide with', () => {
    expect(V2_ALWAYS).toContain('avoid imminent danger → meet the preparation requirements');
    expect(V2_ALWAYS).toContain('Fill a shortage before fights or moving deeper');
    expect(V2_ALWAYS).toContain('Do not skip a section against a note you wrote yourself');
  });
  it('writes the swim speed as measured and the re-throw spacing, once, in the stronghold stage', () => {
    const text = V2_STAGES.stronghold;
    expect(text).not.toContain('実測で約 3 m/s');
    expect(text).toContain('海は 0.5〜1 m/s（7 回目の実測）');
    expect(text).toContain('交点の 300〜500m 手前ごとに 1 本投げ直して絞る');
    expect(text).not.toContain('交点の 100m 手前で');
    expect(text.split('もう投げない').length).toBe(2);
  });
  it('says the morning rule does not apply when the stronghold is the current node', () => {
    expect(V2_STAGES.prep).toContain('要塞が今の節なら適用しない');
    expect(V2_STAGES.prep).toContain('遠出も朝にしない');
  });
  it('the stage text of an early scene has none of the new stronghold words (no stronghold stage)', () => {
    const early = stageKnowledge({ body: { state: { dimension: 'overworld' } } } as never) ?? '';
    expect(early).not.toContain('300〜500m');
    expect(early).not.toContain('海は 0.5〜1 m/s');
  });
});
