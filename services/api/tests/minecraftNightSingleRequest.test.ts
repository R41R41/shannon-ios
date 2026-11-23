import { describe, expect, it } from 'vitest';
import { nightChoiceLine } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { REQUEST_NIGHT_LINE, REQUEST_NIGHT_WAY, REQUEST_STEPS_LINES, REQUEST_REPLAN_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftRequestSteps.js';

// 11/23 (the cake's evening): a night with no bed, a pack of dirt and sugar only. The live's night line said the dragon run's hole (A) and the stage knowledge said no hole.
const night = { timeOfDay: 13_500, position: { x: 10.5, y: 64, z: 20.5 }, mapLandmarks: [] };
const pack = new Map([['dirt', 20], ['sugar', 3]]);

describe('the night with no bed, one thing asked: the live and the stage say the same', () => {
  it('a one-thing request gets no hole to dig; the live line is the stage knowledge\'s own words', () => {
    const line = nightChoiceLine(night, pack, 'overworld', false, 20, false, true)!;
    expect(line).toContain('夜（朝まで');
    expect(line).toContain(REQUEST_NIGHT_WAY);
    expect(REQUEST_NIGHT_LINE).toContain(REQUEST_NIGHT_WAY);
    expect(line).not.toContain('A)');
    expect(line.endsWith('。')).toBe(false);
    expect(line).not.toContain('vertical down');
    expect(line).not.toContain('place dirt');
    expect(line).toContain('穴や囲いに入って朝を待たない');
    expect(line).toContain('stopIf hostileWithin=8');
  });

  it('keeps the bed-carried silence and the other dimensions for a one-thing request too', () => {
    expect(nightChoiceLine(night, new Map([['white_bed', 1]]), 'overworld', false, 20, false, true)).toBeNull();
    expect(nightChoiceLine(night, pack, 'the_nether', false, 20, false, true)).toBeNull();
    expect(nightChoiceLine({ ...night, timeOfDay: 6_000 }, pack, 'overworld', false, 20, false, true)).toBeNull();
  });

  it('the dragon run\'s night is as it was: choice A is the sealed hole down to the ore', () => {
    const line = nightChoiceLine(night, pack, 'overworld')!;
    expect(line).toContain('A) ');
    expect(line).toContain('vertical down shaft');
    expect(line).toContain('朝まで待つ場所ではない');
    expect(line).not.toContain(REQUEST_NIGHT_WAY);
  });

  it('says the reason and the exception for the sheep and cows: not for the milk and eggs, but taken when the owner asked for wool or a bed', () => {
    const all = [...REQUEST_STEPS_LINES, REQUEST_REPLAN_KNOWLEDGE].join('\n');
    expect(all).toContain('倒すと材料が減る');
    expect(all).toContain('羊は殴って羊毛を取ってよい');
    expect(all).toContain('持ち主がベッドなどそれ自体を頼んだ時は別');
  });
});

describe('the night\'s reach (11/23, replay: a 32 m walk to sheep at dusk in 5 of 13)', () => {
  it('says the reach with its reason, in the live line and the stage line alike', () => {
    expect(REQUEST_NIGHT_WAY).toContain('20〜25m を超えて出ない');
    expect(REQUEST_NIGHT_WAY).toContain('暗いと敵が湧き');
    expect(REQUEST_NIGHT_LINE).toContain('20〜25m');
  });
});
