import type { ActHand, ActInput } from '../../contracts/minecraftActContract.js';
import { triedAgain } from './minecraftLlmcRepeat.js';
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

/** The pools a bucket could not draw (not_filled at least `GIVE_UP_AT` times), from the body's counts. */
export function waterFailures(body: Rec): WaterFail[] {
  return triedAgain(body).filter(item => item.reason === 'not_filled' && item.count >= GIVE_UP_AT && (item.do === null || item.do === 'use'))
    .map(item => ({ cell: cellOf(item.cell), count: item.count }));
}
/** The same frame's counts from `world.recentStops` (the body's stop lines), for the places that have no live object. */
export const waterFailuresOfFrame = (world: Rec | null | undefined): WaterFail[] => waterFailures({ stops: strings(world?.recentStops) });

/** Whether a source belongs to a pool that was given up: within `SAME_POOL` of a failed cell, or, when the failed cell is not known, under the surface. */
export function givenUp(source: P, fails: readonly WaterFail[]): boolean {
  return fails.some(fail => fail.cell ? Math.hypot(source.x - fail.cell.x, source.y - fail.cell.y, source.z - fail.cell.z) <= SAME_POOL : source.y < SURFACE_Y);
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
export function waterSwitchLine(fails: readonly WaterFail[], summary: unknown, feet: P | null): string | null {
  if (!fails.length) return null;
  const times = Math.max(...fails.map(fail => fail.count));
  const where = feet && feet.y < SURFACE_Y ? '地下のこの水' : 'この水';
  const surface = summaryWaterPlaces(summary).filter(place => place.at.y >= SURFACE_Y && !givenUp(place.at, fails)).slice(0, 2);
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
 * ids to keep and the sentence that says so. Every other replace is the decision's, unchanged.
 */
export function keptSurfaceWaterWalk(open: ReadonlyArray<{ item: string; input?: ActInput }>, replace: readonly string[], input: ActInput,
  fails: readonly WaterFail[]): { keep: string[]; note: string | null } {
  if (!fails.length || !replace.length) return { keep: [], note: null };
  const retry = input.hands.map(bucketAt).find((cell): cell is P => cell !== null && cell.y < SURFACE_Y && givenUp(cell, fails));
  if (!retry) return { keep: [], note: null };
  const named = replace.includes('all') ? open : open.filter(item => replace.includes(item.item));
  const keep = named.filter(item => item.input?.hands.some(goesToSurface) && (mentionsWater(item.input.why) || item.input.hands.some(hand => mentionsWater(hand.note))))
    .map(item => item.item);
  return keep.length ? { keep, note: `残した: ${keep.join('・')}（地表の水へ向かう手。この地下の水は ${Math.max(...fails.map(fail => fail.count))} 回汲めなかったので、差し替えない）` } : { keep: [], note: null };
}
