import { carried } from './minecraftConditions.js';

/**
 * The pearls still to find, said as numbers beside the choices (the pearl forest scenes of 11/3: with 18 gold and 2 endermen in 10 minutes the
 * model fought on and never set the trade against the wait): how many are carried (pearls and eyes, an eye was a pearl), how many are
 * missing of the 14 the road aims at, and what the gold carried gives at a piglin's 15.6 ingots to one pearl on average (S6 read the 1.21.11
 * barter table: weight 10 of 469, 2 to 4 pearls). Only numbers the body
 * reported; it names no way to get them.
 */
export const PEARL_TARGET = 14;
const GOLD_PER_PEARL = 15.6;

/** The line for a decision in the Nether with rods in hand and pearls missing, or null. Both ways are set side by side in the same units
 * (end1108c and h28 in a warped forest: with no gold the line still named only the trade, and Haiku twice left the endermen to dig nether
 * gold ore and chase nuggets). An enderman drops 0 or 1 pearl evenly (0.5 on average); a nether gold ore drops 2 to 6 nuggets, 9 nuggets
 * make an ingot, so one pearl by trade is about 140 nuggets or 35 ores. */
const PEARLS_PER_ENDERMAN = 0.5;
const NUGGETS_PER_INGOT = 9;
const NUGGETS_PER_ORE = 4;
export function pearlLine(counts: ReadonlyMap<string, number>, dimension: string | null): string | null {
  if (dimension !== 'the_nether') return null;
  const have = carried(counts, 'ender_pearl') + carried(counts, 'ender_eye');
  const rods = carried(counts, 'blaze_rod') + carried(counts, 'blaze_powder');
  if (have >= PEARL_TARGET || (rods === 0 && have === 0)) return null;
  const missing = PEARL_TARGET - have;
  const gold = carried(counts, 'gold_ingot');
  const trade = Math.round(gold / GOLD_PER_PEARL * 10) / 10;
  const nuggets = Math.round(GOLD_PER_PEARL * NUGGETS_PER_INGOT);
  const ores = Math.round(nuggets / NUGGETS_PER_ORE);
  return `パール ${have}/${PEARL_TARGET}（あと ${missing} 個）: エンダーマン 1 体で平均 ${PEARLS_PER_ENDERMAN} 個（あと 約 ${Math.ceil(missing / PEARLS_PER_ENDERMAN)} 体）。`
    + `ピグリンとの交換は金の延べ棒 ${GOLD_PER_PEARL} 個（金塊 約 ${nuggets} 個・ネザー金鉱石 約 ${ores} 個）で平均 1 個、`
    + `持っている金の延べ棒 ${gold} 個では平均 約 ${trade} 個`;
}
