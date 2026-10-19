/**
 * A count a day that has no limit unless the owner sets one (owner decision 2026-10-03: 「コストの範囲内なら、好きなだけ」).
 * Unset, empty or `unlimited`: no limit (`Infinity`). `0`, and the words every other switch takes for off (`off`, `false`,
 * `disabled`, `none`): switched off. A positive whole number: that many a day. Anything else cannot be read and switches
 * it off: a value nobody can make sense of must not mean "as many as she likes".
 */
export function dailyCount(value: string | undefined, unset = Number.POSITIVE_INFINITY): number {
  const text = value?.trim().toLowerCase() ?? '';
  if (!text) return unset;
  if (text === 'unlimited') return Number.POSITIVE_INFINITY;
  const parsed = /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(100_000, Math.trunc(parsed)) : 0;
}
