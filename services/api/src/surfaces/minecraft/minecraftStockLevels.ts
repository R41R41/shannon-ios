/**
 * Two amounts for a stock, the least that lets the work go on and the amount that is safe (the owner, 2026-11-11, run 7: 「集める原木が足りない。
 * 近くにたくさんあるのに最低限しか集めてない。最低限の量とこれだけあれば安心という量を両方書くべき」). Wood is counted in logs: a log is 1, four planks
 * make a log's worth, eight sticks too (what was burnt or put down as a table does not come back).
 * - min 12: planks 34〜36 (about 9 logs) and 3 spare: three tables (12 planks), the wooden pickaxe (3 + 2 sticks), the sticks of the stone and iron tools (3),
 *   a shield (6), a chest (8). Run 7 spent five logs on tables alone.
 * - safe 24: the min plus the bed's planks, a table made again, fuel while there is no coal, a boat. Run 7 used 15〜19.
 * - food, for the lines that say the points: min is the gate's 40; safe 100 is three hay bales or five cooked cows.
 */
export const STOCK_LEVELS = { wood: { min: 12, safe: 24 }, food: { min: 40, safe: 100 } } as const;

import { villageHayWords } from './minecraftFoodWords.js';
import { nearbyResourcesOf } from './minecraftLlmcNearby.js';

/** The wood she carries in logs: logs, a quarter for planks, an eighth for sticks (rounded down). */
export function woodLogs(counts: ReadonlyMap<string, number>): number {
  const of = (item: string) => [...counts].reduce((sum, [name, count]) => sum + (name === item || name.endsWith(`_${item}`) ? count : 0), 0);
  return Math.floor(of('log') + of('planks') / 4 + of('stick') / 8);
}

/** What the body counted of logs near her (`state.world.woodNear`: the logs within `withinM` metres, and the trees they make). */
export interface WoodNear { logs: number; trees: number; withinM: number }
export function woodNearOf(raw: unknown): WoodNear | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const near = raw as Record<string, unknown>, ok = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return ok(near.logs) && ok(near.trees) && ok(near.withinM) ? { logs: near.logs, trees: near.trees, withinM: near.withinM } : null;
}

/**
 * The logs near her from the nearby count's wood entry (`nearbyResources`), for a body that sends no `woodNear`: the one count the live state reads, so the
 * body need not send the same logs twice. The entry has no trees field in an older body: the trees are then the sites it names.
 */
export function woodNearFromResources(raw: unknown): WoodNear | null {
  const wood = nearbyResourcesOf(raw).find(item => item.purpose === 'wood');
  return wood ? { logs: Math.max(0, wood.count), trees: wood.trees ?? wood.sites.length, withinM: wood.range } : null;
}

/**
 * Whether the wood is enough to go on: at the safe amount, or at the min with no more near enough to reach it (the logs near are fewer than the
 * gap). A frame without the count of the logs near is judged by the min.
 */
export function woodEnough(stock: number, near: WoodNear | null | undefined): boolean {
  const { min, safe } = STOCK_LEVELS.wood;
  if (stock >= safe) return true;
  return stock >= min && (!near || near.logs < safe - stock);
}

/** The state of the wood as one phrase for the plan's now (the amounts and what is near, so that the count of a `mine` can be read off it). */
export function woodStockWords(stock: number, near: WoodNear | null | undefined): string {
  const { min, safe } = STOCK_LEVELS.wood, gap = safe - stock;
  const nearWords = near ? near.logs > 0 ? `近くに原木 ${near.logs} 本（木 ${near.trees} 本・${near.withinM}m 内）` : `${near.withinM}m 内に原木なし` : '';
  const count = near ? Math.min(gap, near.logs) : gap;
  if (stock < min) return `木 ${stock}/最低 ${min}（安心 ${safe}）${nearWords ? `。${nearWords}` : ''}${count > 0 ? ` → mine count=${count} が目安` : ''}`;
  return `木 ${stock}/最低 ${min} は満たす・安心 ${safe} まであと ${gap}${nearWords ? `（${nearWords}）` : ''}${count > 0 ? ` → 取り切ってから進む（count=${count}。取れない分は数えず、取れる分で set state=done 可）` : ''}`;
}

/** The food animals and the village's food near her, from the body's `nearbyResources`; null when the frame has no such count (judged by the min then). */
export function foodNearOf(raw: unknown): number | null {
  const items = nearbyResourcesOf(raw);
  if (!items.length) return null;
  return items.filter(item => item.purpose === 'food_animal' || item.purpose === 'food_village').reduce((sum, item) => sum + Math.max(0, item.count), 0);
}

/** The village's food near her (hay, fields, crops) and the hay alone, from the body's `nearbyResources`; null when the frame has no such count. */
export function villageFoodOf(raw: unknown): { food: number; hay: number } | null {
  const items = nearbyResourcesOf(raw);
  if (!items.length) return null;
  const village = items.filter(item => item.purpose === 'food_village');
  const sum = (list: typeof village) => list.reduce((total, item) => total + Math.max(0, item.count), 0);
  return { food: sum(village), hay: sum(village.filter(item => item.kind.includes('干し草') || item.kind.includes('hay'))) };
}

/**
 * `stock:food` (run 7: food, like wood, stopped at the least while animals and hay stood near): at the safe amount, or at the least with no food near
 * (or no count of it: judged by the min). Closes by points, so the node stays open while food is near and the points are under 100.
 */
export function foodEnough(points: number, near: number | null | undefined): boolean {
  const { min, safe } = STOCK_LEVELS.food;
  if (points >= safe) return true;
  return points >= min && (near === null || near === undefined || near <= 0);
}

export function foodStockWords(points: number, near: number | null | undefined, hay?: number | null): string {
  const { min, safe } = STOCK_LEVELS.food, have = Math.round(points * 10) / 10;
  const hayWords = villageHayWords(hay);
  const nearWords = (near === null || near === undefined ? '' : near > 0 ? `（近くに食料 ${near}）` : '（近くに食料なし）') + (hayWords ? `。${hayWords}` : '');
  if (points < min) return `食料 ${have}/最低 ${min}（安心 ${safe}）${nearWords}`;
  if (points >= safe) return `食料 ${have}/安心 ${safe} を満たす${nearWords}`;
  return `食料 ${have}/最低 ${min} は満たす・安心 ${safe} まであと ${Math.round((safe - points) * 10) / 10}${nearWords}。近くに無ければ（取れなければ）済みにしてよい`;
}
