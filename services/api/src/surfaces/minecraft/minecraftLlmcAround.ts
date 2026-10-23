import { isPortal, type MapView } from './minecraftLlmcPreflightMap.js';
import {
  bestStep, cornerOk, DIRS, fallOf, fallText, isHard, isHarm, isOpen, nameOf, NAME, noFloor, portalWords, ptText, stepOptions, type P, type Step,
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
const ROWS_PER_KIND = 8;
const triple = (view: MapView, cell: P) => `足 ${nameOf(view.symbol(cell.x, cell.y, cell.z))}・頭 ${nameOf(view.symbol(cell.x, cell.y + 1, cell.z))}`
  + `・床 ${nameOf(view.symbol(cell.x, cell.y - 1, cell.z))}`;
const digText = (view: MapView, cells: readonly P[]) => cells.map(c => `${ptText(c)} ${NAME[view.symbol(c.x, c.y, c.z) ?? ''] ?? '?'}`).join('、');

function stepHow(best: Step): string {
  if (best.kind === 'level') return '';
  return best.kind === 'up' ? `1 段上りで ${ptText(best.to)} に着く` : `${best.drop} 段下りで ${ptText(best.to)} に着く`;
}
/**
 * What the best step to a cell is: 入れる (a portal's cell: how the dimension changes; mb-llmc-cand 9, run 37: it was told 「歩けない: がポータル」),
 * 歩ける, or 掘れば歩ける with the cells to dig.
 */
function bestWords(view: MapView, best: Step): string {
  // The body's rule: the head cell of a portal's cell is a portal or passable; fire, lava or a web over it is no way in (and never 入れる).
  const over = view.symbol(best.to.x, best.to.y + 1, best.to.z);
  const gate = isHarm(over) ? null : portalWords(view.symbol(best.to.x, best.to.y, best.to.z));
  if (gate && isHard(over)) return '入れない: ポータルの最上段（頭が枠に当たる）。下の段のポータルのマスへ';
  if (best.dig.length) return `掘れば歩ける: 掘る ${digText(view, best.dig)}`;
  return gate ? `入れる: ${gate}` : '歩ける';
}
/** One direction's line: the cell next to her and what the step to it needs; null for a diagonal the corners shut (said together, `diagonalLine`). */
function stepLine(view: MapView, feet: P, dir: { name: string; dx: number; dz: number }): string | null {
  const tx = feet.x + dir.dx, tz = feet.z + dir.dz;
  const cell = { x: tx, y: feet.y, z: tz };
  const head = `${dir.name} ${ptText(cell)}: `;
  if (dir.dx !== 0 && dir.dz !== 0 && !cornerOk(view, feet, dir.dx, dir.dz)) return null;
  const options = stepOptions(view, feet, tx, tz), best = bestStep(options);
  const how = best && best.kind !== 'level' ? `（${stepHow(best)}）` : '';
  if (best) return `${head}${bestWords(view, best)}${how}`;
  const level = options[0]!;
  if (level.bad?.includes('床が無い')) return `${head}${triple(view, cell)} → ${level.dig.length ? '掘っても' : ''}床が無い（${fallText(view, tx, feet.y - 1, tz)}）`;
  return `${head}${triple(view, cell)} → 歩けない: ${level.bad ?? '理由不明'}`;
}
/** The diagonals whose two corner columns are shut, in one line. */
function diagonalLine(feet: P, shut: ReadonlyArray<{ name: string; dx: number; dz: number }>): string[] {
  const cells = shut.map(dir => `${dir.name} ${ptText({ x: feet.x + dir.dx, y: feet.y, z: feet.z + dir.dz })}`).join('・');
  return shut.length ? [`斜めには歩けない（角の両方の列の足か頭が固い）: ${cells}`] : [];
}
/** The cells next to her: the eight directions (the shut diagonals together), the cell over her head, the cell under her feet. */
export function stepLines(view: MapView, feet: P): string[] {
  const lines: string[] = [], shut: Array<{ name: string; dx: number; dz: number }> = [];
  for (const dir of DIRS) {
    const line = stepLine(view, feet, dir);
    if (line) lines.push(line); else shut.push(dir);
  }
  lines.push(...diagonalLine(feet, shut));
  const over = view.symbol(feet.x, feet.y + 2, feet.z), under = view.symbol(feet.x, feet.y - 1, feet.z);
  lines.push(`上 頭の上 ${ptText({ x: feet.x, y: feet.y + 2, z: feet.z })}: ${isHard(over) ? `固い（${nameOf(over)}）` : nameOf(over)}`);
  lines.push(`下 足の下 ${ptText({ x: feet.x, y: feet.y - 1, z: feet.z })}: ${noFloor(under) ? `床が無い（${fallText(view, feet.x, feet.y - 1, feet.z)}）`
    : `床あり（${nameOf(under)}）`}`);
  return lines;
}

type Kind = 'walk' | 'headDig' | 'feetDig' | 'void' | 'harm' | 'portal';
/**
 * A portal in her feet cell with a portal or a passable cell over it (the rule shared with the body), whatever is under it (an end portal over lava is
 * still a way in): a cell she goes into, never harm or a void. The cells inside the portal over its first cell have the portal under them: the same way
 * in, not listed again (null). Else harm in her feet, head or floor cell (lava, fire, a web, magma). Undefined: neither.
 */
function specialKind(feet: string, head: string, floor: string): { kind: Kind } | null | undefined {
  if (portalWords(feet) !== null && isOpen(head)) return isPortal(floor) ? null : { kind: 'portal' };
  return isHarm(feet) || isHarm(head) || isHarm(floor) ? { kind: 'harm' } : undefined;
}
/** What a cell is as a place to stand, from its feet, head and floor (all three shown by the map), or null (rock to dig through, or not shown). */
function kindOf(view: MapView, c: P): { kind: Kind; fall?: string } | null {
  const feet = view.symbol(c.x, c.y, c.z), head = view.symbol(c.x, c.y + 1, c.z), floor = view.symbol(c.x, c.y - 1, c.z);
  if (feet === undefined || head === undefined || floor === undefined) return null;
  const special = specialKind(feet, head, floor);
  if (special !== undefined) return special;
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
const KIND_TEXT: Record<Kind, string> = { walk: '歩ける', headDig: '頭を掘れば歩ける', feetDig: '足を掘れば歩ける', void: '床が無い', harm: '溶岩・火・クモの巣・マグマ', portal: '入れる（ポータル）' };
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
  const near = (c: P) => y === feet.y && Math.abs(c.x - feet.x) <= 1 && Math.abs(c.z - feet.z) <= 1;
  const by = new Map<Kind, P[]>();
  for (let dz = -range; dz <= range; dz += 1) {
    for (let dx = -range; dx <= range; dx += 1) {
      const c = { x: feet.x + dx, y, z: feet.z + dz };
      const found = kindOf(view, c);
      if (!found || near(c) || (found.kind === 'void' && y !== feet.y)) continue;
      if (found.kind === 'feetDig' && (y !== feet.y || kindOf(view, { ...c, y: y + 1 })?.kind === 'walk')) continue;
      by.set(found.kind, [...by.get(found.kind) ?? [], c]);
    }
  }
  return by;
}
/** The portal cells of a level, one line for each portal (the nether's and the end's are told apart). */
function portalLines(view: MapView, label: string, cells: readonly P[]): string[] {
  const by = new Map<string, P[]>();
  for (const c of cells) {
    const symbol = view.symbol(c.x, c.y, c.z)!;
    by.set(symbol, [...by.get(symbol) ?? [], c]);
  }
  return [...by].map(([symbol, list]) => `${label} 入れる: ${portalWords(symbol)}: ${listRows(rowsOf(list))}`);
}
/** The void cells on a level, grouped by their fall (the same fall in one row list). */
function voidLines(view: MapView, cells: readonly P[]): string[] {
  const by = new Map<string, P[]>();
  for (const c of cells) {
    const fall = fallOf(view, c.x, c.y - 1, c.z);
    const text = fall.open ? '落差 1 以上、地図に底が無い' : `落差 ${fall.n}、下は ${nameOf(fall.below)}`;
    by.set(text, [...by.get(text) ?? [], c]);
  }
  return [...by].map(([fall, list]) => `床が無い（${fall}）: ${listRows(rowsOf(list))}`);
}
/** The cells within `range` blocks, level by level: what each is as a place to stand. */
export function cellLines(view: MapView, feet: P, range = AROUND_RANGE): string[] {
  const lines: string[] = [];
  for (const y of levelsOf(view, feet)) {
    const rel = y - feet.y;
    const label = `y=${y}（${rel === 0 ? '足' : rel > 0 ? `+${rel}` : `${rel}`}）`;
    const by = levelCells(view, feet, y, range);
    for (const kind of ['walk', 'headDig', 'feetDig', 'harm'] as const) {
      const cells = by.get(kind);
      if (cells?.length) lines.push(`${label} ${KIND_TEXT[kind]}: ${listRows(rowsOf(cells))}`);
    }
    lines.push(...portalLines(view, label, by.get('portal') ?? []));
    if (by.get('void')?.length) lines.push(...voidLines(view, by.get('void')!).map(text => `${label} ${text}`));
  }
  return lines;
}
/** `around`: the ten cells next to her, then the cells within the range. */
export function aroundLines(view: MapView, feet: P): string[] {
  return [...stepLines(view, feet), '足の周りの 1 歩より先（この判断の始めの frame の地図から。水平 6・足と頭と床が地図にある高さだけ。z=行 x=範囲）:',
    ...cellLines(view, feet)];
}
