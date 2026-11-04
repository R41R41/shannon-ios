import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { heldOfFrame } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { forgetSleepHolds, SLEEP_HOLDS, SLEEP_WINDOW_MS, sleepFirstHold } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';

/**
 * Sleep before the evening's work (the whole-run audit of 11/4, order 1: run60 took planks for three minutes as the night came and died). At night with
 * a bed in the pack and no hostile within 8 m, the first work hand is held unless the sleep comes before it; at most three holds in ten minutes.
 */
const pack = (items: ReadonlyArray<readonly [string, number]>) => items.map(([name, count]) => ({ name, count }));
const frame = (items: ReadonlyArray<readonly [string, number]>, world: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b',
  sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', position: { x: 0, y: 70, z: 0 }, health: 20, food: 20, time: '14000', inventory: pack(items), worn: '',
    ...world } as never } });
const BED: Array<[string, number]> = [['white_bed', 1], ['iron_sword', 1]];
const planks = { hands: [{ do: 'go', to: { x: 3, y: 70, z: 3 } }, { do: 'mine', block: 'oak_planks', count: 8 }] };

beforeEach(() => forgetSleepHolds());

describe('sleep before the work of the night', () => {
  it('holds the first work hand at night with a bed and no enemy near, and says how to sleep', () => {
    const held = sleepFirstHold(planks, frame(BED), 't1');
    expect(held).toMatchObject({ hand: 2, kind: 'mine' });
    for (const word of ['夜（朝まで', 'white_bed', '8m 内に敵はいない', 'sleep の手', '1/3 回目']) expect(held!.line, word).toContain(word);
    expect(heldOfFrame(planks, frame(BED), 't1')).toMatchObject({ hand: 2, code: 'sleep_first', kind: 'mine' });
  });
  it('holds from tick 12,542 (dusk: a bed can be slept in), through the night, and not by day', () => {
    expect(sleepFirstHold(planks, frame(BED, { time: '12600' }), 'd')!.line).toContain('夕方（夜まで');
    expect(sleepFirstHold(planks, frame(BED, { timeOfDay: 22_000, time: 'x' }), 'd')).not.toBeNull();
    expect(sleepFirstHold(planks, frame(BED, { time: '12000' }), 'd')).toBeNull();
    expect(sleepFirstHold(planks, frame(BED, { time: '23100' }), 'd')).toBeNull();
    expect(sleepFirstHold(planks, frame(BED, { time: '1000' }), 'd')).toBeNull();
  });
  it('lets the act go when the sleep comes first, the bed is placed first, or the hand is no work (dig, move, fight, eat)', () => {
    const slept = { hands: [{ do: 'place', block: 'white_bed', at: [{ x: 1, y: 70, z: 0 }] }, { do: 'use', at: [{ x: 1, y: 70, z: 0 }] },
      { do: 'mine', block: 'oak_log', count: 3 }] };
    expect(sleepFirstHold(slept, frame(BED), 's')).toBeNull();
    expect(sleepFirstHold({ hands: [{ do: 'dig', at: [{ x: 1, y: 70, z: 0 }] }, { do: 'eat', item: 'bread' }, { do: 'go', to: { x: 9, y: 70, z: 0 } }] },
      frame(BED), 's')).toBeNull();
  });
  it('holds nothing without a bed, with an enemy within 8 m, or outside the overworld', () => {
    expect(sleepFirstHold(planks, frame([['iron_sword', 1]]), 'n')).toBeNull();
    expect(sleepFirstHold(planks, frame(BED, { nearbyThreats: [{ name: 'zombie', distance: 6 }] }), 'n')).toBeNull();
    expect(sleepFirstHold(planks, frame(BED, { nearbyThreats: [{ name: 'zombie', distance: 12 }] }), 'n')).not.toBeNull();
    expect(sleepFirstHold(planks, frame(BED, { dimension: 'the_nether' }), 'n')).toBeNull();
    expect(sleepFirstHold(planks, null, 'n')).toBeNull();
  });
  it('holds at most three times in ten minutes, counting only the holds that stopped the act', () => {
    let clock = 0;
    const now = () => clock;
    for (let i = 1; i <= SLEEP_HOLDS; i += 1) {
      const held = sleepFirstHold(planks, frame(BED), 'b', now);
      expect(held!.line).toContain(`${i}/${SLEEP_HOLDS} 回目`);
      held!.commit();
      clock += 60_000;
    }
    expect(sleepFirstHold(planks, frame(BED), 'b', now)).toBeNull();
    clock += SLEEP_WINDOW_MS;
    expect(sleepFirstHold(planks, frame(BED), 'b', now)).not.toBeNull();
    // Not committed: another guard stopped an earlier hand.
    sleepFirstHold(planks, frame(BED), 'c', now);
    expect(sleepFirstHold(planks, frame(BED), 'c', now)!.line).toContain(`1/${SLEEP_HOLDS} 回目`);
  });
});

describe('the sleep hand (S4, 11/5)', () => {
  it('lets an act go whose sleep hand comes before its work', () => {
    forgetSleepHolds();
    expect(sleepFirstHold({ hands: [{ do: 'sleep', item: 'white_bed' }, { do: 'mine', block: 'oak_log', count: 3 }] }, frame(BED), 'h')).toBeNull();
  });
  it('takes an item that is a bed and seconds 10 to 60, and writes and reads its short form', async () => {
    const { handProblem } = await import('../src/contracts/minecraftActHandRules.js');
    const { lineToHand, handToLine } = await import('../src/contracts/minecraftActShortHands.js');
    expect(handProblem({ do: 'sleep' } as never)).toBeNull();
    expect(handProblem({ do: 'sleep', item: 'white_bed', seconds: 45 } as never)).toBeNull();
    expect(handProblem({ do: 'sleep', seconds: 90 } as never)).toContain('10');
    expect(handProblem({ do: 'sleep', item: 'stone' } as never)).toContain('ベッド');
    expect(handProblem({ do: 'sleep', at: [{ x: 0, y: 0, z: 0 }] } as never)).not.toBeNull();
    expect(handToLine({ do: 'sleep', item: 'white_bed', seconds: 30 } as never)).toBe('sleep white_bed seconds=30');
    expect(lineToHand('sleep white_bed seconds=30')).toEqual({ do: 'sleep', item: 'white_bed', seconds: 30 });
  });
});
