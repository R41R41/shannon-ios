import { describe, expect, it } from 'vitest';
import { createBlazeWatch, watchLine } from '../src/surfaces/minecraft/minecraftBlazeFacts.js';

/** The blaze camp as causes and numbers: six around the spawner hold the spawn, so waiting adds no kill; the lab saw them gone after 150 s farther than 32 blocks. */
const blazes = (count: number, distance = 8) => ({ nearbyThreats: Array.from({ length: count }, (_, index) => ({ id: index, name: 'blaze', distance })) });
const counts = (rods: number) => new Map([['blaze_rod', rods]]);
const NETHER = 'the_nether';

describe('watchLine', () => {
  it('gives the cause and the lab numbers when six or more are left, and names no hand', () => {
    const line = watchLine(6, 6 * 60_000, 4, 4)!;
    expect(line).toContain('湧き場の近くで 6 分 0 秒: 撃破 4 体・棒 4/7');
    expect(line).toContain('スポナーは止まっている（周りに 6 体いると新しく湧かない）。ここで待っても撃破は増えない');
    expect(line).toContain('32 マスより遠くで 150 秒待つと生き残りが消え、湧きが戻る（ラボ実測: 戻った時 0〜3 体）');
  });
  it('says the rate after two minutes, and after five minutes with no kill the number around (not the cause of six)', () => {
    expect(watchLine(3, 60_000, 0, 2)).toBeNull();
    expect(watchLine(3, 3 * 60_000, 1, 2)).toBe('湧き場の近くで 3 分 0 秒: 撃破 1 体・棒 2/7');
    const quiet = watchLine(3, 5 * 60_000, 0, 2)!;
    expect(quiet).toContain('撃破 0 体');
    expect(quiet).toContain('いま周りに 3 体（6 体いると新しく湧かない）');
    expect(quiet).not.toContain('ここで待っても');
  });
  it('is silent once seven rods are carried', () => {
    expect(watchLine(6, 6 * 60_000, 4, 7)).toBeNull();
  });
});

describe('createBlazeWatch', () => {
  it('starts when blazes come near in the Nether, counts a kill once, and keeps through the checkpoint', () => {
    const watch = createBlazeWatch(null);
    expect(watch.line(blazes(2), counts(2), NETHER, 0)).toBeNull();
    const result = JSON.stringify({ v: 1, done: 1, of: 1, lines: [{ i: 1, do: 'fight', status: 'done', code: 'target_killed', line: 'blaze を倒した', goal: 'done', end: 'finished' }] });
    watch.note('r1', result, 60_000);
    watch.note('r1', result, 61_000);
    const line = watch.line(blazes(2), counts(2), NETHER, 3 * 60_000)!;
    expect(line).toBe('湧き場の近くで 3 分 0 秒: 撃破 1 体・棒 2/7');
    const again = createBlazeWatch(watch.checkpoint().minecraftBlazeWatch);
    expect(again.line(blazes(2), counts(2), NETHER, 3 * 60_000 + 1_000)).toContain('撃破 1 体');
  });
  it('ends when she leaves the Nether or no blaze was near for three minutes, and ignores far ones', () => {
    const watch = createBlazeWatch(null);
    watch.line(blazes(6), counts(0), NETHER, 0);
    expect(watch.line(blazes(0), counts(0), NETHER, 4 * 60_000)).toBeNull();
    expect(watch.line(blazes(3), counts(0), NETHER, 10 * 60_000)).toBeNull();
    watch.line(blazes(3), counts(0), 'overworld', 11 * 60_000);
    expect(watch.checkpoint().minecraftBlazeWatch.since).toBeNull();
    expect(createBlazeWatch(null).line(blazes(6, 80), counts(0), NETHER, 0)).toBeNull();
  });
});
