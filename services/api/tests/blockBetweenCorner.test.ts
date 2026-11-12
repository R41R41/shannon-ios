import { describe, expect, it } from 'vitest';
import { blockBetween } from '../src/surfaces/minecraft/minecraftLlmcLiquid.js';

// Run 9 (2026-11-12): the live line said 「届く」 of a source one block aside on both horizontal axes in a tunnel; the body's click was stopped by the wall beside the line, eleven times.
const view = (hard: string[]) => ({ symbol: (x: number, y: number, z: number) => hard.includes(`${x},${y},${z}`) ? '#' : '.' }) as never;
const feet = { x: 193, y: 35, z: -198 }, eye = { x: 193.5, y: 36.62, z: -197.5 }, water = { x: 194, y: 36, z: -197 };

describe('the line from the eye to a source one block aside on both axes', () => {
  it('is blocked when one of the two cells beside the corner is hard', () => {
    expect(blockBetween(view(['194,36,-198']), eye, water, feet)).toEqual({ x: 194, y: 36, z: -198 });
    expect(blockBetween(view(['193,36,-197']), eye, water, feet)).toEqual({ x: 193, y: 36, z: -197 });
  });
  it('is clear when both are open, and a block in a straight line is still named', () => {
    expect(blockBetween(view([]), eye, water, feet)).toBeNull();
    expect(blockBetween(view(['195,36,-198']), eye, { x: 197, y: 36, z: -198 }, feet)).toEqual({ x: 195, y: 36, z: -198 });
  });
});
