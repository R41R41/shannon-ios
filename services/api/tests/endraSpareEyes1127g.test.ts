import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { endLackLine } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { preparationShortage, readinessOf } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { eyeBasisOf, eyeSpare, EYES_AT_DEPARTURE, FRAME_EYES, thrownOf } from '../src/surfaces/minecraft/minecraftEyeSpare.js';
import { huntLine } from '../src/surfaces/minecraft/minecraftEnderHunt.js';
import { pearlDayLine } from '../src/surfaces/minecraft/minecraftNightPearl.js';
import { firstPlanInput, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { PEARL_TARGET, EYES_TO_LEAVE } from '../src/surfaces/minecraft/minecraftPearlFacts.js';

/**
 * The spare eyes (the owner's line of 11/27: one more pearl should have been taken). Before the frames are found, the eyes to hold are the frames' 12 plus the mean of the breaks of the
 * throws still to come (a fifth of each, at least 1); once the frames are found no eye is thrown and the need is the empty frames' number. One measure for the shortage's eye fact, the
 * End's check line, the Nether's pearl line, the hunt's line and the plan's nodes.
 */
const THROWS = [
  { dim: 'overworld', x: 197, z: -245, yawDeg: 171.2, flewM: 12, broke: true, atMs: 1_000 },
  { dim: 'overworld', x: 176, z: -241, yawDeg: 170.5, flewM: 12, broke: true, atMs: 2_000 },
  { dim: 'overworld', x: 438, z: 1312, yawDeg: 171.2, flewM: 12, broke: false, atMs: 3_000 },
];
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: '2026-11-27T01:43:54Z', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 440, y: 84, z: 1325 }, health: 20, food: 20, ...world } as never } });
const pack = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
const counts = (items: Record<string, number>) => new Map(Object.entries(items));
const SEEN = ['Q エンドポータルの枠 (505,31,1603) 南155m ×12 アイ入り 1'];

describe('the spare, from the throws to come', () => {
  it('is the mean of the breaks (a fifth of each of the throws still to come, rounded up, never under 1)', () => {
    expect(eyeSpare(0)).toBe(2);
    for (const thrown of [1, 2, 3, 4, 5, 6, 9]) expect(eyeSpare(thrown), `thrown ${thrown}`).toBe(1);
    expect(EYES_AT_DEPARTURE).toBe(FRAME_EYES + 2);
  });
  it('is the one number the Nether\'s pearl stage and the plan\'s nodes aim at', () => {
    expect(PEARL_TARGET).toBe(14);
    expect(EYES_TO_LEAVE).toBe(14);
    const seed = seedPlan('エンドラを討伐して', 'the_nether')!;
    const rods = seed.nodes.find(node => node.title === 'ブレイズロッド7以上')!, pearls = seed.nodes.find(node => node.title === `エンダーパール${EYES_AT_DEPARTURE}以上`)!;
    const eyes = seed.nodes.find(node => node.title === `エンダーアイ${EYES_AT_DEPARTURE}個`)!;
    expect(pearls.target).toEqual({ item: 'ender_pearl', count: 14 });
    expect(eyes.target).toEqual({ item: 'ender_eye', count: 14 });
    // the rods stay 7: a rod makes 2 powder and an eye takes 1 powder, so 7 rods are the 14 powder of 14 eyes (no rod is asked beyond what the eyes use)
    expect(rods.target).toEqual({ item: 'blaze_rod', count: 7 });
    expect((rods.target!.count * 2) >= eyes.target!.count).toBe(true);
  });
});

