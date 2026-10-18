import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import { trimLevels, trimLive } from './anthropicFcaLiveTrim.js';
import { itemKey, partKey } from './anthropicFcaStoredState.js';

/**
 * Shortening a transient request that does not fit, the way a legacy decision message is (`compactedDecision`), with the owner's rule
 * that everything legacy sent reaches the model unless the request cannot fit. "Fits" is the caller's (`anthropicFcaTransientRequest.ts`):
 * the WHOLE request (the core, the replay, this step's stored state, the tool additions and the live state) is within
 * `compactAboveTokens` (95,000: under the 100,000-token price step), and the replay this step leaves can take another step.
 *
 * Nothing is cut while the request fits. What is stored (the catalog, the other parts) costs again every step it is restated and is
 * read by every later step, and the live state is read by this step alone; so a live state larger than a typical one (`LIVE_TYPICAL_TOKENS`,
 * a spike) gives way first, and only down to a typical size. Otherwise, in this order, each stage only after the one before is at its floor
 * (review 4, M2/M3):
 *   1. a live spike, to the size of a typical live state: first its long texts (the gists), down to `TEXT_FLOOR` at the lowest, then the
 *      low-value structure of the body's observation (the farther entities and the later facts, `anthropicFcaLiveTrim.ts`), each only as
 *      far as the size needs (review 5, L-3: a gist's tail costs the model less than the entities and facts it sees nowhere else). A live
 *      state that is not above a typical one is left whole here;
 *   2. the catalog items' descriptions (never an item's name), to the highest common length that fits, down to `CATALOG_FLOOR`;
 *   3. the long texts of the stored state's other parts (the shared context, the goal progress; never the skill index, the task,
 *      the messages or the children), down to `TEXT_FLOOR`;
 *   4. the live state again, as far as it takes: the structure, then the long texts, never below `TEXT_FLOOR` (a text of 400 characters or
 *      less is never touched, so a name, a pointer, an inventory entry or a tool name always arrives; the pointers, the gists' skill names,
 *      the inventory, the kinds and the tool names are never cut even when long; never the clock or the wait fact);
 *   5. the catalog descriptions below their floor, down to nothing: names only;
 *   6. the long texts of the stored state, down to nothing.
 * If it still does not fit the request is sent as it is and says so (`over`). A part cut is named in the state (`capped`, `cappedCatalog`)
 * with the digest of its whole, so that a later state restates it whole once it fits.
 */
export const CATALOG_FLOOR = 120, TEXT_FLOOR = 400;
/** What a typical live state takes of a request (estimated tokens): a live state above it is a spike. */
export const LIVE_TYPICAL_TOKENS = 10_000;
const CUT = (omitted: number) => `…（長いため後略: ${omitted}字）`;
const STATE_CUTTABLE = ['sharedContext', 'progress'] as const;
const LIVE_KEPT = new Set(['ownerClock', 'waiting']);
/** Under these keys of a live state a text is never cut: what the model names or calls by (pointers, skill, tool and item names). */
const LIVE_NAMES = new Set(['skillPointers', 'skill', 'tool', 'name', 'kind', 'inventory']);

