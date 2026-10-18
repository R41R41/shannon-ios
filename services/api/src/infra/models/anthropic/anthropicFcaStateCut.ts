import { itemKey, partKey } from './anthropicFcaStoredState.js';

/**
 * Shortening a transient request that would pass `compactAboveTokens` (95,000: under the 100,000-token price step), the way a legacy
 * decision message is (`compactedDecision`), with the owner's rule that everything legacy sent reaches the model unless the request
 * cannot fit. The request is the whole of it: the core, the replay, this step's stored state, the tool additions and the live state.
 *
 * Nothing is cut while the request fits. Otherwise, in this order, each stage only after the one before is at its floor:
 *   1. the catalog items' descriptions (never an item's name), to the highest common length that fits, down to `CATALOG_FLOOR`;
 *   2. the long texts of the stored state's other parts (the shared context, the goal progress; never the skill index, the task,
 *      the messages or the children);
 *   3. the long texts of the live state (the body's observation and the rest; never the clock or the wait fact);
 *   4. the catalog descriptions below their floor, down to nothing: names only;
 *   5. the long texts of the state and of the live state, down to nothing.
 * If it still does not fit the request is sent as it is and says so (`over`). A part cut is named in the state (`capped`, `cappedCatalog`)
 * with the digest of its whole, so that a later state restates it whole once it fits.
 */
export const CATALOG_FLOOR = 120, TEXT_FLOOR = 400;
const CUT = (omitted: number) => `…（長いため後略: ${omitted}字）`;
const STATE_CUTTABLE = ['sharedContext', 'progress'] as const;
const LIVE_KEPT = new Set(['ownerClock', 'waiting']);

export interface Levels { catalog: number | null; state: number | null; live: number | null }
export interface CutResult { row: Record<string, unknown>; live: Record<string, unknown>; levels: Levels; over: boolean; cut: boolean }

/** A string cut to `level` characters and marked, never inside a surrogate pair; as it was when the cut would not shorten it. */
function cutString(value: string, level: number): string {
  if (value.length <= level) return value;
  const keep = /[\uD800-\uDBFF]/u.test(value[level - 1] ?? '') ? level - 1 : level;
  const cut = `${value.slice(0, Math.max(0, keep))}${CUT(value.length - Math.max(0, keep))}`;
  return cut.length < value.length ? cut : value;
}
function cutAll(value: unknown, level: number): unknown {
  if (typeof value === 'string') return cutString(value, level);
  if (Array.isArray(value)) return value.map(item => cutAll(item, level));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutAll(item, level)]));
  return value;
}
const longest = (value: unknown): number => typeof value === 'string' ? value.length
  : Array.isArray(value) ? Math.max(0, ...value.map(longest))
    : value && typeof value === 'object' ? Math.max(0, ...Object.values(value).map(longest)) : 0;
const asItems = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];

/** Every catalog item the row states (the whole list, or what was added or changed). */
const catalogLists = (row: Record<string, unknown>): Array<Record<string, unknown>[]> => {
  const changes = row.catalogChanges as { added?: unknown; changed?: unknown } | undefined;
  return [asItems(row.catalog), asItems(changes?.added), asItems(changes?.changed)];
};

/** The row and live state at these levels, the parts cut named. */
function applied(row: Record<string, unknown>, live: Record<string, unknown>, levels: Levels): { row: Record<string, unknown>; live: Record<string, unknown> } {
  const next: Record<string, unknown> = { ...row }, capped: Record<string, string> = {}, cappedCatalog: Record<string, string> = {};
  const items = (list: unknown) => asItems(list).map(item => {
    const cut = typeof item.description === 'string' && levels.catalog !== null ? { ...item, description: cutString(item.description, levels.catalog) } : item;
    if (cut !== item && JSON.stringify(cut) !== JSON.stringify(item)) cappedCatalog[String(item.name)] = itemKey(item);
    return cut;
  });
  if (Array.isArray(row.catalog)) next.catalog = items(row.catalog);
  const changes = row.catalogChanges as Record<string, unknown> | undefined;
  if (changes) next.catalogChanges = { ...changes, ...(changes.added ? { added: items(changes.added) } : {}), ...(changes.changed ? { changed: items(changes.changed) } : {}) };
  if (levels.state !== null) {
    for (const key of STATE_CUTTABLE) {
      if (!(key in row)) continue;
      next[key] = cutAll(row[key], levels.state);
      if (JSON.stringify(next[key]) !== JSON.stringify(row[key])) capped[key] = partKey(key, row[key]);
    }
  }
  if (Object.keys(capped).length) next.capped = { ...(row.capped as object | undefined), ...capped };
  if (Object.keys(cappedCatalog).length) next.cappedCatalog = { ...(row.cappedCatalog as object | undefined), ...cappedCatalog };
  const nextLive = levels.live === null ? live : Object.fromEntries(Object.entries(live).map(([key, value]) => [key, LIVE_KEPT.has(key) ? value : cutAll(value, levels.live!)]));
  return { row: next, live: nextLive };
}

/** The highest level in [low, high] at which `fits` holds, given that it holds at `low`. */
function highest(low: number, high: number, fits: (level: number) => boolean): number {
  let best = low;
  for (let at = low, top = high; at < top;) {
    const level = Math.ceil((at + top) / 2);
    if (fits(level)) {
      at = level;
      best = level;
    } else top = level - 1;
  }
  return best;
}

/**
 * The row and live state to send: as given while `cost` (the whole request's estimated tokens with them) is within `maximum`, else
 * cut as the stages above say.
 */
export function cutToFit(row: Record<string, unknown>, live: Record<string, unknown>,
  cost: (row: Record<string, unknown>, live: Record<string, unknown>) => number, maximum: number): CutResult {
  const levels: Levels = { catalog: null, state: null, live: null };
  const fits = (at: Levels) => { const candidate = applied(row, live, at); return cost(candidate.row, candidate.live) <= maximum; };
  const result = (over: boolean): CutResult => ({ ...applied(row, live, levels), levels: { ...levels }, over, cut: levels.catalog !== null || levels.state !== null || levels.live !== null });
  if (fits(levels)) return result(false);
  const descriptions = Math.max(0, ...catalogLists(row).flat().map(item => typeof item.description === 'string' ? item.description.length : 0));
  const stateTexts = Math.max(0, ...STATE_CUTTABLE.map(key => longest(row[key]))), liveTexts = Math.max(0, ...Object.entries(live).map(([key, value]) => LIVE_KEPT.has(key) ? 0 : longest(value)));
  // Each stage: to its floor; if that fits, the highest level above it that still does; else go on with the floor in place.
  const stage = (key: keyof Levels, floor: number, top: number): boolean => {
    if (top <= floor) return false;
    levels[key] = floor;
    if (!fits(levels)) return false;
    levels[key] = highest(floor, top, level => fits({ ...levels, [key]: level }));
    return true;
  };
  if (stage('catalog', CATALOG_FLOOR, descriptions) || stage('state', TEXT_FLOOR, stateTexts) || stage('live', TEXT_FLOOR, liveTexts)) return result(false);
  levels.catalog = descriptions > 0 ? 0 : levels.catalog;
  if (fits(levels)) {
    levels.catalog = highest(0, CATALOG_FLOOR, level => fits({ ...levels, catalog: level }));
    return result(false);
  }
  if (stateTexts > 0) levels.state = 0;
  if (liveTexts > 0) levels.live = 0;
  return result(!fits(levels));
}
