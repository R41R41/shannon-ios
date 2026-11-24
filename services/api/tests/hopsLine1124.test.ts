import { describe, expect, it } from 'vitest';
import { hopsLine, queueLines } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';

// try1124b stall (the owner's test of 11/24, 07:15 to 07:22): 40 finished gos had a median of 6 steps against a decision of 2 to 3 s.
describe('the line of her recent moves (hopsLine)', () => {
  it('says the short moves beside the decision time when the last ones were short', () => {
    const line = hopsLine([5, 7, 5, 11, 8], [2800, 3100, 2500])!;
    expect(line).toContain('5・7・5・11・8 m');
    expect(line).toContain('中央 7 m');
    expect(line).toContain('判断 1 回に約 3 秒');
    expect(line).toContain('15 m 以上');
  });
  it('is silent with fewer than 3 moves, or when the median is 14 m or more', () => {
    expect(hopsLine([5, 7], [3000])).toBeNull();
    expect(hopsLine([], [])).toBeNull();
    expect(hopsLine([20, 16, 5, 30, 18], [3000])).toBeNull();
  });
  it('reads only the last five moves', () => {
    expect(hopsLine([2, 2, 2, 2, 40, 40, 40], [3000])).toBeNull();
    expect(hopsLine([40, 40, 40, 4, 5, 6, 3, 4], [3000])).toContain('中央 4 m');
  });
  it('takes the decision time as 2 s at least, and 3 s when none is known', () => {
    expect(hopsLine([4, 4, 4], [])).toContain('約 3 秒かかる');
    expect(hopsLine([4, 4, 4], [500, 800])).toContain('約 2 秒かかる');
  });
  it('comes with the lines of an empty queue and of a running one', () => {
    const timing = { wakeMs: 6000, leftMs: 0, hops: [4, 4, 5], decisionsMs: [2800] };
    expect(queueLines([], null, { progress: null, leftMs: 0 }, timing)).toEqual(['列に項目なし', hopsLine([4, 4, 5], [2800])]);
    expect(queueLines([], null, { progress: null, leftMs: 0 })).toEqual(['列に項目なし']);
    expect(queueLines([], null, { progress: null, leftMs: 0 }, { wakeMs: 6000, leftMs: 0, hops: [30, 30, 30] })).toEqual(['列に項目なし']);
  });
});
