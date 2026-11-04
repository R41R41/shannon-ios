import { describe, expect, it } from 'vitest';
import { createDescentTrail, nextTrail, trailLine } from '../src/surfaces/minecraft/minecraftDescentTrail.js';

/**
 * The way she came down, kept by the head (the whole-run audit of 11/4, order 2; run61 took about 7 minutes to dig a new way up from the diamonds and
 * died in a cave at y 44 three minutes after sunrise).
 */
const at = (x: number, y: number, z: number, dimension = 'overworld') => ({ dimension, feet: { x, y, z } });

describe('the descent trail', () => {
  it('starts at the last point at the surface, adds a point every few blocks below it, and says the way back with the dark', () => {
    let trail = nextTrail([], at(0, 70, 0));
    for (const [x, y, z] of [[2, 60, 0], [3, 44, 0], [3, 40, 0], [6, 30, 2], [12, 20, 2], [12, 19, 3]]) trail = nextTrail(trail, at(x!, y!, z!));
    expect(trail.map(point => point.y)).toEqual([60, 44, 30, 20]);
    const line = trailLine(trail, at(12, 19, 3))!;
    expect(line).toBe('下りた跡（頭の控え。歩いた・掘った道で、下りの時は通れた）: 今 (12,19,3) ← (12,20,2) ← (6,30,2) ← (3,44,0) ← '
      .replace('← (12,20,2) ', '') + '地表側 (2,60,0)（y 45 以上の最後の点）。地下は時刻にかかわらず暗く、敵が湧く（朝・昼でも）');
  });
  it('cuts the trail where she comes back to a point of it, and starts again after a jump or out of the overworld', () => {
    let trail = nextTrail([], at(0, 64, 0));
    for (const [x, y, z] of [[0, 40, 0], [0, 30, 0], [0, 20, 0]]) trail = nextTrail(trail, at(x!, y!, z!));
    expect(nextTrail(trail, at(1, 31, 0)).map(point => point.y)).toEqual([64, 40, 30]);
    expect(nextTrail(trail, at(300, 20, 0))).toEqual([{ x: 300, y: 20, z: 0 }]);
    expect(nextTrail(trail, at(0, 20, 0, 'the_nether'))).toEqual([]);
    expect(trailLine(trail, at(0, 70, 0))).toBeNull();
  });
  it('says when the surface was never seen, and keeps the trail through a checkpoint', () => {
    const below = createDescentTrail(null);
    below.line(at(0, 20, 0));
    expect(below.line(at(0, 10, 0))).toContain('最初の点 (0,20,0)（地表は見ていない）');
    const again = createDescentTrail(below.checkpoint().minecraftDescentTrail);
    expect(again.line(at(0, 5, 0))).toContain('今 (0,5,0) ← (0,10,0) ← 最初の点 (0,20,0)');
  });
});
