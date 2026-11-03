import { describe, expect, it } from 'vitest';
import { createEnderHunt, endermenNear, huntLine } from '../src/surfaces/minecraft/minecraftEnderHunt.js';

/** The enderman hunt as numbers: the time near them, the deaths since, the pearls gained, the average drop; no place and no hand. */
const enders = (...distances: number[]) => ({ nearbyThreats: [], nearbyEntities: distances.map((distance, id) => ({ id, name: 'enderman', distance })) });
const pearls = (count: number) => new Map([['ender_pearl', count]]);
const NETHER = 'the_nether';
const killed = JSON.stringify({ v: 1, done: 1, of: 1, lines: [{ i: 1, do: 'fight', status: 'done', code: 'target_killed', line: 'fight enderman #4 死んだ', goal: 'done', end: 'finished' }] });

describe('huntLine', () => {
  it('says the numbers with the average drop, and the time to the rest when there was a kill', () => {
    const line = huntLine({ near: 3, nearest: 9.4, elapsedMs: 10 * 60_000, kills: 2, gained: 1, have: 3 })!;
    expect(line).toContain('エンダーマン狩り 10 分: いま近くに 3 体（最寄り 9m）・撃破 2 体・パール +1（3/14）');
    expect(line).toContain('1 体の落とし物は平均 0.5 個（0〜1）');
    expect(line).toContain('撃破 0.2 体/分）ならあと 11 個に約 110 分');
  });
  it('has no time estimate with no kill, nothing before two minutes, nothing once the pearls are enough', () => {
    expect(huntLine({ near: 2, nearest: 5, elapsedMs: 10 * 60_000, kills: 0, gained: 0, have: 0 })).not.toContain('ならあと');
    expect(huntLine({ near: 2, nearest: 5, elapsedMs: 60_000, kills: 0, gained: 0, have: 0 })).toBeNull();
    expect(huntLine({ near: 2, nearest: 5, elapsedMs: 10 * 60_000, kills: 5, gained: 14, have: 14 })).toBeNull();
  });
});

describe('endermenNear', () => {
  it('counts an id once across both lists, within 32 blocks, nearest first', () => {
    const world = { nearbyThreats: [{ id: 1, name: 'enderman', distance: 9 }], nearbyEntities: [{ id: 1, name: 'enderman', distance: 9 }, { id: 2, name: 'enderman', distance: 4 },
      { id: 3, name: 'enderman', distance: 60 }, { id: 4, name: 'blaze', distance: 3 }] };
    expect(endermenNear(world).map(item => item.id)).toEqual([2, 1]);
  });
});

describe('createEnderHunt', () => {
  it('starts when an enderman comes near, counts a death once, measures the pearls gained, and keeps through the checkpoint', () => {
    const hunt = createEnderHunt(null);
    expect(hunt.line(enders(8), pearls(1), NETHER, 0)).toBeNull();
    hunt.note('r1', killed, 60_000);
    hunt.note('r1', killed, 61_000);
    const line = hunt.line(enders(8, 12), pearls(2), NETHER, 4 * 60_000)!;
    expect(line).toContain('エンダーマン狩り 4 分: いま近くに 2 体（最寄り 8m）・撃破 1 体・パール +1（2/14）');
    const again = createEnderHunt(hunt.checkpoint().minecraftEnderHunt);
    expect(again.line(enders(8), pearls(2), NETHER, 4 * 60_000 + 1_000)).toContain('撃破 1 体');
  });
  it('ends after three quiet minutes or when the dimension is not read, and stays out of the End', () => {
    const hunt = createEnderHunt(null);
    hunt.line(enders(8), pearls(0), NETHER, 0);
    expect(hunt.line(enders(), pearls(0), NETHER, 4 * 60_000)).toBeNull();
    expect(hunt.line(enders(8), pearls(0), NETHER, 10 * 60_000)).toBeNull();
    expect(createEnderHunt(null).line(enders(8), pearls(0), 'the_end', 0)).toBeNull();
  });
});
