import { describe, expect, it } from 'vitest';
import { llmcInputProblem } from '../src/surfaces/minecraft/minecraftLlmc.js';

/** Run 15 (11/27): pillarUp n=37 was refused by the head (top 16) though the body climbs to 32; `go canDig: []` was refused with only a count. Written in 1127m. */
const pillar = (n: number) => ({ hands: [{ do: 'pillarUp', n }], why: '[p1] x' });
describe('pillarUp n up to 32 and the empty canDig hint (1127m)', () => {
  it('takes n up to 32, as the body does, and still refuses 33 and 0', () => {
    for (const n of [1, 16, 17, 32]) expect(llmcInputProblem('mc.act', pillar(n))).toBeNull();
    for (const n of [33, 0]) expect(llmcInputProblem('mc.act', pillar(n))).toContain('n');
  });
  it('tells an empty canDig to leave the field out', () => {
    const go = { hands: [{ do: 'go', to: { x: 3, y: 66, z: -12 }, canDig: [] }], why: '[p1] x' };
    expect(llmcInputProblem('mc.act', go)).toContain('欄ごと書かない');
    expect(llmcInputProblem('mc.act', { hands: [{ do: 'go', to: { x: 3, y: 66, z: -12 } }], why: '[p1] x' })).toBeNull();
  });
});
