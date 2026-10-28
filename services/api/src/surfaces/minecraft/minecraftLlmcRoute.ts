import type { MapView } from './minecraftLlmcPreflightMap.js';
import { doneRange, readWhere, type PlanFactsNode } from './minecraftPlanFacts.js';
import { bestStep, cornerOk, digWords, DIRS, isHard, isHarm, isOpen, keyOf, NAME, nameOf, nearestStand, ptText } from './minecraftLlmcWalkRules.js';
import { standNeighbours, stepOptions, type P } from './minecraftLlmcWalkRules.js';

/**
 * mb-llmc v2 `route` (改修案 2.2; 再現台 v9b の `body.route`): the way to the place the plan's current node names, from the map alone.
 * Facts only: where she can get to without digging, and with up to k cells dug, the nearest standing place to the goal, the points of the way
 * and the cells to dig. The walk's rules are the preflight's and the body's `probe path` (`minecraftLlmcWalkRules.ts`, plus the run over a
 * gap of up to three cells with the arc clear, as `minecraftLlmcPreflightRoute.ts`). Whether an enemy sees the way, and her health, are not
 * in it. The goal is read from the node's own `where`, the place it begins with (`goalOf`, `readWhere`): the replay took a bed named in another sentence of the node once.
 */
export interface Reach { cell: P; digs: number; steps: number; prev: string | null; dig: P[] }
const MAX_JUMP = 4;
const DIG_LIMIT = 6;

/** Every standing place she can get to from `feet` with at most `maxDigs` cells dug, the fewest digs first (the map's cells only). */
export function reachable(view: MapView, feet: P, maxDigs = DIG_LIMIT): Map<string, Reach> {
  const best = new Map<string, Reach>();
  const start: Reach = { cell: feet, digs: 0, steps: 0, prev: null, dig: [] };
  best.set(keyOf(feet), start);
  const heap = [start];
  const better = (a: Reach, b: Reach) => a.digs < b.digs || (a.digs === b.digs && a.steps < b.steps);
  while (heap.length) {
    heap.sort((a, b) => a.digs - b.digs || a.steps - b.steps);
    const at = heap.shift()!;
    if (best.get(keyOf(at.cell)) !== at) continue;
    for (const next of movesFrom(view, at)) {
      if (next.digs > maxDigs) continue;
      const known = best.get(keyOf(next.cell));
      if (known && !better(next, known)) continue;
      best.set(keyOf(next.cell), next);
      heap.push(next);
    }
  }
  return best;
}
/** The places one move from `at`: a step in eight directions (digging what it needs), and a run over a gap in four. */
function movesFrom(view: MapView, at: Reach): Reach[] {
  const out: Reach[] = [];
  for (const dir of DIRS) {
    const diagonal = dir.dx !== 0 && dir.dz !== 0;
    if (diagonal && !cornerOk(view, at.cell, dir.dx, dir.dz)) continue;
    const option = bestStep(stepOptions(view, at.cell, at.cell.x + dir.dx, at.cell.z + dir.dz));
    if (option) out.push({ cell: option.to, digs: at.digs + option.dig.length, steps: at.steps + 1, prev: keyOf(at.cell), dig: option.dig });
    if (!diagonal) out.push(...jumpsFrom(view, at, dir));
  }
  return out;
}
/** A run over a gap: a line of two to four cells, the three cells over each clear, landing on a floor on the level (no digging). */
function jumpsFrom(view: MapView, at: Reach, dir: { dx: number; dz: number }): Reach[] {
  const out: Reach[] = [];
  const { x, y, z } = at.cell;
  const passable = (px: number, py: number, pz: number) => isOpen(view.symbol(px, py, pz));
  for (let jump = 2; jump <= MAX_JUMP; jump += 1) {
    const clear = Array.from({ length: jump }, (_, i) => i + 1)
      .every(step => [0, 1, 2].every(rise => passable(x + dir.dx * step, y + rise, z + dir.dz * step)));
    if (!clear) break;
    const to = { x: x + dir.dx * jump, y, z: z + dir.dz * jump };
    const floor = view.symbol(to.x, y - 1, to.z);
    if (floor !== undefined && !isOpen(floor)) out.push({ cell: to, digs: at.digs, steps: at.steps + 1, prev: keyOf(at.cell), dig: [] });
  }
  return out;
}
/** The points of the way to a cell, and the cells dug on it (in order). */
export function pathTo(reach: Map<string, Reach>, cell: P): { points: P[]; dig: P[] } {
  const points: P[] = [], dig: P[] = [], seen = new Set<string>();
  for (let at: Reach | undefined = reach.get(keyOf(cell)); at; at = at.prev ? reach.get(at.prev) : undefined) {
    points.unshift(at.cell);
    for (const cell2 of [...at.dig].reverse()) {
      if (seen.has(keyOf(cell2))) continue;
      seen.add(keyOf(cell2));
      dig.unshift(cell2);
    }
  }
  return { points, dig };
}
/** The points of a way, only where it turns and where it ends (usable as a walk's `path`). */
export function pointsText(points: readonly P[]): string {
  if (points.length <= 2) return points.map(ptText).join('→');
  const keep: P[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    if (b.x - a.x !== c.x - b.x || b.z - a.z !== c.z - b.z || b.y - a.y !== c.y - b.y) keep.push(b);
  }
  keep.push(points.at(-1)!);
  return keep.map(ptText).join('→');
}

