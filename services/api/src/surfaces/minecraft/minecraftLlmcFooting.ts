import type { ActPos } from '../../contracts/minecraftActContract.js';
import { readProbeResult, type ProbeInput } from '../../contracts/minecraftProbeContract.js';

/**
 * mb-llmc r8 (run 32, 2026-10-22: a one-wide bridge over the Nether's lava sea, 24–30 blocks of air under it; a wither skeleton on the
 * fortress above hit her three times in 2.3 s and the third knock put her off the bridge; the map reaches only two layers down, so the
 * drop under the bridge was not on it): the footing, one line of the live state (`footing`), made by the code from the facts alone.
 *
 * - `footingFromMap`: the cells round her feet (the eight neighbours) that have no floor to stand on, read from the map the body drew
 *   (layers: the feet's layer and the two under it; surface: the top grid's height codes), with the drop where the map shows it.
 * - `footingProbes`: where the map cannot say how deep (air in the lowest layer it draws), the body's `column` probe for that cell (at
 *   most two a decision, `FOOTING_PROBES`); an answer is kept for the cell (`keepColumnFact`).
 * - `footingLine`: 「足場: 幅 1 の橋・両脇（北・南）とも空所（落差 28、下は溶岩）。押されたら落ちる」. Null when there is no gap that would hurt
 *   (a step of 2 or less with a floor to land on).
 * Facts only: what to do with them (go back, wall the sides, stay away from the edge) is the decision's, with the knowledge's words.
 */
export const FOOTING_PROBES = Object.freeze({ max: 2, depth: 60, kept: 48, hurtsFrom: 3 });

/** The symbols she can stand in or pass (air, grass, a torch, a ladder, a rail, a portal, fire, a web, a creature's feet or her own). */
const OPEN = new Set(['.', '*', ',', '!', 'm', '@', 't', 'h', '=', 'f', 'x', 'p', 'k']);
const WATER = new Set(['w', '-']);
const LAVA = new Set(['L', 'l']);
const DIRECTIONS: ReadonlyArray<readonly [number, number, string]> = [[0, -1, '北'], [1, -1, '北東'], [1, 0, '東'], [1, 1, '南東'],
  [0, 1, '南'], [-1, 1, '南西'], [-1, 0, '西'], [-1, -1, '北西']];
const HEIGHT_BELOW = 'abcdefghi';

type Bottom = 'lava' | 'water' | 'floor' | null;
export interface FootingGap { dx: number; dz: number; at: ActPos; name: string; drop: number; deeper: boolean; bottom: Bottom }
export interface Footing {
  feet: ActPos;
  /** The neighbours with no floor under them (a step of 1 or 2 included: `footingLine` leaves those out). */
  gaps: FootingGap[];
  /** The neighbours that are floor, and those the map does not show (unloaded or past its edge). */
  floors: number; unknown: number;
}

interface Grid { cells: Map<string, string> }
export interface Drawn { feet: ActPos; mode: string; layers: Map<number, Grid>; top: Grid | null }
const HEADER = /^地図 v1 足=\((-?\d+),(-?\d+),(-?\d+)\) x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+) 方式=(\w+)/u;
const LAYER = /^y=(-?\d+)(?: x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+))?\s*$/u;
const ROW = /^\s*(-?\d+) (.+)$/u;

/** The map text as grids of its cells by block (`x,z`): the layers by y, and in the surface form the top grid of symbol+height cells. */
export function readMap(map: string | undefined): Drawn | null {
  const lines = (map ?? '').split('\n');
  const head = HEADER.exec(lines[0] ?? '');
  if (!head) return null;
  const feet = { x: Number(head[1]), y: Number(head[2]), z: Number(head[3]) }, headerX = Number(head[4]);
  const layers = new Map<number, Grid>();
  let top: Grid | null = null;
  let current: { grid: Grid; minX: number } | null = null, y: number | null = null;
  for (const line of lines.slice(1)) {
    const layer = LAYER.exec(line);
    if (layer) {
      y = Number(layer[1]);
      current = { grid: { cells: new Map() }, minX: layer[2] !== undefined ? Number(layer[2]) : headerX };
      layers.set(y, current.grid);
      continue;
    }
    if (line.startsWith('縦 ')) break;
    const row = ROW.exec(line);
    if (!row) continue;
    const surface = current === null && head[8] === 'surface';
    if (surface) top ??= { cells: new Map() };
    const target = surface ? { grid: top!, minX: headerX } : current;
    if (!target) continue;
    row[2]!.split(' ').forEach((cell, index) => target.grid.cells.set(`${target.minX + index},${Number(row[1])}`, cell));
  }
  return { feet, mode: head[8]!, layers, top };
}

