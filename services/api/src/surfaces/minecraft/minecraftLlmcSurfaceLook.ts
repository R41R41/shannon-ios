import type { ActPos } from '../../contracts/minecraftActContract.js';
import { AIRISH, type Cell, type MapView } from './minecraftLlmcPreflightMap.js';
import type { ColumnOf } from './minecraftLlmcPreflightStand.js';

/**
 * 地図のマスを「確かに空いている」「空いていない」「分からない」の 3 つで見る（規則の守り `minecraftLlmcRuleGuard.ts` のため）。層の地図
 * （`readLayers`）に無いマスを、次の 2 つで補う。どちらも体の地図の文が言っている事実だけで、推測はしない。
 * - 方式=surface の上からの 21×21 の格子（1 マス「記号＋高さ」。高さ: 0〜9 は足より上、+ は 10 以上上、a〜i は 1〜9 下、v は 10 以上下か何も無い）。
 *   その列の一番上の固い（または水・溶岩の）ブロックの高さが分かれば、それより上は空気。足の ±12 の範囲を見た物なので、v は「足の 10 下より下」。
 * - 頭が持つ調べ（`column`）の答え: その x,z の足の高さの 1 つ下から `drop` マスが空気。
 */
export type CellState = { kind: 'open' } | { kind: 'closed'; symbol: string | undefined } | { kind: 'unknown' };
export type Look = (x: number, y: number, z: number) => CellState;

const UNKNOWN: CellState = { kind: 'unknown' };
const OPEN: CellState = { kind: 'open' };
/** 地図の記号が空いている物（空気・敵や動物の足・足の跡）。 */
export const isOpenSymbol = (symbol: string | undefined): boolean =>
  symbol !== undefined && (AIRISH.has(symbol) || symbol === '@' || symbol === '!' || symbol === 'm');

/** 上からの格子の 1 マス: 一番上のブロックの記号と、足から見たその高さ（null: 10 以上離れている）。 */
export interface TopCell { symbol: string; diff: number | null; far: 'down' | 'up' | null }
/** 方式=surface の上からの格子。無い地図（layers）は空。 */
export function readTopGrid(map: string | undefined): Map<string, TopCell> {
  const grid = new Map<string, TopCell>();
  const lines = (map ?? '').split('\n');
  const head = /^地図 v1 足=\(-?\d+,-?\d+,-?\d+\) x=(-?\d+)\.\.(-?\d+) z=-?\d+\.\.-?\d+ 方式=surface/u.exec(lines[0] ?? '');
  if (!head) return grid;
  const x0 = Number(head[1]);
  for (const line of lines.slice(1)) {
    if (/^y=/u.test(line)) break;
    const row = /^\s*(-?\d+) (.+)$/u.exec(line);
    if (row) addRow(grid, x0, row[1]!, row[2]!);
  }
  return grid;
}
function addRow(grid: Map<string, TopCell>, x0: number, z: string, text: string): void {
  text.split(' ').forEach((token, index) => {
    const cell = topCell(token);
    if (cell) grid.set(`${x0 + index},${z}`, cell);
  });
}
function topCell(token: string): TopCell | null {
  if (token.length !== 2) return null;
  const symbol = token[0]!, code = token[1]!;
  if (code === 'v') return { symbol, diff: null, far: 'down' };
  if (code === '+') return { symbol, diff: null, far: 'up' };
  if (/[0-9]/u.test(code)) return { symbol, diff: Number(code), far: null };
  const down = code.charCodeAt(0) - 96;
  return down >= 1 && down <= 9 ? { symbol, diff: -down, far: null } : null;
}

/** 上からの格子で見たマス。一番上のブロックより上は空気、そのブロックの高さは閉じている、それより下は見ない（分からない）。 */
function topLook(top: TopCell, feetY: number, y: number): CellState {
  // 足の ±12 の外は、格子が見ていない。
  if (y > feetY + 12 || y < feetY - 12) return UNKNOWN;
  if (top.far === 'down') return y >= feetY - 9 ? OPEN : UNKNOWN;
  if (top.far === 'up' || top.diff === null) return UNKNOWN;
  const topY = feetY + top.diff;
  if (y > topY) return OPEN;
  return y === topY ? { kind: 'closed', symbol: top.symbol } : UNKNOWN;
}

/** The look over the map's layers (with the act's earlier digs and places), the surface grid and the kept column answers. */
export function lookOf(view: MapView, map: string | undefined, feet: Cell, column?: ColumnOf): Look {
  const top = readTopGrid(map);
  return (x, y, z) => {
    const symbol = view.symbol(x, y, z);
    if (symbol !== undefined) return isOpenSymbol(symbol) ? OPEN : { kind: 'closed', symbol };
    const cell = top.get(`${x},${z}`);
    const seen = cell ? topLook(cell, feet.y, y) : UNKNOWN;
    if (seen.kind !== 'unknown') return seen;
    const fact = column?.({ x, y: feet.y, z } as ActPos, feet.y);
    return fact && y <= feet.y - 1 && y >= feet.y - fact.drop ? OPEN : UNKNOWN;
  };
}
