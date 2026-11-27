import { describe, expect, it } from 'vitest';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { actMilliseconds, SHOOT_FLIGHT_MS } from '../src/contracts/minecraftActTime.js';

const act = (hand: Record<string, unknown>): ActInput => ({ hands: [{ do: 'shoot', target: '#1', ...hand }] } as unknown as ActInput);
describe('the shoot hand\'s ceiling holds the arrow\'s flight', () => {
  it('gives one shot more than a lobbed shot measured (6.2 s), and each further shot its own draw and flight', () => {
    expect(actMilliseconds(act({}))).toBe(1_500 + 1_000 + SHOOT_FLIGHT_MS);
    expect(actMilliseconds(act({}))).toBeGreaterThan(6_200);
    expect(actMilliseconds(act({ n: 2 }))).toBe(2 * (2_500 + SHOOT_FLIGHT_MS));
    expect(actMilliseconds(act({ n: 3 }))).toBe(3 * (2_500 + SHOOT_FLIGHT_MS));
  });
  it('keeps the other hands\' ceilings as they were', () => {
    const one = (hand: Record<string, unknown>) => actMilliseconds({ hands: [hand] } as unknown as ActInput);
    expect(one({ do: 'jump', n: 2 })).toBe(5_000);
    expect(one({ do: 'wait', seconds: 8 })).toBe(8_500);
    expect(one({ do: 'attack', seconds: 10 })).toBe(12_000);
    expect(one({ do: 'pillarUp', n: 10 })).toBe(12_000);
  });
});
