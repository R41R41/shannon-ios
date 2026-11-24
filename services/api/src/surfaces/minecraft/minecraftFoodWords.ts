/**
 * Run 43 (2026-10-27): the pack's food was 39.6 points; the plan's condition `food>=40` judged it short, and the live said 「食料 40/40 点」 (the
 * meter, the plan's now) beside 「食料 39.6 点」 (recovery). The node of the preparation stayed the now for 2,126 s, its meter 「1,801 秒遅れ」, while
 * the model read the food as met. Every line says the food points as the conditions judge them (one decimal, the same value), and what is short
 * with what fills it.
 */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** One food that fills a gap of points (the smallest that does, of foods a village or a hunt gives; the pack's own food is already counted). */
const FILLERS: ReadonlyArray<readonly [string, number]> = [['potato', 1.6], ['sweet_berries', 2.4], ['apple', 6.4], ['bread', 11], ['cooked_beef', 20.8]];
/** A gap this small (an apple's worth) is filled by any one food: the meat is named only for a larger one. */
const TRIVIAL_GAP = 6.4;
/** What cooking the raw meat she carries would add (`cookingOf`): the points gained and the seconds in one furnace. */
export interface CookingGain { gain: number; seconds: number }
export function foodFill(gap: number, cook?: CookingGain | null): string {
  // (a request to fight: 12.8 points carried as raw mutton, 62 if cooked, and the line said bread 3): the meat she carries comes first, since cooking it
  // costs 10 seconds a piece in a furnace and needs no hunt.
  if (cook && gap > TRIVIAL_GAP && cook.gain >= gap - 1e-9) return `持っている生肉を焼く（+${round1(cook.gain)} 点・かまど 1 基で ${cook.seconds} 秒）`;
  const one = FILLERS.find(([, points]) => points >= gap - 1e-9);
  const rest = one ? `${one[0]} 1 個` : `bread ${Math.ceil(gap / 11 - 1e-9)} 個`;
  return cook && gap > TRIVIAL_GAP && cook.gain > 0 ? `持っている生肉を焼いて +${round1(cook.gain)} 点（${cook.seconds} 秒）、足りない分は ${rest}` : rest;
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

/**
 * The village's hay as a fact beside the points (run 8, 2026-11-13: hay stood near and only the least was taken): said only while the body counts hay near.
 * One hay block is three bread, about 33 points; the hand and the amount are the model's.
 */
export function villageHayWords(hay: number | null | undefined): string {
  if (hay === null || hay === undefined || hay <= 0) return '';
  return `村の干し草 ${hay} 個＝約 ${Math.round(hay * 33)} 点（1 個 2〜3 秒・下りると戻らない・必要は ネザー奥 100〜200・エンド 330）`;
}

/** The food points as every line says them: 「食料 39.6 点」, or against a need 「食料 39.6/40 点（あと 0.4 点: potato 1 個）」; the village's hay (when near) after the safe amount. */
export function foodPointsWords(food: number, need?: number, hay?: number | null, cook?: CookingGain | null): string {
  const have = round1(food);
  if (need === undefined) return `食料 ${have} 点`;
  if (have >= need) {
    const comfort = foodComfort(need);
    if (comfort === null || have >= comfort) return `食料 ${have}/${need} 点`;
    const hayWords = villageHayWords(hay);
    return `食料 ${have}/${need} 点・安心 ${comfort} 点まであと ${round1(comfort - have)} 点${hayWords ? `（${hayWords}）` : ''}`;
  }
  const gap = round1(need - have);
  return `食料 ${have}/${need} 点（あと ${gap} 点: ${foodFill(gap, cook)}）`;
}
