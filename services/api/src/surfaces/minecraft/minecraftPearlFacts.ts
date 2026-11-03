import { carried } from './minecraftConditions.js';

/**
 * The pearls still to find, said as numbers beside the choices (the pearl forest scenes of 11/3: with 18 gold and 2 endermen in 10 minutes the
 * model fought on and never set the trade against the wait): how many are carried (pearls and eyes, an eye was a pearl), how many are
 * missing of the 14 the road aims at, and what the gold carried gives at a piglin's 16 ingots to one pearl on average. Only numbers the body
 * reported; it names no way to get them.
 */
export const PEARL_TARGET = 14;
const GOLD_PER_PEARL = 16;

/** The line for a decision in the Nether with rods in hand and pearls missing, or null. */
export function pearlLine(counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if (dimension !== 'the_nether') return null;
  const have = carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');
  const rods = carried(counts, 'blaze_rod') + carried(counts, 'blaze_powder');
  if (have >= PEARL_TARGET || (rods === 0 && have === 0)) return null;
  const gold = carried(counts, 'gold_ingot');
  const trade = Math.round(gold / GOLD_PER_PEARL * 10) / 10;
  return `パール ${have}/${PEARL_TARGET}（あと ${PEARL_TARGET - have} 個）: 持っている金の延べ棒 ${gold} 個の交換は平均 約 ${trade} 個`
    + `（金 ${GOLD_PER_PEARL} 個で平均 1 個）`;
}