describe('before the frames are found: 12 plus the spare, one measure', () => {
  // a run\'s walk to the stronghold: 11 eyes, a powder, no pearl, three throws on the body\'s record (two broke), the crossing ahead
  const world = { inventory: pack({ ender_eye: 11, blaze_powder: 1 }), eyeThrows: THROWS };
  it('counts the throws made and says 11/13 with the reason, where it said 11/12 and a chance of opening', () => {
    expect(thrownOf(world)).toBe(3);
    const basis = eyeBasisOf(world);
    expect(basis).toMatchObject({ kind: 'search', need: 13, spare: 1, thrown: 3 });
    const said = preparationShortage({ dimension: 'overworld', food: 330, nowKinds: ['stronghold'], counts: counts({ ender_eye: 11, blaze_powder: 1 }), world, journeyReadiness: true })!;
    expect(said).toContain('エンダーアイ 11/13（枠 12＋予備 1。');
    expect(said).toContain('これから投げる約 3 本が 5 回に 1 回割れる分（最低 1）');
    expect(said).toContain('空き枠に 1 個足りず、要塞の前でパール待ちになる');
    expect(said).toContain('あと 2 個。パールはエンダーマンを倒した時・交換で手に入る時に、予備の分まで取る');
    expect(said).not.toContain('開く確率');
    expect(said).not.toContain('12 まであと');
  });
  it('is the same measure in the End\'s check line (11/13), not 11/12 with another list of the make-up', () => {
    const line = endLackLine(readinessOf(frame(world))!, ['stronghold'])!;
    expect(line).toContain('アイ 11/13（枠 12＋予備 1。足せる材料: パール 0・粉 1・ロッド 0）');
    expect(line).not.toContain('割れた分の作り足し');
  });
  it('with no throw made yet the number is 14 (what the Nether leaves with)', () => {
    const fresh = { inventory: pack({ ender_eye: 13 }) };
    expect(eyeBasisOf(fresh)).toMatchObject({ need: 14, spare: 2, ahead: 6 });
    expect(endLackLine(readinessOf(frame(fresh))!, ['stronghold'])).toContain('アイ 13/14（枠 12＋予備 2');
  });
  it('says nothing more at the number (14 with none thrown, 13 after a throw), and the pearl day line names the two numbers: the 10 that go, the number to hold', () => {
    expect(endLackLine(readinessOf(frame({ inventory: pack({ ender_eye: 13 }), eyeThrows: THROWS }))!, ['stronghold'])).not.toContain('アイ');
    const day = pearlDayLine({ time: '1000', ...world }, counts({ ender_eye: 8 }), 'overworld', true, null)!;
    // the floor is the number to hold (13 after throws), not the 10 that go: 8 eyes are 5 short
    expect(day).toContain('パールはあと 5 個足りない');
    expect(day).toContain('要塞へ向かえるのは 10 個から。道中で投げて割れる分の予備を足した 13 個まで、手に入る時に取る');
  });
  it('the hunt line counts toward the same number in the overworld, the pearl target in the Nether', () => {
    const base = { near: 2, nearest: 9, elapsedMs: 600_000, kills: 0, gained: 0 };
    expect(huntLine({ ...base, have: 11, target: 13 })).toContain('（11/13）');
    expect(huntLine({ ...base, have: 13, target: 13 })).toBeNull();
    expect(huntLine({ ...base, have: 11 })).toContain('（11/14）');
  });
});

describe('after the frames are found: no spare, the empty frames\' number', () => {
  const world = { inventory: pack({ ender_eye: 10, blaze_powder: 1 }), eyeThrows: THROWS, mapLandmarks: SEEN };
  it('says the need is the empty frames and that no spare is asked, and not a second count of 10/12 in the End\'s line', () => {
    expect(eyeBasisOf(world)).toMatchObject({ kind: 'frames', need: 11, spare: 0 });
    const said = preparationShortage({ dimension: 'overworld', food: 330, nowKinds: ['stronghold'], counts: counts({ ender_eye: 10, blaze_powder: 1 }), world, journeyReadiness: true })!;
    expect(said).toContain('空き 11 個。手持ち 10・足りない 1 個');
    expect(said).toContain('予備は要らない（枠が見つかったのでもう投げない）。要る数はこの空きの数');
    expect(said).not.toContain('エンダーアイ 10/');
    const line = endLackLine(readinessOf(frame(world))!, ['stronghold']);
    expect(line ?? '').not.toContain('アイ 10/');
  });
  it('with the eyes in the frames still unread: up to 12, no spare', () => {
    const unread = { inventory: pack({ ender_eye: 9 }), rememberedPlaces: { end_portal_frame: '10m 南 (505,31,1603)' } };
    expect(eyeBasisOf(unread)).toMatchObject({ kind: 'frames', need: 12, spare: 0, inFrames: null });
    const said = preparationShortage({ dimension: 'overworld', food: 330, nowKinds: ['stronghold'], counts: counts({ ender_eye: 9 }), world: unread, journeyReadiness: true })!;
    expect(said).toContain('予備は要らない（枠が見つかったのでもう投げない）');
    expect(said).not.toContain('エンダーアイ 9/');
  });
});

describe('a new world\'s first plan', () => {
  it('has no eye shortage line and asks no more than the rods can make (powder 14 for 14 eyes)', () => {
    const input = firstPlanInput('エンドラを討伐して', { position: { x: 0, y: 70, z: 0 }, dimension: 'overworld', biome: 'plains', time: '1000', health: 20, food: 20, inventory: [] }, { readiness: true, journeyReadiness: true });
    expect(input).not.toContain('枠 12＋予備');
    const seed = seedPlan('エンドラを討伐して', 'overworld')!;
    const pearl = seed.nodes.find(node => node.kind === 'pearl' && node.target?.item === 'ender_pearl')!;
    expect(pearl.target!.count).toBe(14);
    expect(pearl.note).toContain('枠 12＋予備 2');
    expect(pearl.note).toContain('手に入る時は予備の分まで取る');
  });
  it('with eyes in the pack in the overworld says the number to hold and that no return to the Nether is made to add', () => {
    const input = firstPlanInput('エンドラを討伐して', { position: { x: 0, y: 70, z: 0 }, dimension: 'overworld', biome: 'plains', time: '1000', health: 20, food: 20,
      inventory: pack({ ender_eye: 11 }) }, { readiness: true, journeyReadiness: true });
    expect(input).toContain('割れる分の予備を足した 14 個を持って向かうのが目安（今 11/14・あと 3 個。');
    expect(input).toContain('10 個以上あれば、足すためにネザーへ戻らず先に投げる');
  });
});
