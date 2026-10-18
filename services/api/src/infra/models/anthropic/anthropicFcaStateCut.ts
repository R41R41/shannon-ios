import { itemKey, partKey } from './anthropicFcaStoredState.js';

/**
 * Shortening a transient request that does not fit, the way a legacy decision message is (`compactedDecision`), with the owner's rule
 * that everything legacy sent reaches the model unless the request cannot fit. "Fits" is the caller's (`anthropicFcaTransientRequest.ts`):
 * the WHOLE request (the core, the replay, this step's stored state, the tool additions and the live state) is within
 * `compactAboveTokens` (95,000: under the 100,000-token price step), and the replay this step leaves can take another step.
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

type Row = Record<string, unknown>;
export interface Levels { catalog: number | null; state: number | null; live: number | null }
export interface CutResult { row: Row; live: Row; levels: Levels; over: boolean; cut: boolean }
/** Whether the request fits with this stored state and this live state. */
export type Fits = (row: Row, live: Row) => boolean;

/** A string cut to `level` characters and marked, never inside a surrogate pair; as it was when the cut would not shorten it. */
function cutString(value: string, level: number): string {
  if (value.length <= level) return value;
  const keep = Math.max(0, /[\uD800-\uDBFF]/u.test(value[level - 1] ?? '') ? level - 1 : level);
  const cut = `${value.slice(0, keep)}${CUT(value.length - keep)}`;
  return cut.length < value.length ? cut : value;
}
function cutAll(value: unknown, level: number): unknown {
  if (typeof value === 'string') return cutString(value, level);
  if (Array.isArray(value)) return value.map(item => cutAll(item, level));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutAll(item, level)]));
  return value;
}
const longest = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return Math.max(0, ...value.map(longest));
  return value && typeof value === 'object' ? Math.max(0, ...Object.values(value).map(longest)) : 0;
};
const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const asItems = (value: unknown): Row[] => Array.isArray(value) ? value.filter(isRow) : [];

/** Every catalog item the row states (the whole list, or what was added or changed). */
function catalogItems(row: Row): Row[] {
  const changes = isRow(row.catalogChanges) ? row.catalogChanges : {};
  return [...asItems(row.catalog), ...asItems(changes.added), ...asItems(changes.changed)];
}

/** The row's catalog items with their descriptions cut to `level`; the items cut are named, by the digest of the whole item. */
function cutCatalog(row: Row, level: number): { row: Row; cappedCatalog: Record<string, string> } {
  const cappedCatalog: Record<string, string> = {};
  const items = (list: unknown) => asItems(list).map(item => {
    if (typeof item.description !== 'string') return item;
    const cut = { ...item, description: cutString(item.description, level) };
    if (cut.description === item.description) return item;
    cappedCatalog[String(item.name)] = itemKey(item);
    return cut;
  });
  const next: Row = { ...row };
  if (Array.isArray(row.catalog)) next.catalog = items(row.catalog);
  if (isRow(row.catalogChanges)) {
    const { added, changed } = row.catalogChanges;
    next.catalogChanges = { ...row.catalogChanges, ...(added ? { added: items(added) } : {}), ...(changed ? { changed: items(changed) } : {}) };
  }
  return { row: next, cappedCatalog };
}

/** The row and live state at these levels, the parts cut named. */
function applied(row: Row, live: Row, levels: Levels): { row: Row; live: Row } {
  const catalog = levels.catalog === null ? { row: { ...row }, cappedCatalog: {} } : cutCatalog(row, levels.catalog);
  const next = catalog.row, capped: Record<string, string> = {};
  for (const key of STATE_CUTTABLE) {
    if (levels.state === null || !(key in row)) continue;
    next[key] = cutAll(row[key], levels.state);
    if (JSON.stringify(next[key]) !== JSON.stringify(row[key])) capped[key] = partKey(key, row[key]);
  }
  if (Object.keys(capped).length) next.capped = { ...(isRow(row.capped) ? row.capped : {}), ...capped };
  if (Object.keys(catalog.cappedCatalog).length) next.cappedCatalog = { ...(isRow(row.cappedCatalog) ? row.cappedCatalog : {}), ...catalog.cappedCatalog };
  const level = levels.live;
  const nextLive = level === null ? live
    : Object.fromEntries(Object.entries(live).map(([key, value]) => [key, LIVE_KEPT.has(key) ? value : cutAll(value, level)]));
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

/** The longest text of the live state that a cut can shorten. */
const longestLive = (live: Row) => Math.max(0, ...Object.entries(live).map(([key, value]) => LIVE_KEPT.has(key) ? 0 : longest(value)));

/** The row and live state to send: as given while they fit, else cut as the stages above say. */
export function cutToFit(row: Row, live: Row, fits: Fits): CutResult {
  const levels: Levels = { catalog: null, state: null, live: null };
  const fitsAt = (at: Levels) => {
    const candidate = applied(row, live, at);
    return fits(candidate.row, candidate.live);
  };
  const result = (over: boolean): CutResult => ({ ...applied(row, live, levels), levels: { ...levels }, over,
    cut: levels.catalog !== null || levels.state !== null || levels.live !== null });
  if (fitsAt(levels)) return result(false);
  const descriptions = Math.max(0, ...catalogItems(row).map(item => typeof item.description === 'string' ? item.description.length : 0));
  const stateTexts = Math.max(0, ...STATE_CUTTABLE.map(key => longest(row[key]))), liveTexts = longestLive(live);
  // Each stage: to its floor; if that fits, the highest level above it that still does; else go on with the floor in place.
  const stage = (key: keyof Levels, floor: number, top: number): boolean => {
    if (top <= floor) return false;
    levels[key] = floor;
    if (!fitsAt(levels)) return false;
    levels[key] = highest(floor, top, level => fitsAt({ ...levels, [key]: level }));
    return true;
  };
  if (stage('catalog', CATALOG_FLOOR, descriptions) || stage('state', TEXT_FLOOR, stateTexts) || stage('live', TEXT_FLOOR, liveTexts)) return result(false);
  levels.catalog = descriptions > 0 ? 0 : levels.catalog;
  if (fitsAt(levels)) {
    levels.catalog = highest(0, CATALOG_FLOOR, level => fitsAt({ ...levels, catalog: level }));
    return result(false);
  }
  if (stateTexts > 0) levels.state = 0;
  if (liveTexts > 0) levels.live = 0;
  return result(!fitsAt(levels));
}
