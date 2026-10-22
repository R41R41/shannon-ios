import type { MapView } from './minecraftLlmcPreflightMap.js';
import {
  bestStep, cornerOk, DIRS, fallText, isHard, isHarm, isOpen, nameOf, NAME, noFloor, ptText, stepOptions, type P, type Step,
} from './minecraftLlmcWalkRules.js';

/**
 * mb-llmc v2 `around` (改修案 2.2; 再現台 v9b の `body.around` を、範囲を広げて本番へ): around her feet, cell by cell, whether she can
 * stand there and what it would take, from the frame's map alone and with whole coordinates. Facts only; a hand is the decision's.
 *
 * Two parts, in one list of lines:
 * 1. `stepLines`: the ten cells next to her (eight directions, the cell over her head, the cell under her feet) with the walk's own rules
 *    (`minecraftLlmcWalkRules.ts`): 歩ける / 掘れば歩ける: 掘る (…) / 床が無い（落差 n、下は …）/ 斜めには歩けない / 歩けない: 理由.
 *    The replay's measure: the walks to cells within two blocks that did not stand fell from 9 to 1 with these lines (0 with the short hands).
 * 2. `cellLines`: every cell of the heights she can read from the map, within `AROUND_RANGE` blocks across (the replay: the walks to cells three
 *    or more blocks away that did not stand went from 6 to 11 when only two were written), grouped by what the cell is and by rows of one
 *    run `x=a..b` (a whole coordinate for each cell): 歩ける / 頭を掘れば歩ける / 足を掘れば歩ける / 床が無い / 溶岩・火. A cell whose feet,
 *    head or floor the map does not show is not written (不明); cells that are rock at feet and head (dig both) are not listed.
 */
export const AROUND_RANGE = 6;
/** How many rows of one kind a level lists before it says how many it left out. */
const ROWS_PER_KIND = 14;
const triple = (view: MapView, cell: P) => `足 ${nameOf(view.symbol(cell.x, cell.y, cell.z))}・頭 ${nameOf(view.symbol(cell.x, cell.y + 1, cell.z))}`
  + `・床 ${nameOf(view.symbol(cell.x, cell.y - 1, cell.z))}`;
const digText = (view: MapView, cells: readonly P[]) => cells.map(c => `${ptText(c)} ${NAME[view.symbol(c.x, c.y, c.z) ?? ''] ?? '?'}`).join('、');

function stepHow(best: Step): string {
  if (best.kind === 'level') return '';
  return best.kind === 'up' ? `1 段上りで ${ptText(best.to)} に着く` : `${best.drop} 段下りで ${ptText(best.to)} に着く`;
}
/** One direction's line: the cell next to her and what the step to it needs. */
function stepLine(view: MapView, feet: P, dir: { name: string; dx: number; dz: number }): string {
  const tx = feet.x + dir.dx, tz = feet.z + dir.dz;
  const head = `${dir.name} ${ptText({ x: tx, y: feet.y, z: tz })}: ${triple(view, { x: tx, y: feet.y, z: tz })} → `;
  if (dir.dx !== 0 && dir.dz !== 0 && !cornerOk(view, feet, dir.dx, dir.dz)) {
    return `${head}斜めの角の両方の列（${ptText({ x: feet.x + dir.dx, y: feet.y, z: feet.z })} と ${ptText({ x: feet.x, y: feet.y, z: feet.z + dir.dz })}）`
      + 'の足か頭が固い: 斜めには歩けない（斜めは角のどちらかの列の足と頭が空いている時だけ）';
  }
  const options = stepOptions(view, feet, tx, tz), best = bestStep(options);
  if (best && !best.dig.length) return `${head}歩ける${best.kind === 'level' ? '' : `（${stepHow(best)}）`}`;
  if (best) return `${head}掘れば歩ける: 掘る ${digText(view, best.dig)}${best.kind === 'level' ? '' : `（${stepHow(best)}）`}`;
  const level = options[0]!;
  if (level.bad?.includes('床が無い')) return `${head}${level.dig.length ? '掘っても' : ''}床が無い（${fallText(view, tx, feet.y - 1, tz)}）`;
  return `${head}歩けない: ${level.bad ?? '理由不明'}`;
}
/** The ten cells next to her, one line each. */
export function stepLines(view: MapView, feet: P): string[] {
  const lines = DIRS.map(dir => stepLine(view, feet, dir));
  const over = view.symbol(feet.x, feet.y + 2, feet.z), under = view.symbol(feet.x, feet.y - 1, feet.z);
  lines.push(`上 頭の上 ${ptText({ x: feet.x, y: feet.y + 2, z: feet.z })}: ${isHard(over) ? `固い（${nameOf(over)}）` : nameOf(over)}`);
  lines.push(`下 足の下 ${ptText({ x: feet.x, y: feet.y - 1, z: feet.z })}: ${noFloor(under) ? `床が無い（${fallText(view, feet.x, feet.y - 1, feet.z)}）`
    : `床あり（${nameOf(under)}）`}`);
  return lines;
}

