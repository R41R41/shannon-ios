/** Facts about food made from carried ingredients. These are possibilities, never current food or a command to cook. */
export const COOKED_FOOD: Readonly<Record<string, string>> = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato',
};

export function foodPreparation(counts: ReadonlyMap<string, number>, currentPoints: number, values: Readonly<Record<string, number>>) {
  const countOf = (name: string) => {
    const value = counts.get(name) ?? 0;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  const raw = Object.entries(COOKED_FOOD).flatMap(([item, cooked]) => {
    const count = countOf(item), before = values[item], after = values[cooked];
    return count && Number.isFinite(before) && Number.isFinite(after) ? [{ item, count, cooked,
      pointsNow: Math.round(before * count * 10) / 10, pointsIfCooked: Math.round(after * count * 10) / 10 }] : [];
  });
  const bread = Math.floor((countOf('wheat') + countOf('hay_block') * 9) / 3);
  if (!raw.length && !bread) return null;
  const gained = raw.reduce((sum, item) => sum + item.pointsIfCooked - item.pointsNow, 0) + bread * (values.bread ?? 0);
  return {
    raw, ...(bread ? { breadFromCarriedWheatAndHay: bread } : {}),
    pointsIfPrepared: Math.round((currentPoints + gained) * 10) / 10,
    cookSecondsInOneFurnace: raw.reduce((sum, item) => sum + item.count * 10, 0),
    smeltsFromCarriedCoal: (countOf('coal') + countOf('charcoal')) * 8,
    unprepared: true,
  };
}
