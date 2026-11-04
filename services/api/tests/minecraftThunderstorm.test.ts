import { beforeEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { nightArmsLine, nightBedLine } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { forgetSleepHolds, SLEEP_HOLDS, sleepFirstHold } from '../src/surfaces/minecraft/minecraftLlmcSleepHold.js';
import { timeWords } from '../src/surfaces/minecraft/minecraftLlmcStateWords.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';

const bed = new Map([['white_bed', 1]]);
const work = { hands: [{ do: 'mine', block: 'oak_log', count: 3 }] };
const frame = (extra: Record<string, unknown> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'storm-body', sequence: 1, stateAt: 't', receivedAt: 't', connected: true, facts: {},
  state: { world: { dimension: 'overworld', time: '6000', weather: 'thunder', health: 20,
    inventory: [{ name: 'white_bed', count: 1 }], ...extra } as never },
});

beforeEach(() => forgetSleepHolds());

describe('thunderstorm facts and the bounded sleep hold', () => {
  it('says that daytime thunderstorms spawn hostiles and permit sleep, including without a known clock', () => {
    for (const world of [{ time: '6000', weather: 'thunder' }, { weather: 'thunder' }, { timeOfDay: 0, weather: '雷雨' }]) {
      expect(nightArmsLine(world, new Map(), 'overworld')).toContain('雷雨は昼でも地上にゾンビ・スケルトンが湧く');
      expect(nightBedLine(world, bed, 'overworld')).toContain('時刻に関係なく寝られ');
      expect(nightBedLine(world, bed, 'overworld')).toContain('雷雨が止む');
    }
    expect(nightBedLine({ weather: 'thunder' }, new Map(), 'overworld')).toBeNull();
  });

  it('does not turn ordinary rain into night or allow sleep in the Nether or the End', () => {
    const rainy = { time: '6000', weather: 'rain' };
    expect(nightArmsLine(rainy, new Map(), 'overworld')).toBeNull();
    expect(nightBedLine(rainy, bed, 'overworld')).toBeNull();
    expect(sleepFirstHold(work, frame({ weather: 'rain' }), 'rain')).toBeNull();
    for (const dimension of ['the_end', 'the_nether']) {
      expect(nightArmsLine({ weather: 'thunder' }, new Map(), dimension)).toBeNull();
      expect(nightBedLine({ weather: 'thunder' }, bed, dimension)).toBeNull();
      expect(sleepFirstHold(work, frame({ dimension }), 'other-dimension')).toBeNull();
      expect(timeWords('6000', dimension, 'thunder')).toBe('（時刻なし）');
    }
  });

  it('holds work at any thunderstorm hour and stops after the existing number of holds', () => {
    for (const time of ['6000', '23500', undefined]) {
      expect(sleepFirstHold(work, frame({ time }), 'any-hour')!.line).toContain('雷雨（時刻に関係なく寝られる）');
    }
    for (let attempt = 0; attempt < SLEEP_HOLDS; attempt += 1) {
      const held = sleepFirstHold(work, frame(), 'bounded-storm', () => 1)!;
      expect(held.line).toContain('雷雨が止む');
      expect(held.line).not.toContain('朝になる');
      held.commit();
    }
    expect(sleepFirstHold(work, frame(), 'bounded-storm', () => 1)).toBeNull();
  });

  it('keeps nearby enemies, missing beds and an earlier sleep hand as exceptions in a thunderstorm', () => {
    const enemy = { nearbyThreats: [{ name: 'zombie', distance: 7 }] };
    expect(sleepFirstHold(work, frame(enemy), 'enemy')).toBeNull();
    expect(nightBedLine({ weather: 'thunder', ...enemy }, bed, 'overworld')).toContain('8m 内に敵がいる間は寝られない');
    expect(sleepFirstHold(work, frame({ inventory: [] }), 'no-bed')).toBeNull();
    expect(sleepFirstHold({ hands: [{ do: 'place', block: 'white_bed' }, ...work.hands] }, frame(), 'sleep-first')).toBeNull();
  });

  it('adds the storm facts to the actual live time without calling a daytime storm night', () => {
    expect(timeWords('6000', 'overworld', 'thunder')).toContain('昼');
    expect(timeWords('unknown', 'overworld', 'thunder')).toContain('時刻に関係なく寝られる');
    expect(timeWords('unknown', 'overworld', 'rain')).toBeNull();
    const live = minecraftLlmcLive({ observation: frame(), elapsedMinutes: 0, trend: createFoodTrend(), events: [] });
    expect(live.state).toMatchObject({ weather: 'thunder', time: timeWords('6000', 'overworld', 'thunder') });
  });
});
