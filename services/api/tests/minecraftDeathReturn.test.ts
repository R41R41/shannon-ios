import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { doneFacts } from '../src/surfaces/minecraft/minecraftConditions.js';
import { deathAway, deathReturnLine, givenUpBy, SHOWN_MINUTES } from '../src/surfaces/minecraft/minecraftDeathReturn.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { factsContext, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';

/**
 * 11/15c c1: burned at the blaze spawner (149,74,75) at 417 s with 5 rods, woke in the overworld 31 m from the gate (138,79,102), and never went
 * back (d0094, an urgent decision: 「the portal location unknown」; d0137: 「decay about 5 minutes after death」).
 */
const frame = (world: Record<string, unknown>): BodyObservation => ({ connected: true, state: { world }, facts: {}, bodyId: 'b', sequence: 1,
  stateAt: new Date(0).toISOString() }) as unknown as BodyObservation;
const c1 = (over: Record<string, unknown> = {}) => ({
  dimension: 'overworld', position: { x: 133, y: 73, z: 71 }, health: 20, food: 20, inventory: [{ name: 'apple', count: 2 }],
  lastDeath: '3分前 the_nether (149,74,75)「I_am_Shannon was burned to a crisp while fighting Blaze」 落とした物: blaze_rod×5, iron_sword×1, '
    + 'diamond_pickaxe×1, cooked_beef×6 ほか3種。消えるまで最長約4分（近くにいる間だけ減る）→拾いに戻れる',
  deaths: [{ at: '2026-11-15T08:41:27Z', dimension: 'the_nether', position: { x: 149, y: 74, z: 75 }, cause: 'burned to a crisp while fighting Blaze',
    lostItems: ['blaze_rod×5', 'iron_sword×1', 'diamond_pickaxe×1', 'cooked_beef×6', 'ほか3種'] }],
  rememberedPlaces: { nether_portal: '31m 南 (138,79,102) ↔nether(17,70,12)' }, ...over });
const line = (world: Record<string, unknown>, givenUp: string | null = null) => deathReturnLine(world, doneFacts(frame(world))!, givenUp);