const solid = (symbol: string) => !OPEN.has(symbol) && !WATER.has(symbol) && !LAVA.has(symbol) && symbol !== '?';
/** r10: the symbol of a block in a drawn map, or undefined where the map does not show it (another layer, past its edge). */
export function mapSymbol(drawn: Drawn | null, x: number, y: number, z: number): string | undefined {
  return drawn?.layers.get(y)?.cells.get(`${x},${z}`);
}
/** r10: whether a block of the drawn map is solid (a wall to dig); null where the map does not say. */
export function mapSolid(drawn: Drawn | null, x: number, y: number, z: number): boolean | null {
  const symbol = mapSymbol(drawn, x, y, z);
  return symbol === undefined || symbol === '?' ? null : solid(symbol);
}
const bottomOf = (symbol: string): Bottom => LAVA.has(symbol) ? 'lava' : WATER.has(symbol) ? 'water' : 'floor';

type GapMaker = (drop: number, deeper: boolean, bottom: Bottom, name?: string) => FootingGap;
/** One neighbour in the layers form: a gap with what the map shows of its drop, 'floor', 'wall', or null (the map does not say). */
function layerCell(drawn: Drawn, dx: number, dz: number): FootingGap | 'floor' | 'wall' | null {
  const key = `${drawn.feet.x + dx},${drawn.feet.z + dz}`, at = (dy: number) => drawn.layers.get(drawn.feet.y + dy)?.cells.get(key);
  const here = at(0);
  if (here === undefined || here === '?') return null;
  if (solid(here)) return 'wall';
  const gap: GapMaker = (drop, deeper, bottom, name = '') =>
    ({ dx, dz, at: { x: drawn.feet.x + dx, y: drawn.feet.y, z: drawn.feet.z + dz }, name, drop, deeper, bottom });
  return LAVA.has(here) ? gap(0, false, 'lava', 'lava') : underFoot(at(-1), at(-2), gap);
}
/** What is under a neighbour that is open at her feet's height: a floor, lava, or a gap as deep as the two layers under the feet show. */
function underFoot(below: string | undefined, lower: string | undefined, gap: GapMaker): FootingGap | 'floor' | null {
  if (below === undefined || below === '?') return null;
  if (solid(below) || WATER.has(below)) return 'floor';
  if (LAVA.has(below)) return gap(0, false, 'lava', 'lava');
  const stops = lower !== undefined && lower !== '?' && (solid(lower) || WATER.has(lower) || LAVA.has(lower));
  return stops ? gap(1, false, bottomOf(lower), LAVA.has(lower) ? 'lava' : '') : gap(2, true, null);
}
/** One neighbour in the surface form: the height code of its top block against her feet (a–i: 1–9 below, v: 10 or more, .v: none within 12). */
function surfaceCell(drawn: Drawn, dx: number, dz: number): FootingGap | 'floor' | 'wall' | null {
  const cell = drawn.top?.cells.get(`${drawn.feet.x + dx},${drawn.feet.z + dz}`);
  if (!cell || cell.length < 2 || cell === '??') return null;
  const symbol = cell[0]!, code = cell[1]!, lava = LAVA.has(symbol);
  const gap = (drop: number, deeper: boolean): FootingGap => ({ dx, dz, at: { x: drawn.feet.x + dx, y: drawn.feet.y, z: drawn.feet.z + dz },
    name: lava ? 'lava' : '', drop, deeper, bottom: lava ? 'lava' : WATER.has(symbol) ? 'water' : null });
  if (cell === '.v') return gap(12, true);
  if (code === 'v') return gap(10, true);
  const below = HEIGHT_BELOW.indexOf(code);
  if (below >= 0) return lava || below >= 1 ? gap(below + 1, false) : 'floor';
  if (lava) return gap(0, false);
  return /[2-9+]/u.test(code) ? 'wall' : 'floor';
}

