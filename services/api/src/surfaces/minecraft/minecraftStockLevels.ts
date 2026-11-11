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
  return `木 ${stock}/最低 ${min} は満たす・安心 ${safe} まであと ${gap}${nearWords ? `（${nearWords}）` : ''}${count > 0 ? ` → 取り切ってから進む（count=${count}）` : ''}`;
}
