import { blocked, isPortal, NOT_FLOOR, posText, STANDS, word, type Cell, type MapView } from './minecraftLlmcPreflightMap.js';

/**
 * Whether the walk can get from one cell to another without digging or laying a block, as far as the map says for certain
 * (`minecraftLlmcPreflight.ts`). The walk's moves (Shannon-mb-llmc-r10 `primitives/walk.ts`, `utils/walkRules.ts`): a step on the level, a
 * step up of one (the cell over the head clear), a drop of three at most (the cells of the fall clear), a run over a gap, a ladder or water
 * up and down. Everything the map does not name is taken the way that lets her through: a cell the map does not show, a door, a leaf, a
 * plant, a floor that may be one. Only when even so there is no way — every way into the target is a wall or a hole the map names — is it
 * "no route". Leaving the map is a way out (the open ground beyond it is taken as joined to every standing place at the map's edge).
 */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const MAX_FALL = 3;
const MAX_JUMP = 4;
const BUDGET = 20_000;

export interface RouteAnswer {
  reachable: boolean;
  /** How many standing places the search found, and the one nearest the target. */
  found: number;
  nearest: Cell;
}

/** The search: the cells found so far, those still to look from, and whether a move left the map. */
class Search {
  readonly seen = new Map<string, Cell>();
  readonly queue: Cell[] = [];
  escaped = false;
  constructor(readonly view: MapView) {}
  passable = (x: number, y: number, z: number): boolean => !blocked(this.view.symbol(x, y, z));
  stands = (x: number, y: number, z: number): boolean => {
    if (!this.passable(x, y, z) || !this.passable(x, y + 1, z)) return false;
    const feet = this.view.symbol(x, y, z);
    // A cell in a portal (v2: only a map read under the body's rules has one) is where she goes in; the portal under it is no floor to ask.
    if (feet !== undefined && (STANDS.has(feet) || isPortal(feet))) return true;
    const under = this.view.symbol(x, y - 1, z);
    return !(under !== undefined && NOT_FLOOR.has(under));
  };
  visit(cell: Cell): void {
    if (!this.view.known(cell.x, cell.y, cell.z)) {
      this.escaped = true;
      return;
    }
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, cell);
    this.queue.push(cell);
  }
  /** Visit a cell she can stand in. */
  visitIfStands(x: number, y: number, z: number): boolean {
    if (!this.stands(x, y, z)) return false;
    this.visit({ x, y, z });
    return true;
  }
  drain(): void {
    for (let spent = 0; this.queue.length && spent < BUDGET; spent += 1) expand(this, this.queue.shift()!);
  }
}

/** A step to a neighbouring column: on the level, up one, or down up to the fall of three. */
function stepMoves(s: Search, c: Cell, dx: number, dz: number): void {
  const { x, y, z } = c;
  const tx = x + dx, tz = z + dz;
  s.visitIfStands(tx, y, tz);
  if (s.passable(x, y + 2, z)) s.visitIfStands(tx, y + 1, tz);
  if (!s.passable(tx, y, tz) || !s.passable(tx, y + 1, tz)) return;
  for (let drop = 1; drop <= MAX_FALL; drop += 1) {
    if (!s.passable(tx, y - drop + 1, tz)) return;
    if (s.visitIfStands(tx, y - drop, tz)) return;
  }
}

/** A run over a gap (the walk's safe parkour): up to MAX_JUMP cells along a line, one level up or down at most, with the arc clear. */
function jumpMoves(s: Search, c: Cell, dx: number, dz: number): void {
  const { x, y, z } = c;
  for (let jump = 2; jump <= MAX_JUMP; jump += 1) {
    // The three cells over the floor she runs from, in every column up to the landing, are clear (a step up wants a fourth).
    const clear = [1, 2, 3, 4].slice(0, jump).every(step => [0, 1, 2].every(rise => s.passable(x + dx * step, y + rise, z + dz * step)));
    if (!clear) return;
    const lx = x + dx * jump, lz = z + dz * jump;
    s.visitIfStands(lx, y, lz);
    if (s.passable(lx, y + 3, lz)) s.visitIfStands(lx, y + 1, lz);
    s.visitIfStands(lx, y - 1, lz);
  }
}

/** Straight down a shaft (a fall of up to three through clear cells onto a place to stand), and up or down a ladder or in water. */
function columnMoves(s: Search, c: Cell): void {
  const { x, y, z } = c;
  for (let drop = 1; drop <= MAX_FALL; drop += 1) {
    if (!s.passable(x, y - drop + 1, z) || !s.passable(x, y - drop + 2, z)) break;
    if (s.visitIfStands(x, y - drop, z)) break;
  }
  for (const rise of [1, -1]) {
    const here = s.view.symbol(x, y, z) ?? '', there = s.view.symbol(x, y + rise, z) ?? '';
    const climbs = STANDS.has(here) || STANDS.has(there);
    if (climbs && s.passable(x, y + rise, z) && s.passable(x, y + rise + 1, z)) s.visit({ x, y: y + rise, z });
  }
}

