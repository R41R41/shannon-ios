import { describe, expect, it } from 'vitest';
import { cautionFact } from '../src/surfaces/minecraft/minecraftLlmcCaution.js';
import { createSurpriseWatch, type SurpriseFrame } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';

/** The same alarm at the same place (run58: the breath ran out three times at one vein in 25 minutes): the third is a fact on the plan's node. */
const frame = (x: number, oxygen: number): SurpriseFrame => ({ health: 20, oxygen, feet: { x, y: 17, z: -187 }, dimension: 'overworld', arrival: 1 });

describe('the breath running out at the same place again', () => {
  it('counts the alarms by place, and the fact says where and how many times', () => {
    const watch = createSurpriseWatch('oxygen-again');
    const nths: number[] = [];
    for (let step = 0; step < 14; step += 1) {
      const air = watch.detect(frame(-26.4, step % 4 === 0 ? 9 : 20), null).find(item => item.code === 'oxygen');
      if (air) nths.push(air.nth ?? 0);
    }
    expect(nths).toEqual([1, 2, 3, 4]);
    const second = { code: 'oxygen', nth: 2, at: { x: -26, y: 17, z: -187 } };
    expect(cautionFact(second, [], [])).toBe('(-26,17,-187) の近くで息が 10 未満になったのは 2 回目');
    expect(cautionFact({ ...second, nth: 1 }, [], [])).toBeNull();
  });
  it('does not count another place as the same', () => {
    const watch = createSurpriseWatch('oxygen-elsewhere');
    const first = watch.detect(frame(-26, 9), null).find(item => item.code === 'oxygen');
    for (let step = 0; step < 4; step += 1) watch.detect(frame(-26, 20), null);
    const far = watch.detect(frame(40, 9), null).find(item => item.code === 'oxygen');
    expect([first?.nth, far?.nth]).toEqual([1, 1]);
  });
});
