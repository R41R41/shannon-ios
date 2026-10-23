import type { ActPos } from '../../contracts/minecraftActContract.js';

/**
 * The map as the act's preflight reads it (`minecraftLlmcPreflight.ts`): the layers of the map text, the classes of its symbols (what the
 * body's walk rules make of a block of that symbol — `utils/walkRules.ts` and `utils/localMap.ts` `symbolFor` of the body), and the cells the
 * earlier hands of the same act change. A class names only what the symbol says for certain; every other symbol is "not named" and lets the
 * act go as it is (a door, a fence or a plant may be passable, a floor or a wall by its state).
 */
export type Cell = ActPos;
/**
 * A nether portal `p`, as `readLayers` reads it under the body's rules (`BodyRules`): a cell she enters (feet and head in it, on the obsidian under it:
 * that is how the dimension changes), never a floor to stand on, nothing to set against, nothing to place into. Not harm. No map has it; every text the
 * model reads writes it as the legend does (`legendOf`: `p`).
 */
export const PORTAL = '¤';
/** An end portal (or gateway) `e`, read as `PORTAL` is, with its own word. No map has it; written `e` in the texts (`legendOf`). */
export const END_PORTAL = '¢';
/** The two portals: cells that are walked into and that change the dimension. */
export const PORTALS: ReadonlySet<string> = new Set([PORTAL, END_PORTAL]);
export const isPortal = (symbol: string | undefined): boolean => symbol !== undefined && PORTALS.has(symbol);
/** A fence or a wall (`+` of the legend of mb-llmc-cand 2), as `readLayers` reads it under the body's rules: a wall 1.5 high, never a floor. No map has it. */
export const FENCE = '‖';
/** The symbol of the map's legend for what `readLayers` read under the body's rules (the model reads only the legend's symbols). */
export const legendOf = (symbol: string | undefined): string => symbol === PORTAL ? 'p' : symbol === END_PORTAL ? 'e' : symbol === FENCE ? '+' : symbol ?? '?';
/** A block the walk cannot enter and a block is not put into: a wall, whatever its shape (the rules read a full box, a slab and a stair alike). */
export const SOLID = new Set('#:sIinNuOEGicdgrXWHSTFCo$YKb‖'.split(''));
/** Never entered by the walk: lava, fire (and campfires), cobweb and powder snow, magma. (A portal is not here: it is entered on purpose.) */
export const HARM = new Set(['L', 'l', 'f', 'x', 'M']);
/** Known not to be a floor to stand on: air, water, lava, fire, a web, a portal (its top is no floor). A plant or carpet `,` may be a carpet: not named. */
export const NOT_FLOOR = new Set(['.', '*', 'w', '-', 'L', 'l', 'f', 'x', 'A', 'J', 'K', PORTAL, END_PORTAL, FENCE]);
/** Known not to be a block to set against (boundingBox not a block). A plant `,` may be a carpet: not named. */
export const NOT_SUPPORT = new Set(['.', '*', 'w', '-', 'L', 'l', 'f', 'x', 't', PORTAL, END_PORTAL]);
/** Air or what a fall goes through as air (the walk's own count of the cells under a target). */
export const AIRISH = new Set(['.', '*', 'f', 'x']);
/** A body in water or on a ladder needs no floor. */
export const STANDS = new Set(['w', '-', 'h']);
export const NAMES: Readonly<Record<string, string>> = Object.freeze({
  [PORTAL]: 'ネザーポータル', [END_PORTAL]: 'エンドポータル', [FENCE]: '柵・壁',
  '#': '石の類', ':': '土の類', s: '砂・砂利', I: '氷', n: 'netherrack', N: 'nether_bricks', u: 'ソウルサンド・ソウルソイル', O: '黒曜石', E: 'エンドストーン',
  G: 'glowstone', i: '鉄鉱石', c: '石炭鉱石', d: 'ダイヤ鉱石', g: '金鉱石', r: 'レッドストーン鉱石', o: '鉱石', X: '岩盤', W: '原木', H: '干し草', S: 'スポナー',
  F: 'かまど', T: '作業台', C: 'チェスト・樽', $: '固いブロック', Y: 'ウォートブロック・シュルームライト', K: '鉄の扉・トラップドア', b: 'ガラス・鉄格子・鎖',
  A: '木のトラップドア', J: '木のフェンスゲート', L: '溶岩', l: '溶岩', f: '火', x: 'クモの巣', M: 'magma_block', w: '水', '-': '水', '.': '空気',
});
export const cellKey = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
export const posText = (cell: Cell) => `(${cell.x},${cell.y},${cell.z})`;
export const word = (symbol: string | undefined) => `${NAMES[symbol ?? ''] ?? '固いブロック'}（地図 ${legendOf(symbol)}）`;
export const blocked = (symbol: string | undefined) => symbol !== undefined && (SOLID.has(symbol) || HARM.has(symbol));