export interface Goal { at: P; range: number }
/**
 * The goal of the plan's current node, from the node's own fields (chapter 7: the live's shown line is not read): the place its `where` begins with
 * (`readWhere`: `195,66,60`, `(196,69,237) 村の北`; a coordinate that is not first in the text is not the node's place), and the range of a done-condition
 * `at:x,y,z~N` of the same node (1 when it has none). Null when the node names no place by coordinates.
 */
export function goalOf(node: Pick<PlanFactsNode, 'where' | 'doneWhen'> | null | undefined): Goal | null {
  const at = readWhere(node?.where, 'goal');
  return at ? { at, range: doneRange(node?.doneWhen) ?? 1 } : null;
}

const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const horizontal = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z);
const digText = digWords;

/** The nearest reached place to the goal among those within `k` digs. */
function nearest(reach: Map<string, Reach>, goal: P, k: number): Reach | null {
  const dist = (c: P) => Math.hypot(c.x - goal.x, c.y - goal.y, c.z - goal.z);
  let top: Reach | null = null;
  for (const item of reach.values()) {
    if (item.digs > k) continue;
    const closer = !top || dist(item.cell) < dist(top.cell) - 1e-9;
    const tie = top && Math.abs(dist(item.cell) - dist(top.cell)) < 1e-9 && (item.digs < top.digs || (item.digs === top.digs && item.steps < top.steps));
    if (closer || tie) top = item;
  }
  return top;
}
/** One candidate's line. */
function candidateLine(view: MapView, reach: Map<string, Reach>, top: Reach, goal: Goal, k: number, arrived: boolean): string {
  const route = pathTo(reach, top.cell);
  const where = `${ptText(top.cell)}（目的地まで 水平 ${horizontal(top.cell, goal.at).toFixed(1)}m・高さ ${sign(goal.at.y - top.cell.y)}）`;
  const walk = top.steps ? `道の点 ${pointsText(route.points)}` : '足のマスのまま（掘らずに歩ける隣が無い）';
  const dig = route.dig.length ? `。掘るマス（${route.dig.length}）: ${digText(view, route.dig)}` : '';
  return `${k === 0 ? '掘らずに行ける範囲の、' : `掘り ${route.dig.length} マスまで許した時の、`}目的地に最も近い立ち位置 ${arrived ? '（目的地に着く）' : ''}${where}。${walk}${dig}`;
}
/**
 * Where to walk to: the goal's own cell when she can stand there (or the map does not show it), else a standing place beside it. A trunk, a rock or
 * a wall as the node's place cannot be stood in (the body stops 「一歩ではない」: 11 times in run 35). The reached place with the fewest digs
 * first, else the nearest to her feet; none beside it: the goal as it was and a line that says so.
 */
