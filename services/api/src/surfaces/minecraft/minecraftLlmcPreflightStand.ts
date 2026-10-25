import type { ActPos } from '../../contracts/minecraftActContract.js';
import type { ColumnFact } from './minecraftLlmcFooting.js';
import { AIRISH, blocked, HARM, isPortal, NOT_FLOOR, NOT_SUPPORT, posText, SOLID, STANDS, word, type Cell, type MapView } from './minecraftLlmcPreflightMap.js';

/**
 * The cell checks of the act's preflight (`minecraftLlmcPreflight.ts`): the body's `unstandable` for a walk's target (Shannon-mb-llmc-r10
 * `primitives/walk.ts` + `utils/walkRules.ts` `whyNotStand`), and the two refusals of a place into a cell (`primitives/place.ts`).
 */
export type PreflightCode = 'feet_solid' | 'feet_harm' | 'head_solid' | 'head_harm' | 'no_floor' | 'floor_lava' | 'no_route' | 'occupied' | 'no_support'
  | 'portal_path' | 'portal_top' | 'own_cell' | 'lava_next';
export interface Found { code: PreflightCode; cell: ActPos; why: string }
/** The head's kept `column` answer for a cell at her feet's height, when it has one. */
export type ColumnOf = (at: ActPos, feetY: number) => ColumnFact | undefined;

/** The feet or head cell of a target is a wall or something the walk never enters. */
function bodyCellStop(cell: Cell, view: MapView): Found | null {
  const feet = view.symbol(cell.x, cell.y, cell.z), head = view.symbol(cell.x, cell.y + 1, cell.z);
  const headCell = { ...cell, y: cell.y + 1 };
  if (feet !== undefined && SOLID.has(feet)) return { code: 'feet_solid', cell, why: `足のマス ${posText(cell)} が ${word(feet)} で埋まっている` };
  if (feet !== undefined && HARM.has(feet)) return { code: 'feet_harm', cell, why: `足のマス ${posText(cell)} は ${word(feet)}（入らない）` };
  if (head !== undefined && SOLID.has(head)) {
    const open = feet !== undefined && !blocked(feet) ? `（足のマス ${posText(cell)} は空いている）` : '';
    return { code: 'head_solid', cell: headCell, why: `頭の高さ ${posText(headCell)} が ${word(head)} で通れない${open}` };
  }
  if (head !== undefined && HARM.has(head)) return { code: 'head_harm', cell: headCell, why: `頭の高さ ${posText(headCell)} は ${word(head)}（入らない）` };
  return null;
}

/** No floor under the feet cell: the cells of air counted (exact where the map reaches a floor), water, lava. */
function floorStop(cell: Cell, view: MapView): Found | null {
  const under = view.symbol(cell.x, cell.y - 1, cell.z);
  const underCell = { ...cell, y: cell.y - 1 };
  if (under === 'L' || under === 'l') return { code: 'floor_lava', cell: underCell, why: `足のマス ${posText(cell)} の下 ${posText(underCell)} が溶岩` };
  if (under === undefined || !NOT_FLOOR.has(under)) return null;
  let air = 0, exact = false;
  for (; air < 8; air += 1) {
    const below = view.symbol(cell.x, cell.y - 1 - air, cell.z);
    if (below === undefined || below === '?') break;
    if (AIRISH.has(below)) continue;
    exact = true;
    break;
  }
  const wet = under === 'w' || under === '-';
  const depth = wet || isPortal(under) ? `下 ${posText(underCell)} が${wet ? '水' : 'ポータル'}（立つ床にならない）` : `下 ${exact ? `${air}` : `${air} 以上`} マスが空気（立つ床が無い）`;
  return { code: 'no_floor', cell: underCell, why: `足のマス ${posText(cell)} の${depth}` };
}

/** The floor cell is off the map: a `column` answer the head kept for this cell at her feet's height says how far down the air goes. */
function columnStop(cell: Cell, feetY: number, column: ColumnOf | undefined): Found | null {
  const fact = cell.y === feetY ? column?.(cell, feetY) : undefined;
  if (!fact) return null;
  const underCell = { ...cell, y: cell.y - 1 };
  if (fact.bottom === 'lava' && fact.drop === 0) return { code: 'floor_lava', cell: underCell, why: `足のマス ${posText(cell)} の下は溶岩（調べの答え column）` };
  if (fact.drop < 1) return null;
  return { code: 'no_floor', cell: underCell, why: `足のマス ${posText(cell)} の下 ${fact.drop} マスが空気（調べの答え column: 落差 ${fact.drop}、立つ床が無い）` };
}