describe('the way back to the drops of a death in another dimension (11/15c c1, w1109r)', () => {
  it('says where the drops are and what, the lifetime as a condition, the gate and its other end, what the road lacks, and her state, in one block', () => {
    const said = line(c1())!;
    expect(said).toContain('別の次元の落とし物（3 分前に死んだ所）: the_nether (149,74,75) に blaze_rod×5・iron_sword×1・diamond_pickaxe×1・cooked_beef×6・ほか3種。消えるまで残り最長約 4 分');
    expect(said).toContain('落とし物の所のチャンクが読み込まれている間（同じ次元で約 160m 以内にいる間）だけ減る。今は別の次元にいて、そこが読み込まれていなければ減らない');
    expect(said).not.toMatch(/必ず残る|消えない/u);
    // 31 m at 2.5 m/s; the other end (17,70,12) to the drops (149,74,75): 146 m at the Nether's 1.2 blocks a second
    expect(said).toContain('帰り道: ゲート 31m (138,79,102)（歩いて約 12 秒）→ 向こう側 (17,70,12) から落とし物まで 146m（約 122 秒）');
    expect(said).toContain('区間の目標まで: ロッド 今 0/7（落とし物に 5）・パール・アイ 今 0/13。落とし物の分を集め直すと約 210 秒');
    expect(said).toContain('今: 体力 20・満腹 20・食べ物 13 点');
    expect(said).toContain('体は勝手に戻らない）。捨てるなら act の why に「落とし物は捨てる」と書く');
    expect(said.length).toBeLessThan(560);
  });

  it('says what it knows when the gate is not remembered, or its other end is not', () => {
    expect(line(c1({ rememberedPlaces: {} }))).toContain('帰り道: この次元のゲートは体の控えに無い（ゲートを見つけるか組む）');
    expect(line(c1({ rememberedPlaces: { nether_portal: '1056m 西 (-300,70,-340)' } }))).toContain('帰り道: ゲート 1056m (-300,70,-340)（歩いて約 422 秒）。向こう側の場所は控えに無い');
  });

  it('says nothing in the dimension of the death, past its time, for drops gone or burnt, nor once she gave them up', () => {
    expect(line(c1({ dimension: 'the_nether' }))).toBeNull();
    expect(line(c1({ lastDeath: `${SHOWN_MINUTES + 1}分前 the_nether (149,74,75)「x」 落とした物: blaze_rod×5。消えるまで最長約4分（近くにいる間だけ減る）→拾いに戻れる` }))).toBeNull();
    expect(line(c1({ lastDeath: '3分前 the_nether (149,74,75)「x」 落とした物（blaze_rod×5）は消えた見込み' }))).toBeNull();
    expect(line(c1({ lastDeath: '3分前 the_nether (149,74,75)「I_am_Shannon tried to swim in lava」 落とした物: blaze_rod×5。消えるまで最長約5分→拾いに戻れる' }))).toBeNull();
    const key = deathAway(c1(), 'overworld')!.key;
    expect(key).toBe('nether:149,74,75');
    expect(givenUpBy('[p2] 落とし物は捨てる。村で木の剣から作り直す', c1(), 'overworld')).toBe(key);
    expect(givenUpBy('村で木の剣から作り直す', c1(), 'overworld')).toBeNull();
    expect(line(c1(), key)).toBeNull();
    // a later death is another key: its block comes again
    expect(line(c1({ lastDeath: '1分前 the_nether (150,74,75)「x」 落とした物: blaze_rod×2。消えるまで最長約5分（近くにいる間だけ減る）→拾いに戻れる' }), key)).not.toBeNull();
  });

  it('keeps the block for a why that denies the giving up (the review of 11/15c), and ends it for one that gives up', () => {
    for (const why of ['落とし物は捨てずに取りに戻る', '落とし物を諦めない。ゲートへ', '落とし物は捨てない', '落とし物は捨てるか戻るか比べて、戻る',
      '落とし物を拾わないと鉄の剣が無い', '落とし物を諦めずに拾う', '落とし物は捨てたくない']) expect(givenUpBy(why, c1(), 'overworld')).toBeNull();
    for (const why of ['落とし物は捨てる', '落とし物を諦めて村で作り直す', '落とし物は拾わない', '落とし物は取りに戻らない。干し草へ', '落とし物を放棄する'])
      expect(givenUpBy(why, c1(), 'overworld')).toBe('nether:149,74,75');
  });

  it('says what the road lacks only while the rods and pearls are gathered: eyes made count, and not in the End nor with the frames found', () => {
    // 12 eyes made, the rods used up: 6 rods' worth (an eye is half a rod), 12 of 13
    const eyes = c1({ inventory: [{ name: 'ender_eye', count: 12 }] });
    expect(line(eyes)).toContain('区間の目標まで: ロッド 今 6/7（落とし物に 5）・パール・アイ 今 12/13');
    expect(line(c1({ inventory: [{ name: 'ender_eye', count: 13 }] }))).not.toContain('区間の目標まで');
    // the frames remembered: the frame line counts the eyes exactly
    const found = line(c1({ rememberedPlaces: { nether_portal: '31m 南 (138,79,102) ↔nether(17,70,12)', end_portal_frame: '40m 東 (300,20,80)' } }))!;
    expect(found).toContain('帰り道: ゲート 31m (138,79,102)');
    expect(found).not.toContain('区間の目標まで');
    // a death in the End (beds and arrows), woken in the overworld: the way back and her state, no rods nor pearls
    const end = line(c1({ lastDeath: '2分前 the_end (10,60,0)「I_am_Shannon was slain by Ender Dragon」 落とした物: white_bed×4, arrow×20。消えるまで最長約5分（近くにいる間だけ減る）→拾いに戻れる',
      deaths: [{ dimension: 'the_end', position: { x: 10, y: 60, z: 0 }, cause: 'slain by Ender Dragon', lostItems: ['white_bed×4', 'arrow×20'] }] }))!;
    expect(end).toContain('別の次元の落とし物（2 分前に死んだ所）: the_end (10,60,0) に white_bed×4・arrow×20');
    expect(end).toContain('帰り道: この次元のゲートは体の控えに無い（エンドポータルの枠を探す）');
    expect(end).toContain('今: 体力 20');
    expect(end).not.toContain('区間の目標まで');
  });

  it('is in the urgent version too (the 控え line is not), and an act that gives the drops up ends it for the task', () => {
    const endgame = createEndgame(null);
    const parts: LlmcBodyParts = { plan: () => undefined, planView: () => null, planTree: () => seedPlan('エンドラを討伐して')!, endgame };
    const now = frame(c1());
    const urgent = inputFacts(now, factsContext(parts, now, {}, undefined, {}), true).lines.join('\n');
    expect(urgent).toContain('帰り道: ゲート 31m (138,79,102)');
    expect(urgent).not.toContain('最後の死:');
    endgame.noteWhy('落とし物は捨てる。干し草でパンを作る', now);
    expect(endgame.checkpoint()).toMatchObject({ minecraftDropsGivenUp: 'nether:149,74,75' });
    expect(inputFacts(now, factsContext(parts, now, {}, undefined, {}), false).lines.join('\n')).toContain('最後の死: 3分前 the_nether');
    const later = createEndgame(JSON.parse(JSON.stringify(endgame.checkpoint())));
    expect(later.lines(now, true).lines.join('\n')).not.toContain('別の次元の落とし物');
  });
});
