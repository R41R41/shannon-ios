import type { ActHand, ActInput } from '../../contracts/minecraftActContract.js';
import { stopsOf, triedAgain } from './minecraftLlmcRepeat.js';
import { SOLID } from './minecraftLlmcPreflightMap.js';
import type { P } from './minecraftLlmcWalkRules.js';

/**
 * 2026-11-13 (flow design D, run 9: the water section took 238 s, about 11 not_filled stops on one underground pool whose wall the body could not
 * see past, and two `replace` hands cancelled a walk to the surface water): when a bucket cannot draw one pool twice, the pool is said to be given
 * up, the surface sources are listed instead, and a walk to the surface water is not cancelled by a retry of the underground one.
 * By the count of the failure and the distance of the source only (never a place or a time): a pool is every source within `SAME_POOL` m of a
 * cell that failed. The body's own counts come first (`body.stops`, `lastResults`: `triedAgain`); nothing here sends or stops a hand.
 */
type Rec = Record<string, unknown>;
export const SAME_POOL = 4;
/** Failures of one pool in a row after which the pool is given up. */
export const GIVE_UP_AT = 2;
/** The surface: a source at this height or above is a pond or the sea, reached by a way up (the pools of caves lie below). */
export const SURFACE_Y = 50;
export interface WaterFail { cell: P | null; count: number }

const CELL = /^(-?\d+),(-?\d+),(-?\d+)$/u;
const cellOf = (text: string | null): P | null => {
  const m = text ? CELL.exec(text) : null;
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** What the map shows over a cell: `symbol` of the act's map view (undefined where the map does not reach). */
export interface SkyView { symbol(x: number, y: number, z: number): string | undefined }
/** What `givenUp` may read besides the counts: the map (a rock over the source says it is underground) and her feet (a failure whose cell is not known). */
export interface WaterContext { view?: SkyView | null; feet?: P | null }
const ROOF_LOOK = 10;
/** A source is underground when the map shows rock over it (a cave inside a mountain above `SURFACE_Y`); with no rock on the map, by its height. */
export function isUnderground(at: P, view?: SkyView | null): boolean {
  if (view) for (let dy = 1; dy <= ROOF_LOOK; dy += 1) { const symbol = view.symbol(at.x, at.y + dy, at.z); if (symbol !== undefined && SOLID.has(symbol)) return true; }
  return at.y < SURFACE_Y;
}

const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const POOL_TEXT = /この水（4 マス以内の別の源を含む）(?:で (\d+) 回目|へは (\d+) 回汲めなかった)/u;
/**
 * The pools a bucket could not draw (not_filled at least `GIVE_UP_AT` times in all), from the body's counts: the stops of each cell, the pool's own count in
 * the body's words 「この水（4 マス以内の別の源を含む）で N 回目」, and the failures of neighbouring sources (within `SAME_POOL`) added together.
 */
export function waterFailures(body: Rec): WaterFail[] {
  const cells = new Map<string, { cell: P; count: number }>();
  const note = (cell: P | null, count: number) => {
    if (!cell) return;
    const key = `${cell.x},${cell.y},${cell.z}`;
    const same = cells.get(key);
    if (same) same.count = Math.max(same.count, count); else cells.set(key, { cell, count });
  };
  for (const stop of stopsOf(strings(body.stops))) if (stop.reason === 'not_filled') note(cellOf(stop.cell), stop.count);
  for (const text of strings(body.lastResults)) for (const line of text.split(/\r?\n/u)) {
    const hand = /^\d+ use (?:止|失) not_filled[:：]?\s*(.*)$/u.exec(line), pool = hand ? POOL_TEXT.exec(hand[1]!) : null;
    const at = hand ? /\((-?\d+,-?\d+,-?\d+)\)/u.exec(hand[1]!)?.[1] ?? null : null;
    if (pool) note(cellOf(at), Number(pool[1] ?? pool[2]));
  }
  const known = [...cells.values()];
  const pooled = known.map(({ cell }) => ({ cell, count: known.filter(other => dist(other.cell, cell) <= SAME_POOL).reduce((sum, other) => sum + other.count, 0) }))
    .filter(item => item.count >= GIVE_UP_AT);
  // A repeat the body counted without a cell (the investigation line) stays a failure of no known cell.
  const unplaced = triedAgain(body).filter(item => item.reason === 'not_filled' && item.cell === null && item.count >= GIVE_UP_AT && (item.do === null || item.do === 'use'))
    .map(item => ({ cell: null, count: item.count }));
  return [...pooled.sort((a, b) => b.count - a.count), ...unplaced];
}
/** The same frame's counts from `world.recentStops` (the body's stop lines), for the places that have no live object. */
export const waterFailuresOfFrame = (world: Rec | null | undefined): WaterFail[] => waterFailures({ stops: strings(world?.recentStops) });

/**
 * The failures that still stand where she is: a failure with a known cell always, one with no known cell (the body counted it at her feet) only while her
 * feet are underground. On the surface it is stale (she walked up from the pool it was counted at) and must not mark the surface water as given up.
 */
export function standingFails(fails: readonly WaterFail[], context: WaterContext = {}): WaterFail[] {
  const below = !!context.feet && isUnderground(context.feet, context.view);
  return fails.filter(fail => fail.cell !== null || below);
}

/** Whether a source belongs to a pool that was given up: within `SAME_POOL` of a failed cell (a failure with no known cell is the one at her feet, underground only). */
export function givenUp(source: P, fails: readonly WaterFail[], context: WaterContext = {}): boolean {
  return standingFails(fails, context).some(fail => { const at = fail.cell ?? context.feet ?? null; return at !== null && dist(source, at) <= SAME_POOL; });
}

interface Place { distance: number; at: P }
/** The water sources of the map summary's `水源` line (`水源 3か所: 95m 北 (x,y,z)、…`), nearest first. */
export function summaryWaterPlaces(summary: unknown): Place[] {
  if (typeof summary !== 'string') return [];
  const line = summary.split('\n').find(item => item.trimStart().startsWith('水源'));
  if (!line) return [];
  return [...line.matchAll(/(\d+)m\s+\S+\s+\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/gu)].slice(0, 12)
    .map(match => ({ distance: Number(match[1]), at: { x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) } })).sort((a, b) => a.distance - b.distance);
}
/**
 * The line that switches the candidates, only when a pool was given up: 「地下のこの水は汲めなかった（3 回）。地表の水へ: 95m (x,y,z)・…」. The surface
 * sources are the map's water at the surface that is not of the given-up pool. Empty when nothing failed twice.
 */
