import { describe, expect, it } from 'vitest';
import { cutOf } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';

describe('a stop on a melee foe says the next step beside it (end1109f19/f20: go re-sent with accept [magma_cube])', () => {
  it('names the foe and attack, not accept', () => {
    const line = cutOf('1 go 止 stopIf: hostileWithin:magma_cube #263 8.0m（手の途中）', false);
    expect(line).toContain('magma_cube #263 8.0m');
    expect(line).toContain('accept に入れて横を通らない');
    expect(line).toContain('attack target=#263 untilDead');
  });
  it('keeps the plain line for others', () => {
    expect(cutOf('1 go 止 stopIf: hostileWithin:ghast #12 30.0m', false)).toBe('前の act は stopIf（敵が近い）で止まった');
    expect(cutOf('1 go 止 stopIf: hostileWithin 9m', false)).toBe('前の act は stopIf（敵が近い）で止まった');
  });
});