function aimOf(view: MapView, goal: Goal, reach: Map<string, Reach>, feet: P): { aim: Goal; words: string | null } {
  const symbol = view.symbol(goal.at.x, goal.at.y, goal.at.z);
  if (symbol === undefined || !(isHard(symbol) || isHarm(symbol))) return { aim: goal, words: null };
  const beside = standNeighbours(view, goal.at);
  const cost = (c: P) => reach.get(keyOf(c))!;
  const reached = beside.filter(c => reach.has(keyOf(c))).sort((a, b) => cost(a).digs - cost(b).digs || cost(a).steps - cost(b).steps);
  const stand = reached[0] ?? nearestStand(view, goal.at, feet);
  const solid = `目的地のマス ${ptText(goal.at)} は${isHarm(symbol) ? '入れない' : '固い'}（${nameOf(symbol)}）`;
  if (!stand) return { aim: goal, words: `${solid}。隣の立てるマスは地図に無い（周りも固いか、地図の外）` };
  return { aim: { at: stand, range: 1 }, words: `${solid}。隣の立てるマス ${ptText(stand)} を行き先にする（${reached[0] ? '行ける' : '今の道では行けない'}）` };
}
/**
 * mb-llmc-cand 11 (s47: a node's place 115 m away, the lines below it written as for a place near; the answer ended with a walk of 115 m that stopped at the
 * first wall): when the goal is outside the map, what is not known: the way out there is not on the map, and a walk neither digs nor lays a block.
 */
const outsideWords = (meters: number): string => `目的地は地図の外（水平 ${meters.toFixed(0)}m）: そこまでの道は地図に無く、不明。`
  + 'walk は掘らず置かないので、遠い点を渡しても途中の壁で止まる。下の立ち位置までが地図で分かる所（そこへの dig と walk までが、今この地図で言える手）';
/** The way to the goal: where she gets to without digging, then with more cells dug while that brings her at least a block nearer (four lines at most). */
export function routeLines(view: MapView, feet: P, goal: Goal, label: string): string[] {
  const reach = reachable(view, feet, DIG_LIMIT);
  const { aim, words } = aimOf(view, goal, reach, feet);
  const dist = (c: P) => Math.hypot(c.x - aim.at.x, c.y - aim.at.y, c.z - aim.at.z);
  const inMap = view.known(goal.at.x, goal.at.y, goal.at.z);
  const lines = [`計画 ${label} の目的地 ${ptText(goal.at)}（足から 水平 ${horizontal(feet, goal.at).toFixed(1)}m・高さ ${sign(goal.at.y - feet.y)}。`
    + `${inMap ? '地図の中' : '地図の外'}${goal.range > 1 ? `。済みの条件は目的地の ${goal.range}m 以内` : ''}）。`
    + '地図はこの判断の始めの frame。歩きの決まりは walk と同じ（掘らず置かず、上り 1・下り 3 まで、2〜4 マスの空きは走って越える）。敵に見られるかは含まない',
    ...words ? [words] : [], ...inMap ? [] : [outsideWords(horizontal(feet, goal.at))]];
  let previous = Infinity, shown = 0;
  for (let k = 0; k <= DIG_LIMIT && shown < 4; k += 1) {
    const top = nearest(reach, aim.at, k);
    if (!top || (k > 0 && dist(top.cell) > previous - 1)) continue;
    previous = dist(top.cell);
    shown += 1;
    const arrived = dist(top.cell) <= Math.max(aim.range, 0.9);
    lines.push(candidateLine(view, reach, top, aim, k, arrived));
    if (arrived) break;
  }
  if (shown === 1 && lines.length === 2) lines.push('掘り 6 マスまで許しても、これより目的地に近づく立ち位置は地図の中に無い（地図の外へ出る道は含まない）');
  return lines;
}