/**
 * mb-llmc v2: the walk's rules of the body (Shannon `utils/walkRules.ts` `cellWay`/`floorOf`, `utils/localMap.ts` `symbolFor`, the legend `MAP_LEGEND_V2`
 * of mb-llmc-cand 2) for the symbols the guards read as the legends before it. A symbol is read under them (`readLayers`' `rules`) as: a nether or end
 * portal `p` `e` → entered on purpose, no floor, nothing placed into or against (`PORTAL`, `END_PORTAL`; not harm); an end portal frame `Q` `R`,
 * planks and the like `P`, a bed `B` → a wall (`$`); fences and walls `+`
 * → a wall that is no floor (`FENCE`, 1.5 high); a wooden door `D` → `A` (opened on the way, no floor). `Y` `K` `b` are walls and `A` `J` `K` no floor in the
 * sets above; `%` is leaves only (broken on the way, a floor: not named), so the Nether's wart blocks need no rule of the dimension (`Y`). `q` (signs,
 * plates, buttons, levers) is walked through: not named.
 */
export interface BodyRules { readonly bodyLegend: 2 }
export const BODY_RULES: BodyRules = Object.freeze({ bodyLegend: 2 });
export function bodySymbol(symbol: string, _rules: BodyRules): string {
  if (symbol === 'p') return PORTAL;
  if (symbol === 'e') return END_PORTAL;
  if (symbol === 'D') return 'A';
  if (symbol === '+') return FENCE;
  return symbol === 'Q' || symbol === 'R' || symbol === 'P' || symbol === 'B' ? '$' : symbol;
}

/** The map's layers (y → "x,z" → symbol) and the feet cell it was drawn for. */
export interface Layers { feet: ActPos; mode: string; layers: Map<number, Map<string, string>> }
const HEADER = /^地図 v1 足=\((-?\d+),(-?\d+),(-?\d+)\) x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+) 方式=(\w+)/u;
const LAYER = /^y=(-?\d+)(?: x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+))?\s*$/u;
const ROW = /^\s*(-?\d+) (.+)$/u;
/**
 * The layers of the map text, each cell at its own x. A layer line with no range (the surface form's three 11×11 layers under its 21×21
 * top grid, centred on her feet) has the columns of its rows: the header's width is the main grid's, else the layer is centred on the
 * feet. (`readMap` of the footing gives a layer with no range the main grid's first column, which is right only when the widths are
 * equal; it is not changed, so the rest of the mode stays as it was.) The top grid's two-character cells are not read.
 */
export function readLayers(map: string | undefined, rules?: BodyRules): Layers | null {
  const lines = (map ?? '').split('\n');
  const head = HEADER.exec(lines[0] ?? '');
  if (!head) return null;
  const feet = { x: Number(head[1]), y: Number(head[2]), z: Number(head[3]) }, mainX = Number(head[4]), width = Number(head[5]) - Number(head[4]) + 1;
  const layers = new Map<number, Map<string, string>>();
  let current: { cells: Map<string, string>; x0: number | null } | null = null;
  for (const line of lines.slice(1)) {
    const layer = LAYER.exec(line);
    if (layer) {
      const cells = new Map<string, string>();
      layers.set(Number(layer[1]), cells);
      current = { cells, x0: layer[2] !== undefined ? Number(layer[2]) : null };
      continue;
    }
    if (line.startsWith('縦 ')) break;
    const row = ROW.exec(line);
    if (!row || !current) continue;
    const symbols = row[2]!.split(' ');
    const x0 = current.x0 ?? (symbols.length === width ? mainX : feet.x - Math.floor(symbols.length / 2));
    symbols.forEach((symbol, index) => current!.cells.set(`${x0 + index},${Number(row[1])}`, rules ? bodySymbol(symbol, rules) : symbol));
  }
  return { feet, mode: head[8]!, layers };
}

/** The map with the cells the earlier hands of the act change: a symbol (undefined where the map does not show the cell), and whether it shows it. */
export interface MapView {
  layers: Layers;
  symbol(x: number, y: number, z: number): string | undefined;
  known(x: number, y: number, z: number): boolean;
  /** A dig opens its cells, a place fills them. */
  open(cell: Cell): void;
  fill(cell: Cell): void;
}
export function mapView(layers: Layers): MapView {
  const overlay = new Map<string, 'solid' | 'air'>();
  return {
    layers,
    symbol(x, y, z) {
      const changed = overlay.get(`${x},${y},${z}`);
      return changed === 'solid' ? '#' : changed === 'air' ? '.' : layers.layers.get(y)?.get(`${x},${z}`);
    },
    known(x, y, z) { return overlay.has(`${x},${y},${z}`) || layers.layers.get(y)?.has(`${x},${z}`) === true; },
    open(cell) { overlay.set(cellKey(cell), 'air'); },
    fill(cell) { overlay.set(cellKey(cell), 'solid'); },
  };
}