/** The footing round her feet from the map text, or null when the map is not one the code can read (no map, no feet). */
export function footingFromMap(map: string | undefined, feet: ActPos | null): Footing | null {
  const drawn = readMap(map);
  if (!drawn) return null;
  // A map drawn for another block than the frame's feet is old: it says nothing of where she stands now.
  if (feet && (Math.floor(feet.x) !== drawn.feet.x || Math.floor(feet.y) !== drawn.feet.y || Math.floor(feet.z) !== drawn.feet.z)) return null;
  const cellOf = drawn.mode === 'surface' ? surfaceCell : layerCell;
  const footing: Footing = { feet: drawn.feet, gaps: [], floors: 0, unknown: 0 };
  for (const [dx, dz] of DIRECTIONS) {
    const cell = cellOf(drawn, dx, dz);
    if (cell === null) footing.unknown += 1;
    else if (cell === 'floor') footing.floors += 1;
    else if (cell !== 'wall') footing.gaps.push(cell);
  }
  return footing;
}

/** What a `column` probe said of one cell's column below her feet: how far the air goes and what is at the bottom. */
export interface ColumnFact { drop: number; bottom: Bottom; name: string }
const airName = (name: unknown) => typeof name === 'string' && /^(?:minecraft:)?(?:air|cave_air|void_air)$/u.test(name);
/** A column probe's answer as a fact (from its text 「落差 n、底 y=… 名前」, else its runs), or null when it says neither. */
export function readColumnFact(answer: string | null | undefined, feetY: number): ColumnFact | null {
  const read = readProbeResult(answer ?? undefined) as (Record<string, unknown> & { text: string }) | null;
  if (!read) return null;
  const said = /落差\s*(\d+)(?:[、,]\s*底 y=-?\d+\s+([A-Za-z_:]+))?/u.exec(read.text);
  const runs = Array.isArray(read.runs) ? read.runs as Array<Record<string, unknown>> : [];
  const solidRun = runs.find(run => typeof run.name === 'string' && !airName(run.name));
  const name = (said?.[2] ?? (typeof solidRun?.name === 'string' ? solidRun.name : '')).replace(/^minecraft:/u, '');
  const top = typeof solidRun?.top === 'number' ? solidRun.top : null;
  const drop = said ? Number(said[1]) : top !== null ? Math.max(0, feetY - (top + 1)) : null;
  if (drop === null) return null;
  return { drop, name, bottom: /lava/u.test(name) ? 'lava' : /water/u.test(name) ? 'water' : name ? 'floor' : null };
}

export const columnKey = (at: ActPos, feetY: number) => `${at.x},${at.z}@${feetY}`;

/**
 * The gaps the map cannot measure (air in its lowest layer) as `column` probes, at most `FOOTING_PROBES.max`: the sides of a bridge first
 * (the neighbours north, east, south, west), the diagonals only when no side is open. None when a gap of this footing is already
 * measured: a measured side speaks for the rest.
 */
export function footingProbes(footing: Footing, known: (key: string) => ColumnFact | undefined): ProbeInput[] {
  const deeper = footing.gaps.filter(gap => gap.deeper);
  if (deeper.some(gap => known(columnKey(gap.at, footing.feet.y)))) return [];
  const sides = deeper.filter(gap => gap.dx === 0 || gap.dz === 0);
  return (sides.length ? sides : deeper).slice(0, FOOTING_PROBES.max)
    .map(gap => ({ kind: 'column' as const, x: gap.at.x, z: gap.at.z, yFrom: footing.feet.y - 1, yTo: Math.max(-64, footing.feet.y - FOOTING_PROBES.depth) }));
}

