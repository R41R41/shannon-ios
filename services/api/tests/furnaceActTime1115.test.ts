import { describe, expect, it } from 'vitest';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { actMilliseconds, FURNACE_TAKE_WAIT_SECONDS } from '../src/contracts/minecraftActTime.js';

// 11/15b w1109r: 7 furnace hands were cut at the act's 5 s, while the body waits up to 15 s for a batch before a take and walks to the furnace itself.
describe('the furnace hand\'s ceiling holds the body\'s wait before a take and the way to the furnace', () => {
  const furnace = { x: 10, y: 64, z: 0 };
  const act = (hand: Record<string, unknown>): ActInput => ({ hands: [{ do: 'furnace', at: [furnace], ...hand }] } as unknown as ActInput);
  it('gives a take beside the furnace the window and the body\'s wait (the body\'s TAKE_WAIT_DUE_SECONDS, 15)', () => {
    expect(FURNACE_TAKE_WAIT_SECONDS).toBe(15);
    expect(actMilliseconds(act({ op: 'take' }), { x: 10, y: 64, z: 1 })).toBeGreaterThan(5_000 + 15_000);
  });
  it('adds the walk to a furnace a take goes to, and the digging a put with canDig may do', () => {
    const near = actMilliseconds(act({ op: 'take' }), { x: 10, y: 64, z: 1 }), far = actMilliseconds(act({ op: 'take' }), { x: 40, y: 64, z: 0 });
    expect(far - near).toBeGreaterThan(10_000);
    const put = act({ op: 'put', item: 'raw_iron', count: 6, fuel: 'coal', fuelCount: 1 });
    expect(actMilliseconds(put, { x: 30, y: 64, z: 0 })).toBe(5_000);
    expect(actMilliseconds(act({ op: 'put', item: 'raw_iron', count: 6, fuel: 'coal', fuelCount: 1, canDig: ['stone'], maxDig: 10 }), { x: 30, y: 64, z: 0 }))
      .toBeGreaterThan(5_000 + 10_000);
  });
});
