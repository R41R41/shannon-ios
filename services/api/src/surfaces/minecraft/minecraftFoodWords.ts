/**
 * Run 43 (2026-10-27): the pack's food was 39.6 points; the plan's condition `food>=40` judged it short, and the live said 「食料 40/40 点」 (the
 * meter, the plan's now) beside 「食料 39.6 点」 (recovery). The node of the preparation stayed the now for 2,126 s, its meter 「1,801 秒遅れ」, while
 * the model read the food as met. Every line says the food points as the conditions judge them (one decimal, the same value), and what is short
 * with what fills it.
 */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** One food that fills a gap of points (the smallest that does, of foods a village or a hunt gives; the pack's own food is already counted). */
const FILLERS: ReadonlyArray<readonly [string, number]> = [['potato', 1.6], ['sweet_berries', 2.4], ['apple', 6.4], ['bread', 11], ['cooked_beef', 20.8]];
export function foodFill(gap: number): string {
  const one = FILLERS.find(([, points]) => points >= gap - 1e-9);
  return one ? `${one[0]} 1 個` : `bread ${Math.ceil(gap / 11 - 1e-9)} 個`;
}

/**
 * The safe amount beside a least (2026-11-11, run 7: the least was all the plan said): the preparation's 40 is safe at 100, the gate's 100 at 150, the Nether's depth
 * 200 at 300 and the End's 330 at 400. Said only once the least is met (below it the line is as it was). Null for a need that is not one of the gates'.
 */
export function foodComfort(need: number): number | null {
  if (need === 40) return 100;
  if (need === 100) return 150;
  if (need === 200) return 300;
  return need === 330 ? 400 : null;
}

/** The food points as every line says them: 「食料 39.6 点」, or against a need 「食料 39.6/40 点（あと 0.4 点: potato 1 個）」. */
export function foodPointsWords(food: number, need?: number): string {
  const have = round1(food);
  if (need === undefined) return `食料 ${have} 点`;
  if (have >= need) {
    const comfort = foodComfort(need);
    return comfort !== null && have < comfort ? `食料 ${have}/${need} 点・安心 ${comfort} 点まであと ${round1(comfort - have)} 点（bread ${Math.ceil((comfort - have) / 11 - 1e-9)} 個＝干し草 ${Math.ceil((comfort - have) / 33 - 1e-9)} 個）` : `食料 ${have}/${need} 点`;
  }
  const gap = round1(need - have);
  return `食料 ${have}/${need} 点（あと ${gap} 点: ${foodFill(gap)}）`;
}