type Measured = FootingGap & { probed: boolean };
/** A gap with a column fact applied (the fact's drop and bottom replace the map's guess, `probed`), or as it is. */
function measured(footing: Footing, gap: FootingGap, facts: (key: string) => ColumnFact | undefined): Measured {
  const fact = gap.deeper ? facts(columnKey(gap.at, footing.feet.y)) : undefined;
  if (!fact) return { ...gap, probed: false };
  return { ...gap, drop: fact.drop, deeper: false, probed: true, bottom: fact.bottom ?? gap.bottom, name: fact.name || gap.name };
}
const hurts = (gap: FootingGap) => gap.drop >= FOOTING_PROBES.hurtsFrom || gap.bottom === 'lava' || gap.deeper;
/** The gaps as the probes' facts measure them: a side measured speaks for the neighbours the map could not measure (the deepest it found). */
function resolvedGaps(footing: Footing, facts: (key: string) => ColumnFact | undefined): FootingGap[] {
  const all = footing.gaps.map(gap => measured(footing, gap, facts));
  const speaker = all.filter(gap => gap.probed).reduce<FootingGap | null>((worst, gap) => !worst || gap.drop > worst.drop ? gap : worst, null);
  if (!speaker) return all;
  const { drop, bottom, name } = speaker;
  return all.map(gap => gap.deeper ? { ...gap, deeper: false, drop, bottom, name } : gap);
}/** The names of the directions of some gaps, in the compass order. */
const compass = (gaps: readonly FootingGap[]) => DIRECTIONS.filter(([dx, dz]) => gaps.some(gap => gap.dx === dx && gap.dz === dz)).map(item => item[2]);

/** The shape: a one-wide bridge (both sides of an axis are gaps) or the directions of the gaps, in the compass order. */
function shapeText(gaps: readonly FootingGap[]): string {
  const has = (dx: number, dz: number) => gaps.some(gap => gap.dx === dx && gap.dz === dz);
  const bridge = has(0, -1) && has(0, 1) ? ['北', '南'] : has(1, 0) && has(-1, 0) ? ['東', '西'] : null;
  return bridge ? `幅 1 の橋・両脇（${bridge.join('・')}）とも空所` : `${compass(gaps).join('・')}が空所`;
}
/** How far down and what is there; and whether a knock would throw her off (a drop of 4, lava, or a depth not measured). */
function depthText(gaps: readonly FootingGap[]): { text: string; falls: boolean } {
  const deepest = gaps.reduce((worst, gap) => gap.drop > worst.drop ? gap : worst, gaps[0]!);
  const lava = gaps.some(gap => gap.bottom === 'lava'), water = !lava && gaps.some(gap => gap.bottom === 'water');
  const unmeasured = gaps.some(gap => gap.deeper);
  const depth = unmeasured ? `落差 ${deepest.drop} 以上（深さは調べていない）` : deepest.drop > 0 ? `落差 ${deepest.drop}` : '';
  const named = deepest.name && !unmeasured ? `下は ${deepest.name}` : '';
  const under = lava ? (deepest.drop > 0 ? '下は溶岩' : '溶岩のマス') : water ? '下は水' : named;
  return { text: [depth, under].filter(Boolean).join('、'), falls: lava || deepest.drop >= 4 || unmeasured };
}

/**
 * The line, or null when no gap would hurt. The shape first, then how far down and what is there (from the probes' facts where the map did
 * not say), and that a knock throws her off.
 */
export function footingLine(footing: Footing | null, facts: (key: string) => ColumnFact | undefined = () => undefined): string | null {
  if (!footing) return null;
  const gaps = resolvedGaps(footing, facts);
  if (!gaps.some(hurts)) return null;
  const depth = depthText(gaps);
  return `足場: ${shapeText(gaps)}（${depth.text}）${depth.falls ? '。押されたら落ちる' : ''}`;
}
/**
 * The footing of a decision: from the map, with a `column` probe for each gap the map cannot measure (`run` sends one to the body; none:
 * the guess is said as a guess), waited `budgetMs` at most, the answers kept for the task. The line (or null), how many probes, the ms.
 */
