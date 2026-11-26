import { describe, expect, it } from 'vitest';
import { cutOf } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';

describe('a stop on a melee foe says the next step beside it (end1109f19/f20: go re-sent with accept [magma_cube])', () => {
  it('names the foe and attack, not accept', () => {
    const line = cutOf('1 go 止 stopIf: hostileWithin:magma_cube #263 8.0m（手の途中）', false);
    expect(line).toContain('magma_cube #263 8.0m');
    expect(line).toContain('accept に入れて横を通らない');
    expect(line).toContain('attack target=#263 untilDead');
  });
  it('counts the blows first for a heavy foe (11/26: four hoglins, a wooden sword)', () => {
    const line = cutOf('1 go 止 stopIf: hostileWithin:hoglin #4891 7.8m（手の途中）', false)!;
    expect(line).toContain('hoglin #4891 7.8m');
    expect(line).toContain('体力 40');
    expect(line).toContain('逆の向きへ go で 16m 以上離れる');
    expect(line.indexOf('打撃数')).toBeLessThan(line.indexOf('attack target=#4891 untilDead'));
  });
  it('keeps the plain line for others', () => {
    expect(cutOf('1 go 止 stopIf: hostileWithin:ghast #12 30.0m', false)).toBe('前の act は stopIf（敵が近い）で止まった');
    expect(cutOf('1 go 止 stopIf: hostileWithin 9m', false)).toBe('前の act は stopIf（敵が近い）で止まった');
  });
});
