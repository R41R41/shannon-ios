import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { armedForNight, nightBedLine, pearlGap } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { nightMeanwhileLine, pearlDayLine, pearlNowOf } from '../src/surfaces/minecraft/minecraftNightPearl.js';
import { forgetSleepHolds, sleepStateLine } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';
import { ARROWS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * The pearl hunt's floor is the eyes to hold (`eyeBasisOf`), not 10: with the frames not found it is 12 plus the spare (14 with no throw made, 13 after one), with the frames in view or
 * remembered it is the empty frames. Before the frames are in view the night is hunted on the surface only when she is armed (iron sword, shield, health from 12); no node and no wait is made.
 */
beforeEach(() => forgetSleepHolds());
const counts = (items: Record<string, number>) => new Map(Object.entries(items));
const KIT = { iron_sword: 1, shield: 1, white_bed: 1 };
const FRAME_MARK = 'Q エンドポータルの枠 (507,31,1603) 南7・下53 ×12 アイ入り 1';
const THROW = { dim: 'overworld', x: 197, z: -245, yawDeg: 171.2, flewM: 12, broke: false, atMs: 1_000 };
const at = (extra: Record<string, unknown> = {}) => ({ dimension: 'overworld', timeOfDay: 3000, health: 20, position: { x: 0, y: 70, z: 0 }, mapLandmarks: [], nearbyThreats: [], ...extra });
const NOW = (world: Record<string, unknown>, pack: Record<string, number>) => pearlNowOf({ kindPearl: false, world, counts: counts(pack), dimension: 'overworld', endStage: true, journey: true });

describe('the floor is the eyes to hold, with no frame in view', () => {
  it('eyes 10 to 13 are short (14 with no throw made), 14 are not; pearls count with eyes', () => {
    for (const eyes of [10, 11, 12, 13]) {
      expect(pearlGap(at(), counts({ ender_eye: eyes })), `eyes ${eyes}`).toBe(14 - eyes);
      expect(NOW(at(), { ...KIT, ender_eye: eyes }), `eyes ${eyes}`).toBe(true);
    }
    expect(pearlGap(at(), counts({ ender_eye: 14 }))).toBe(0);
    expect(NOW(at(), { ...KIT, ender_eye: 14 })).toBe(false);
    expect(pearlGap(at(), counts({ ender_eye: 9, ender_pearl: 5 }))).toBe(0);
  });
  it('after a throw the number is 13', () => {
    expect(pearlGap(at({ eyeThrows: [THROW] }), counts({ ender_eye: 12 }))).toBe(1);
    expect(pearlGap(at({ eyeThrows: [THROW] }), counts({ ender_eye: 13 }))).toBe(0);
  });
  it('frames in view: the scene of the portal room is as it was (10 eyes with 11 empty frames are 1 short, 11 are not), armed or not', () => {
    const view = at({ mapLandmarks: [FRAME_MARK] });
    expect(pearlGap(view, counts({ ender_eye: 10 }))).toBe(1);
    expect(pearlGap(view, counts({ ender_eye: 11 }))).toBe(0);
    expect(NOW(view, { ender_eye: 10 })).toBe(true);
    expect(NOW(view, { ...KIT, ender_eye: 11 })).toBe(false);
  });
  it('frames only remembered (the row does not say how many hold an eye): the whole 12 are the need, with eyes 11 one short', () => {
    const remembered = at({ rememberedPlaces: { end_portal_frame: '155m 南 (505,31,1603) ×12' } });
    expect(pearlGap(remembered, counts({ ender_eye: 11 }))).toBe(1);
    expect(pearlGap(remembered, counts({ ender_eye: 12 }))).toBe(0);
    expect(NOW(remembered, { ...KIT, ender_eye: 11 })).toBe(true);
  });
  it('unarmed (no shield, no iron sword, health under 12) the pearls are not the now before the frames are in view; the night is slept as before', () => {
    expect(NOW(at(), { iron_sword: 1, ender_eye: 11 })).toBe(false);
    expect(NOW(at(), { shield: 1, stone_sword: 1, ender_eye: 11 })).toBe(false);
    expect(NOW(at({ health: 10 }), { ...KIT, ender_eye: 11 })).toBe(false);
    expect(armedForNight(at(), counts(KIT))).toBe(true);
    expect(armedForNight(at({ health: 11 }), counts(KIT))).toBe(false);
    const world = at({ timeOfDay: 14000 }), pack = { ...KIT, shield: 0, ender_eye: 11 };
    const bed = nightBedLine(world, counts(pack), 'overworld', NOW(world, pack))!;
    expect(bed).not.toContain('その夜は寝ない');
    expect(bed).toContain('夜（朝まで');
  });
});

describe('the day before the frames are found is for the walk', () => {
  it('no line that counts the wait for the night (tick 9000, no frame in view); with the frames in view it is as it was', () => {
    expect(nightMeanwhileLine(at({ timeOfDay: 9000 }), counts({ ...KIT, ender_eye: 11 }), 'overworld', true)).toBeNull();
    expect(nightMeanwhileLine(at({ timeOfDay: 9000, mapLandmarks: [FRAME_MARK] }), counts({ ...KIT, ender_eye: 10 }), 'overworld', true)).toContain('待つだけでは なにも進まない');
  });
  it('the day line (armed) says not to wait for the night, to hunt when an enderman is in view or the night is on, and to sleep when not fit or none is in view', () => {
    const line = pearlDayLine(at(), counts({ ...KIT, ender_eye: 11 }), 'overworld', true, null)!;
    expect(line).toContain('パールはあと 3 個足りない');
    expect(line).toContain('昼は夜を待たず進む');
    expect(line).toContain('エンダーマンが見えたら、または夜が来ていたら寝ずに狩る');
    expect(line).toContain('探して歩き回って夜を過ごすより寝て飛ばしてよい');
  });
  it('the day line without the kit never says to hunt through the night', () => {
    const line = pearlDayLine(at(), counts({ white_bed: 1, ender_eye: 11 }), 'overworld', true, null)!;
    expect(line).toContain('昼は夜を待たず進む');
    expect(line).not.toContain('寝ずに狩る');
    expect(line).toContain('寝て飛ばしてよい');
  });
  it('the knowledge says that not waiting for the night and not sleeping a night that has come are two things', () => {
    expect(JSON.stringify(V2_STAGES)).toContain('夜を待たないことと、来た夜を寝て飛ばさないことは別');
  });
});

describe('the bow on a night spent for the pearls (armed only)', () => {
  const night = at({ timeOfDay: 14000 });
  it('names the spider and the skeleton, the string and sticks carried, from the constants; pearls first, no search', () => {
    const line = nightBedLine(night, counts({ ...KIT, ender_eye: 11, string: 1, stick: 2 }), 'overworld', true)!;
    expect(line).toContain('この夜に同じ地上で取れる弓矢の物');
    expect(line).toContain('クモ→糸');
    expect(line).toContain('糸 1/3・棒 2/3');
    expect(line).toContain('弓 無し');
    expect(line).toContain(`スケルトン→矢（今 0/${ARROWS.count}`);
    expect(line).toContain('エンダーマンのパールが先');
    expect(line).toContain('探し回らない');
  });
  it('with the bow carried only the arrows are said; with both at their aim nothing is said', () => {
    const bowed = nightBedLine(night, counts({ ...KIT, ender_eye: 11, bow: 1 }), 'overworld', true)!;
    expect(bowed).toContain('スケルトン→矢');
    expect(bowed).not.toContain('クモ→糸');
    expect(nightBedLine(night, counts({ ...KIT, ender_eye: 11, bow: 1, arrow: ARROWS.count }), 'overworld', true)).not.toContain('弓矢の物');
  });
  it('not said without a shield, with low health, when the pearls are not short, or when the pearls are not the now', () => {
    expect(nightBedLine(night, counts({ ...KIT, shield: 0, ender_eye: 11 }), 'overworld', true)).not.toContain('弓矢の物');
    expect(nightBedLine(at({ timeOfDay: 14000, health: 8 }), counts({ ...KIT, ender_eye: 11 }), 'overworld', true)).not.toContain('弓矢の物');
    expect(nightBedLine(night, counts({ ...KIT, ender_eye: 14 }), 'overworld', true)).not.toContain('弓矢の物');
    expect(nightBedLine(night, counts({ ...KIT, ender_eye: 11 }), 'overworld', false)).not.toContain('弓矢の物');
  });
});

describe('the sleep state line', () => {
  const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
    state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, time: '14000', worn: '', mapLandmarks: [], ...world } as never } as never });
  const inv = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
  it('says how to hunt the pearls tonight (take the booking back) only with the pearls short and the kit', () => {
    const armed = frame({ inventory: inv({ ...KIT, ender_eye: 11 }) });
    expect(sleepStateLine(armed, 'p', null, Date.now, true)).toContain('パールを夜に狩るなら sleep on=false で予約を消す');
    expect(sleepStateLine(armed, 'p', null, Date.now, false)).not.toContain('パールを夜に狩るなら');
    expect(sleepStateLine(frame({ inventory: inv({ ...KIT, shield: 0, ender_eye: 11 }) }), 'p', null, Date.now, true)).not.toContain('パールを夜に狩るなら');
    expect(sleepStateLine(frame({ inventory: inv({ ...KIT, ender_eye: 14 }) }), 'p', null, Date.now, true)).not.toContain('パールを夜に狩るなら');
  });
});