export async function lookAtFooting(parts: { taskId: string; map: string | undefined; feet: ActPos | null;
  run: ((input: ProbeInput, index: number) => Promise<string | null>) | null; budgetMs: number; index: number }):
  Promise<{ line: string | null; gaps: number; asked: number; ms: number; by?: 'body' | 'map' }> {
  const began = performance.now(), footing = footingFromMap(parts.map, parts.feet);
  if (!footing) return { line: null, gaps: 0, asked: 0, ms: 0 };
  const known = keptColumnFact(parts.taskId);
  // r8: the body's own `around` says the footing (the body's 13:50 form, `footing` and the 「足場: …」 of its text); where there are gaps it is
  // asked beside the column probes (an older body does not say it: then the map's and the columns').
  const columns = parts.run ? footingProbes(footing, known) : [];
  const asking = parts.run && footing.gaps.length ? [AROUND_PROBE, ...columns] : [];
  let body = null as string | null;
  if (parts.run && asking.length) {
    const jobs = asking.map(async (probe, offset) => {
      try {
        const answer = await parts.run!(probe, parts.index + offset);
        if (probe.kind === 'around') {
          body = readAroundFooting(answer);
          return;
        }
        const fact = readColumnFact(answer, footing.feet.y);
        if (fact) keepColumnFact(parts.taskId, columnKey({ x: probe.x ?? 0, y: footing.feet.y, z: probe.z ?? 0 }, footing.feet.y), fact);
      } catch { /* no answer: the map's guess is said as a guess */ }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(jobs), new Promise<void>(resolve => { timer = setTimeout(resolve, parts.budgetMs); })]);
    clearTimeout(timer);
  }
  const ms = Math.round(performance.now() - began), gaps = footing.gaps.length;
  return body ? { line: body, gaps, asked: asking.length, ms, by: 'body' } : { line: footingLine(footing, known), gaps, asked: asking.length, ms, by: 'map' };
}

/** The body's `around` for the footing (its 13:50 form): a short radius, the creatures and dangers beside the footing it says. */
const AROUND_PROBE: ProbeInput = { kind: 'around', radius: 4 };
/**
 * The footing as the body's `around` says it: the first sentences of its text (「足場: 幅 1 の橋・左右とも空所（落差 26、下は溶岩）。押されたら
 * 落ちる。」), else its field `footing.text`; null where the body says none (no gap that hurts, or an older body).
 */
export function readAroundFooting(answer: string | null | undefined): string | null {
  const read = readProbeResult(answer ?? undefined) as (Record<string, unknown> & { text: string }) | null;
  if (!read || read.kind !== 'around') return null;
  const lead = /^(足場: [^。]+(?:。押されたら落ちる)?)。?/u.exec(read.text);
  if (lead) return lead[1]!.slice(0, 160);
  const field = (read.footing && typeof read.footing === 'object' ? (read.footing as Record<string, unknown>).text : null);
  return typeof field === 'string' && field.trim() ? `足場: ${field.replace(/^足場: /u, '').trim()}`.slice(0, 160) : null;
}

/** The kept column facts of a task (the same cell and feet height are not asked again), oldest out past `FOOTING_PROBES.kept`. */
const kept = new Map<string, Map<string, ColumnFact>>();
export const keptColumnFact = (taskId: string) => (key: string): ColumnFact | undefined => kept.get(taskId)?.get(key);
export function keepColumnFact(taskId: string, key: string, fact: ColumnFact): void {
  let task = kept.get(taskId);
  if (!task) {
    task = new Map();
    kept.set(taskId, task);
    if (kept.size > 32) kept.delete(kept.keys().next().value as string);
  }
  task.delete(key);
  task.set(key, fact);
  if (task.size > FOOTING_PROBES.kept) task.delete(task.keys().next().value as string);
}
/** For tests: no task keeps a column fact. */
export function forgetColumnFacts(): void { kept.clear(); }