/** The body's `unstandable` for a target cell, as far as the map says it for certain: why, or null. */
export function unstandable(cell: Cell, view: MapView, column?: ColumnOf): Found | null {
  const stop = bodyCellStop(cell, view);
  if (stop) return stop;
  // A body in water or on a ladder needs no floor; a cell the map does not show (or a plant, which might be a carpet) says nothing.
  const feet = view.symbol(cell.x, cell.y, cell.z);
  if (feet === undefined || STANDS.has(feet) || feet === '?') return null;
  if (view.symbol(cell.x, cell.y - 1, cell.z) === undefined) return columnStop(cell, view.layers.feet.y, column);
  return floorStop(cell, view);
}

/** Whether all six neighbours of a cell are known not to be a block to set against (a cell this hand placed before counts as one). */
function noSupport(cell: Cell, view: MapView, placed: ReadonlySet<string>): boolean {
  for (const [dx, dy, dz] of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const neighbour = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
    if (placed.has(`${neighbour.x},${neighbour.y},${neighbour.z}`)) return false;
    const there = view.symbol(neighbour.x, neighbour.y, neighbour.z);
    if (there === undefined || !NOT_SUPPORT.has(there)) return false;
  }
  return true;
}

/** A place into one cell: it holds a block that is not replaced, or it has no face to set against (the hand names none). */
export function placeStop(cell: Cell, view: MapView, placed: ReadonlySet<string>, faceGiven: boolean): Found | null {
  const here = view.symbol(cell.x, cell.y, cell.z);
  if (here === undefined || here === '?') return null;
  // A portal's cell holds a block the body does not replace (mb-llmc v2: only a map read under the body's rules has one).
  if (isPortal(here)) return { code: 'occupied', cell, why: `${posText(cell)} は埋まっている（そのマスは ${word(here)}。ポータルの中には置けない）` };
  if (SOLID.has(here) && !placed.has(`${cell.x},${cell.y},${cell.z}`)) {
    return { code: 'occupied', cell, why: `${posText(cell)} は埋まっている（そのマスは ${word(here)}。置く必要は無い）` };
  }
  if (!faceGiven && !SOLID.has(here) && noSupport(cell, view, placed)) {
    return { code: 'no_support', cell, why: `${posText(cell)} は支えになる面が無い（6 面とも地図では空気や水で、固いブロックに接していない）` };
  }
  return null;
}

/**
 * mc-sonnet-guards (replay bench 2026-10-26: Sonnet put a block into its own feet or head cell in 6 of 69 answers, Opus in 2 of 51; the
 * knowledge's MAP line says it cannot): a place into the cell she is standing in for certain (`at`, the walk-through's own tracking) or the one
 * over it. A pillar is `pillarUp`; a block beside her is a cell beside hers.
 */
export function ownCellStop(cell: Cell, at: Cell | null): Found | null {
  if (!at || cell.x !== at.x || cell.z !== at.z || (cell.y !== at.y && cell.y !== at.y + 1)) return null;
  return { code: 'own_cell', cell,
    why: `${posText(cell)} は今立っている${cell.y === at.y ? '足' : '頭'}のマス（足 ${posText(at)} と頭 ${posText({ ...at, y: at.y + 1 })} の 2 マスには place できない）` };
}

const SIDES: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/**
 * mc-sonnet-guards: a dig of a block with lava (`L` a source, `l` flowing) beside it opens a cell the lava flows into (the live's route and
 * obsidian lines mark such a cell 「溶岩の隣: 開けると溶岩が流れ込む」; the knowledge: 「溶岩（L・l）の隣は掘らない」). Not held when water is beside
 * the cell too (the obsidian way: water and lava meet there, `body.obsidian` names these cells) or when the block is obsidian (`O`, dug on purpose).
 * The map is as the earlier hands of the act leave it, so a block put on the lava before the dig makes the cell safe.
 */
export function lavaDigStop(cell: Cell, view: MapView): Found | null {
  const here = view.symbol(cell.x, cell.y, cell.z);
  if (here === undefined || !SOLID.has(here) || here === 'O') return null;
  let lava: Cell | null = null;
  for (const [dx, dy, dz] of SIDES) {
    const at = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }, symbol = view.symbol(at.x, at.y, at.z);
    if (symbol === 'w' || symbol === '-') return null;
    if (symbol === 'L' || symbol === 'l') lava ??= at;
  }
  return lava ? { code: 'lava_next', cell, why: `${posText(cell)} は${word(here)}で、${posText(lava)} に溶岩が隣り合う（開けると溶岩が流れ込む）` } : null;
}