type Kind = 'walk' | 'headDig' | 'feetDig' | 'void' | 'harm';
/** What a cell is as a place to stand, from its feet, head and floor (all three shown by the map), or null (rock to dig through, or not shown). */
function kindOf(view: MapView, c: P): { kind: Kind; fall?: string } | null {
  const feet = view.symbol(c.x, c.y, c.z), head = view.symbol(c.x, c.y + 1, c.z), floor = view.symbol(c.x, c.y - 1, c.z);
  if (feet === undefined || head === undefined || floor === undefined) return null;
  if (isHarm(feet) || isHarm(head) || isHarm(floor)) return { kind: 'harm' };
  const feetOpen = isOpen(feet), headOpen = isOpen(head);
  if (!feetOpen && !headOpen) return null;
  if (noFloor(floor)) return feetOpen && headOpen ? { kind: 'void', fall: fallText(view, c.x, c.y - 1, c.z) } : null;
  if (feetOpen && headOpen) return { kind: 'walk' };
  return { kind: feetOpen ? 'headDig' : 'feetDig' };
}
/** `z=63 x=224..228,230` rows: the cells of one kind on one level as runs along x, one row for each z. */
function rowsOf(cells: readonly P[]): string[] {
  const byZ = new Map<number, number[]>();
  for (const c of cells) byZ.set(c.z, [...byZ.get(c.z) ?? [], c.x]);
  return [...byZ].sort((a, b) => a[0] - b[0]).map(([z, xs]) => {
    const runs: string[] = [];
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; i += 1) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j += 1;
      runs.push(j === i ? `${xs[i]}` : `${xs[i]}..${xs[j]}`);
      i = j;
    }
    return `z=${z} x=${runs.join(',')}`;
  });
}
const KIND_TEXT: Record<Kind, string> = { walk: '歩ける', headDig: '頭を掘れば歩ける（掘る = 頭のマス (x,y+1,z)）', feetDig: '足を掘れば歩ける（掘る = 足のマス (x,y,z)）',
  void: '床が無い', harm: '溶岩・火・クモの巣・マグマが足か頭か床にある（入らない）' };
function listRows(rows: readonly string[]): string {
  return rows.length > ROWS_PER_KIND ? `${rows.slice(0, ROWS_PER_KIND).join(' / ')} / ほか ${rows.length - ROWS_PER_KIND} 行は略` : rows.join(' / ');
}
/** The heights of the map whose three cells (feet, head, floor) are all shown, from the lowest, within `range` blocks of her feet. */
function levelsOf(view: MapView, feet: P): number[] {
  const out: number[] = [];
  for (const y of [...view.layers.layers.keys()].sort((a, b) => b - a)) {
    if (Math.abs(y - feet.y) <= 3 && view.layers.layers.has(y - 1) && view.layers.layers.has(y + 1)) out.push(y);
  }
  return out;
}
/**
 * The cells of one level, by kind. A cell with no floor is a fact for her own level only (below it, the same air column is the head room of
 * a lower place to stand); a cell whose feet are rock and whose head is air is the floor of the place above when that is a place to stand.
 */
function levelCells(view: MapView, feet: P, y: number, range: number): Map<Kind, P[]> {
  const by = new Map<Kind, P[]>();
  for (let dz = -range; dz <= range; dz += 1) {
    for (let dx = -range; dx <= range; dx += 1) {
      const c = { x: feet.x + dx, y, z: feet.z + dz };
      const found = kindOf(view, c);
      if (!found || (found.kind === 'void' && y !== feet.y)) continue;
      if (found.kind === 'feetDig' && (y !== feet.y || kindOf(view, { ...c, y: y + 1 })?.kind === 'walk')) continue;
      by.set(found.kind, [...by.get(found.kind) ?? [], c]);
    }
  }
  return by;
}
/** The void cells on a level, grouped by their fall (the same fall in one row list). */
function voidLines(view: MapView, cells: readonly P[]): string[] {
  const by = new Map<string, P[]>();
  for (const c of cells) {
    const text = fallText(view, c.x, c.y - 1, c.z);
    by.set(text, [...by.get(text) ?? [], c]);
  }
  return [...by].map(([fall, list]) => `床が無い（${fall}）: ${listRows(rowsOf(list))}`);
}
/** The cells within `range` blocks, level by level: what each is as a place to stand. */
export function cellLines(view: MapView, feet: P, range = AROUND_RANGE): string[] {
  const lines: string[] = [];
  for (const y of levelsOf(view, feet)) {
    const rel = y - feet.y;
    const label = `y=${y}（足${rel === 0 ? 'の高さ' : rel > 0 ? ` +${rel}` : ` ${rel}`}）`;
    const by = levelCells(view, feet, y, range);
    for (const kind of ['walk', 'headDig', 'feetDig', 'harm'] as const) {
      const cells = by.get(kind);
      if (cells?.length) lines.push(`${label} ${KIND_TEXT[kind]}: ${listRows(rowsOf(cells))}`);
    }
    if (by.get('void')?.length) lines.push(...voidLines(view, by.get('void')!).map(text => `${label} ${text}`));
  }
  return lines;
}
/** `around`: the ten cells next to her, then the cells within the range. */
export function aroundLines(view: MapView, feet: P): string[] {
  return [...stepLines(view, feet), '足の周り（この判断の始めの frame の地図から。水平 6 マス。地図に足・頭・床が全部ある高さだけ。足も頭も固い所と、地図に無い所は書かない）:',
    ...cellLines(view, feet)];
}