type Row = Record<string, unknown>;
export interface Levels { catalog: number | null; state: number | null; live: number | null; trim: number | null }
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
/** Every string cut to `level`; with `names`, not those under a key of `LIVE_NAMES`. */
function cutAll(value: unknown, level: number, names = false): unknown {
  if (typeof value === 'string') return cutString(value, level);
  if (Array.isArray(value)) return value.map(item => cutAll(item, level, names));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, names && LIVE_NAMES.has(key) ? item : cutAll(item, level, names)]));
  }
  return value;
}
const longest = (value: unknown, names = false): number => {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return Math.max(0, ...value.map(item => longest(item, names)));
  return value && typeof value === 'object'
    ? Math.max(0, ...Object.entries(value).map(([key, item]) => names && LIVE_NAMES.has(key) ? 0 : longest(item, names))) : 0;
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

/** The live state at these levels: its structure trimmed, then its long texts cut (not the clock or the wait fact, not a name). */
function appliedLive(live: Row, levels: Levels): Row {
  const trimmed = levels.trim === null ? live : trimLive(live, levels.trim);
  const level = levels.live;
  return level === null ? trimmed
    : Object.fromEntries(Object.entries(trimmed).map(([key, value]) => [key, LIVE_KEPT.has(key) ? value : cutAll(value, level, true)]));
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
  return { row: next, live: appliedLive(live, levels) };
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
const longestLive = (live: Row) => Math.max(0, ...Object.entries(live).map(([key, value]) => LIVE_KEPT.has(key) ? 0 : longest(value, true)));

/** The row and live state to send: as given while they fit, else cut as the stages above say. */
export function cutToFit(row: Row, live: Row, fits: Fits): CutResult {
  const levels: Levels = { catalog: null, state: null, live: null, trim: null };
  const fitsAt = (at: Levels) => {
    const candidate = applied(row, live, at);
    return fits(candidate.row, candidate.live);
  };
  const result = (over: boolean): CutResult => ({ ...applied(row, live, levels), levels: { ...levels }, over,
    cut: levels.catalog !== null || levels.state !== null || levels.live !== null || levels.trim !== null });
  if (fitsAt(levels)) return result(false);
  const descriptions = Math.max(0, ...catalogItems(row).map(item => typeof item.description === 'string' ? item.description.length : 0));
  const stateTexts = Math.max(0, ...STATE_CUTTABLE.map(key => longest(row[key])));
  const trims = trimLevels(live);
  const tokensOf = (at: Levels) => estimatedAnthropicTokens(JSON.stringify(applied(row, live, at).live));
  // Each stage: to its floor; if that fits, the highest level above it that still does; else go on with the floor in place.
  const stage = (key: 'catalog' | 'state', floor: number, top: number): boolean => {
    if (top <= floor) return false;
    levels[key] = floor;
    if (!fitsAt(levels)) return false;
    levels[key] = highest(floor, top, level => fitsAt({ ...levels, [key]: level }));
    return true;
  };
  /** The long texts of the live state cut to the floor and then as high as `goal` allows; false when even the floor does not reach it. */
  const cutTexts = (goal: (at: Levels) => boolean): boolean => {
    const texts = longestLive(applied(row, live, { ...levels, live: null }).live);
    if (texts <= TEXT_FLOOR) return goal(levels);
    levels.live = TEXT_FLOOR;
    if (!goal(levels)) return false;
    levels.live = highest(TEXT_FLOOR, texts, level => goal({ ...levels, live: level }));
    return true;
  };
  /**
   * The gentlest shrink of the live state at which `goal` holds, the other levels as they stand; when none does, the deepest shrink there
   * is. True when the goal holds. By default the structure goes first (the far entities and the late facts), then the long texts down to
   * the floor. With `textsFirst` the long texts go first, down to the floor, and only then the structure (review 5, L-3: in a spike, a gist's
   * tail is worth less than the entities and facts of the observation, which have no copy beyond this request).
   */
  const shrinkLive = (goal: (at: Levels) => boolean, textsFirst = false): boolean => {
    levels.trim = null;
    levels.live = null;
    if (textsFirst) {
      if (cutTexts(goal)) return true;
      for (const level of trims) {
        if (goal({ ...levels, trim: level })) {
          levels.trim = level;
          return true;
        }
      }
      levels.trim = trims.length ? trims[trims.length - 1]! : null;
      return false;
    }
    for (const level of trims) {
      if (goal({ ...levels, trim: level })) {
        levels.trim = level;
        return true;
      }
    }
    levels.trim = trims.length ? trims[trims.length - 1]! : null;
    return cutTexts(goal);
  };
  if (tokensOf(levels) > LIVE_TYPICAL_TOKENS) {
    // A spike gives way to a typical live state, or to the size at which the request fits, whichever comes first.
    shrinkLive(at => fitsAt(at) || tokensOf(at) <= LIVE_TYPICAL_TOKENS, true);
    if (fitsAt(levels)) return result(false);
  }
  if (stage('catalog', CATALOG_FLOOR, descriptions) || stage('state', TEXT_FLOOR, stateTexts)) return result(false);
  if (shrinkLive(fitsAt)) return result(false);
  levels.catalog = descriptions > 0 ? 0 : levels.catalog;
  if (fitsAt(levels)) {
    levels.catalog = highest(0, CATALOG_FLOOR, level => fitsAt({ ...levels, catalog: level }));
    return result(false);
  }
  if (stateTexts > 0) levels.state = 0;
  return result(!fitsAt(levels));
}
