import { describe, expect, it } from 'vitest';
import { pearlLine } from '../src/surfaces/minecraft/minecraftPearlFacts.js';

/** The pearls still to find, as numbers beside the choices (the pearl forest scenes: 18 gold and 2 endermen in 10 minutes, and no trade set against the wait). */
const pack = (items: Record<string, number>) => new Map(Object.entries(items));

describe('the pearl line', () => {
  it('says how many are missing and what the gold carried gives, eyes counted as pearls', () => {
    expect(pearlLine(pack({ ender_pearl: 3, gold_ingot: 18, blaze_rod: 7 }), 'the_nether'))
      .toBe('パール 3/14（あと 11 個）: 持っている金の延べ棒 18 個の交換は平均 約 1.1 個（金 16 個で平均 1 個）');
    expect(pearlLine(pack({ ender_pearl: 3, ender_eye: 4, blaze_powder: 2 }), 'the_nether')).toContain('パール 7/14（あと 7 個）');
  });
  it('says nothing outside the Nether, with the pearls found, or before rods and pearls begin', () => {
    expect(pearlLine(pack({ ender_pearl: 3, gold_ingot: 18 }), 'overworld')).toBeNull();
    expect(pearlLine(pack({ ender_pearl: 14 }), 'the_nether')).toBeNull();
    expect(pearlLine(pack({ gold_ingot: 18 }), 'the_nether')).toBeNull();
  });
});