function expand(s: Search, c: Cell): void {
  for (const [dx, dz] of DIRECTIONS) {
    const cardinal = dx === 0 || dz === 0;
    // The corner cells of a diagonal: one of them must let her round.
    const roundX = s.passable(c.x + dx, c.y, c.z) && s.passable(c.x + dx, c.y + 1, c.z);
    const roundZ = s.passable(c.x, c.y, c.z + dz) && s.passable(c.x, c.y + 1, c.z + dz);
    if (!cardinal && !roundX && !roundZ) continue;
    stepMoves(s, c, dx, dz);
    if (cardinal) jumpMoves(s, c, dx, dz);
  }
  columnMoves(s, c);
}

/** Every standing place at the map's edge (an unknown cell next to it): out beyond the map she can walk to all of them. */
function edgeCells(s: Search): Cell[] {
  const edges: Cell[] = [];
  for (const [layer, cells] of s.view.layers.layers) {
    for (const cell of cells.keys()) {
      const [x, z] = cell.split(',').map(Number) as [number, number];
      const known = (dx: number, dy: number, dz: number) => s.view.known(x + dx, layer + dy, z + dz);
      const open = !known(1, 0, 0) || !known(-1, 0, 0) || !known(0, 0, 1) || !known(0, 0, -1) || !known(0, 1, 0) || !known(0, -1, 0);
      if (open && s.stands(x, layer, z)) edges.push({ x, y: layer, z });
    }
  }
  return edges;
}

export function routeAnswer(view: MapView, from: Cell, to: Cell): RouteAnswer {
  const s = new Search(view);
  const key = (c: Cell) => `${c.x},${c.y},${c.z}`;
  s.visit(from);
  s.drain();
  if (!s.seen.has(key(to)) && s.escaped) {
    for (const edge of edgeCells(s)) s.visit(edge);
    s.drain();
  }
  let nearest = from, best = Infinity;
  for (const c of s.seen.values()) {
    const d = Math.hypot(c.x - to.x, c.y - to.y, c.z - to.z);
    if (d >= best) continue;
    best = d;
    nearest = c;
  }
  return { reachable: s.seen.has(key(to)), found: s.seen.size, nearest };
}

/** What stands in the way of a step to a neighbouring column, said from the map, or null. */
function stepWhy(view: MapView, from: Cell, to: Cell): string | null {
  const sym = view.symbol;
  const dy = to.y - from.y;
  const name = (c: Cell) => `${posText(c)} ${word(sym(c.x, c.y, c.z))}`;
  const shut = (cells: Cell[]) => cells.filter(c => blocked(sym(c.x, c.y, c.z)));
  if (dy <= -1 && dy >= -3) {
    const cells = shut([{ x: to.x, y: from.y, z: to.z }, { x: to.x, y: from.y + 1, z: to.z }]);
    const by = -dy === 1 ? '' : ` ${-dy} 段`;
    const need = '隣の足と頭の 2 マス（今の足と頭の高さ）が空いている必要があるが';
    return cells.length ? `1 歩${by}下りるには、${need} ${cells.map(name).join('・')} が塞がっている` : null;
  }
  if (dy >= 2) return `着く所は足より ${dy} 上（walk の上りは 1 段まで）`;
  if (dy !== 1) return null;
  const cells = shut([{ x: from.x, y: from.y + 2, z: from.z }, to, { x: to.x, y: to.y + 1, z: to.z }]);
  const need = '頭の上と着く所の足・頭の 3 マスが空いている必要があるが';
  return cells.length ? `1 段上るには、${need} ${cells.map(name).join('・')} が塞がっている` : null;
}

/** What stands in the way, said from the map: for a neighbouring target the cells of the step, else the nearest standing place and the cell past it. */
export function routeWhy(view: MapView, from: Cell, to: Cell, answer: RouteAnswer): string {
  const sym = view.symbol;
  if (Math.abs(to.x - from.x) + Math.abs(to.z - from.z) === 1) {
    const step = stepWhy(view, from, to);
    if (step) return step;
  }
  const r = answer.nearest;
  const toward = { x: r.x + Math.sign(to.x - r.x), y: r.y, z: r.z + Math.sign(to.z - r.z) };
  const past = [toward, { ...toward, y: toward.y + 1 }].filter(c => blocked(sym(c.x, c.y, c.z)));
  const names = past.map(c => `${posText(c)} ${word(sym(c.x, c.y, c.z))}`).join('・');
  const first = `地図の中で掘らず置かずに行ける所は ${answer.found} マス、着く所に最も近い (${r.x},${r.y},${r.z}) から先`;
  return `${first}${past.length ? `の ${names} が塞がっている` : 'へ進む道が地図に無い'}`;
}
