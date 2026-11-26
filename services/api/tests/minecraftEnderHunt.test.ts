import { describe, expect, it } from 'vitest';
import { createEnderHunt, endermenNear, huntLine, killsInLine, triesInLine } from '../src/surfaces/minecraft/minecraftEnderHunt.js';

/** The enderman hunt as numbers: the time near them, the deaths since, the pearls gained, the average drop; no place and no hand. */
const enders = (...distances: number[]) => ({ nearbyThreats: [], nearbyEntities: distances.map((distance, id) => ({ id, name: 'enderman', distance })) });
const pearls = (count: number) => new Map([['ender_pearl', count]]);
const NETHER = 'the_nether';
const killed = JSON.stringify({ v: 1, done: 1, of: 1, lines: [{ i: 1, do: 'fight', status: 'done', code: 'target_killed', line: 'fight enderman #4 死んだ', goal: 'done', end: 'finished' }] });

describe('huntLine', () => {
  it('says the numbers with the average drop, and the time to the rest when there was a kill', () => {
    const line = huntLine({ near: 3, nearest: 9.4, elapsedMs: 10 * 60_000, kills: 2, gained: 1, have: 3 })!;
    expect(line).toContain('エンダーマン狩り 10 分: いま近くに 3 体（最寄り 9m）・撃破 2 体・パール +1（3/13）');
    expect(line).toContain('1 体の落とし物は平均 0.5 個（0〜1）');
    expect(line).toContain('撃破 0.2 体/分）ならあと 10 個に約 100 分');
    expect(line).toContain('撃破は fight の結果に出た分だけ（体の反射が倒した分は結果に載らず、入っていない）');
    expect(line).toContain('反射の撃破を含まないので、実際はこれより速いことがある');
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
    expect(line).toContain('エンダーマン狩り 4 分: いま近くに 2 体（最寄り 8m）・撃破 1 体・パール +1（2/13）');
    const again = createEnderHunt(hunt.checkpoint().minecraftEnderHunt);
    expect(again.line(enders(8), pearls(2), NETHER, 4 * 60_000 + 1_000)).toContain('撃破 1 体');
  });
  it('counts every kill of a fight that watched on and killed more than one, once each', () => {
    const hunt = createEnderHunt(null);
    hunt.line(enders(8), pearls(0), NETHER, 0);
    const chained = JSON.stringify({ v: 1, done: 1, of: 1, lines: [{ i: 1, do: 'fight', status: 'done', code: 'target_killed',
      line: 'fight 3 体倒した: 済 enderman #4 → 済 enderman #7 → 済 enderman #9', goal: 'done', end: 'finished' }] });
    hunt.note('r2', chained, 60_000);
    hunt.note('r2', chained, 61_000);
    expect(hunt.line(enders(8), pearls(1), NETHER, 3 * 60_000)).toContain('撃破 3 体');
    expect(killsInLine('fight enderman #4 死んだ')).toBe(1);
  });
  it('ends after three quiet minutes or when the dimension is not read, and stays out of the End', () => {
    const hunt = createEnderHunt(null);
    hunt.line(enders(8), pearls(0), NETHER, 0);
    expect(hunt.line(enders(), pearls(0), NETHER, 4 * 60_000)).toBeNull();
    expect(hunt.line(enders(8), pearls(0), NETHER, 10 * 60_000)).toBeNull();
    expect(createEnderHunt(null).line(enders(8), pearls(0), 'the_end', 0)).toBeNull();
  });
});

describe('the fights at one enderman, as the body tallied them (1115b c1: about 900 s waiting from a roof at two of them, no blow)', () => {
  const stopped = (text: string, code = 'limit_time') => JSON.stringify({ v: 1, done: 0, of: 1, lines: [{ i: 1, do: 'fight', status: 'stopped', code, line: text, goal: 'failed', end: 'stopped' }] });
  const words = 'fight 止まった limit_time: #6796 へは 4 回目の fight・計 396 秒・打撃 計 0。同じ個体を待ち続けても当たっていない。enderman #6796 は 90 秒で倒れなかった';
  it('reads the tally the body wrote', () => {
    expect(triesInLine(words)).toEqual({ id: 6796, hands: 4, seconds: 396, landed: 0 });
    expect(triesInLine('fight 止まった limit_time: enderman #6796 は 90 秒で倒れなかった')).toBeNull();
  });
  it('says the tries at a near one with no blow, and the choice to meet it out of the roof, and forgets it at its death', () => {
    const hunt = createEnderHunt(null);
    const near = { nearbyThreats: [], nearbyEntities: [{ id: 6796, name: 'enderman', distance: 3.8 }] };
    hunt.line(near, pearls(5), NETHER, 0);
    hunt.note('r1', stopped(words), 60_000);
    const line = hunt.line(near, pearls(5), NETHER, 3 * 60_000)!;
    expect(line).toContain('#6796 へ fight 4 回・計 396 秒・打撃 0。待っても当たっていない');
    expect(line).toContain('屋根の外で迎えるか、別の個体を選ぶ');
    expect(createEnderHunt(hunt.checkpoint().minecraftEnderHunt).line(near, pearls(5), NETHER, 3 * 60_000)).toContain('#6796 へ fight 4 回'); // kept through the checkpoint
    hunt.note('r2', stopped('fight enderman #6796 死んだ', 'target_killed'), 4 * 60_000);
    expect(hunt.line(near, pearls(6), NETHER, 5 * 60_000)).not.toContain('#6796 へ fight');
  });
  it('says nothing of the tries at one that is not near', () => {
    const hunt = createEnderHunt(null);
    hunt.line(enders(8), pearls(0), NETHER, 0);
    hunt.note('r1', stopped(words), 60_000);
    expect(hunt.line(enders(8), pearls(0), NETHER, 3 * 60_000)).not.toContain('fight 4 回');
  });
});