export function waterSwitchLine(allFails: readonly WaterFail[], summary: unknown, feet: P | null, view?: SkyView | null): string | null {
  const fails = standingFails(allFails, { feet, view });
  if (!fails.length) return null;
  const times = Math.max(...fails.map(fail => fail.count));
  const where = feet && isUnderground(feet, view) ? '地下のこの水' : 'この水';
  const surface = summaryWaterPlaces(summary).filter(place => place.at.y >= SURFACE_Y && !givenUp(place.at, fails, { feet })).slice(0, 2);
  return `${where}は汲めなかった（${times} 回）。地表の水へ${surface.length ? `: ${surface.map(place => `${place.distance}m (${place.at.x},${place.at.y},${place.at.z})`).join('・')}` : ''}`;
}

const goesToSurface = (hand: ActHand): boolean => {
  if (hand.do !== 'go' && hand.do !== 'walk') return false;
  const to = hand.to ?? hand.goals?.[hand.goals.length - 1] ?? hand.path?.[hand.path.length - 1];
  return !!to && to.y >= SURFACE_Y;
};
const bucketAt = (hand: ActHand): P | null => hand.do === 'use' && /^(?:water_)?bucket$/u.test(hand.item ?? '') && hand.at?.length ? hand.at[0]! : null;
const mentionsWater = (text: unknown): boolean => typeof text === 'string' && /水/u.test(text);

/**
 * A walk to the surface water is not cancelled by a retry of the underground pool: the open items that walk (a go or a walk to a surface cell, with water
 * in its why or note) and are named by `replace` stay when the new act's hands draw water at a source of a given-up pool under the surface. Returns the
 * ids to keep, the sentence that says so, and the new act without those bucket hands (the retry would walk her back down once the kept walk ended;
 * `dropped` counts them). Every other replace is the decision's, unchanged.
 */
export function keptSurfaceWaterWalk(open: ReadonlyArray<{ item: string; input?: ActInput }>, replace: readonly string[], input: ActInput,
  allFails: readonly WaterFail[], context: WaterContext = {}): { keep: string[]; note: string | null; input: ActInput; dropped: number } {
  const fails = standingFails(allFails, context);
  const none = { keep: [], note: null, input, dropped: 0 };
  if (!fails.length || !replace.length) return none;
  const retried = (hand: ActHand): boolean => { const cell = bucketAt(hand); return cell !== null && isUnderground(cell, context.view) && givenUp(cell, fails, context); };
  if (!input.hands.some(retried)) return none;
  const named = replace.includes('all') ? open : open.filter(item => replace.includes(item.item));
  const keep = named.filter(item => item.input?.hands.some(goesToSurface) && (mentionsWater(item.input.why) || item.input.hands.some(hand => mentionsWater(hand.note))))
    .map(item => item.item);
  if (!keep.length) return none;
  const hands = input.hands.filter(hand => !retried(hand)), dropped = input.hands.length - hands.length;
  return { keep, input: hands.length ? { ...input, hands } : input, dropped: hands.length ? dropped : 0,
    note: `残した: ${keep.join('・')}（地表の水へ向かう手。この地下の水は ${Math.max(...fails.map(fail => fail.count))} 回汲めなかったので、差し替えない${hands.length && dropped ? `。この水への汲み ${dropped} 手は外した` : ''}）` };
}
