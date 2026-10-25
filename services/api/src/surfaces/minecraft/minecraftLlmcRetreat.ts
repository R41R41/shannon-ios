import { SOLID, type MapView } from './minecraftLlmcPreflightMap.js';
import { bestStep, cornerOk, DIRS, nameOf, ptText, stepOptions, type P } from './minecraftLlmcWalkRules.js';
import type { Look } from './minecraftLlmcSurfaceLook.js';

/**
 * mc-sonnet-guards (replay bench 2026-10-26, s21: a wither skeleton in sight on a one-wide bridge; the live's `away` said 「掘らずに歩ける隣は無い」
 * and named no place to go, so Sonnet 5.5 stretched the bridge west twice, as the run that died did): the nearest place she can walk to without
 * digging or laying a block where a block of the map stands between her and the hostile — a place to cut the line of sight (urgent: 「射線の中で止まらない」).
 * Facts from the map and the hostile's place, never a hand. A ray that crosses a cell the map does not show is not taken as cut.
 */
export const RETREAT_STEPS = 8;
const RETREAT_CELLS = 600;
/** Eye heights above a creature's feet cell: the hostile's (a wither skeleton 2.1, a blaze 1.5, a piglin 1.6 — taken as 1.5) and hers (1.6; the middle of her body 0.9). */
const HOSTILE_EYE = 1.5, HER_EYE = 1.6, HER_BODY = 0.9;

interface Hit { cell: P; symbol: string }
/** The first block of the map on the straight line between two points (voxel walk), the end cells not counted; null when the line is clear or crosses only open and unknown cells. */
function blockOn(look: Look, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Hit | null {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z);
  const ex = Math.floor(to.x), ey = Math.floor(to.y), ez = Math.floor(to.z);
  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  const next = (p: number, d: number, step: number) => d === 0 ? Infinity : ((step > 0 ? Math.floor(p) + 1 : Math.ceil(p) - 1) - p) / d;
  let tx = next(from.x, dx, stepX), ty = next(from.y, dy, stepY), tz = next(from.z, dz, stepZ);
  const dtx = dx === 0 ? Infinity : Math.abs(1 / dx), dty = dy === 0 ? Infinity : Math.abs(1 / dy), dtz = dz === 0 ? Infinity : Math.abs(1 / dz);
  for (let n = 0; n < 200 && !(x === ex && y === ey && z === ez); n += 1) {
    if (tx <= ty && tx <= tz) { x += stepX; tx += dtx; } else if (ty <= tz) { y += stepY; ty += dty; } else { z += stepZ; tz += dtz; }
    if (x === ex && y === ey && z === ez) break;
    const state = look(x, y, z);
    if (state.kind === 'closed' && state.symbol !== undefined && SOLID.has(state.symbol)) return { cell: { x, y, z }, symbol: state.symbol };
  }
  return null;
}

/** Whether the hostile cannot see a body standing in `cell`: both its eyes' line and its middle's are blocked by a block of the map. Returns the block on the eyes' line. */
function cutBetween(look: Look, hostile: P, cell: P): Hit | null {
  const eye = { x: hostile.x + 0.5, y: hostile.y + HOSTILE_EYE, z: hostile.z + 0.5 };
  const high = blockOn(look, eye, { x: cell.x + 0.5, y: cell.y + HER_EYE, z: cell.z + 0.5 });
  const low = high ? blockOn(look, eye, { x: cell.x + 0.5, y: cell.y + HER_BODY, z: cell.z + 0.5 }) : null;
  return high && low ? high : null;
}

function word(from: P, to: P): string {
  const parts = [[to.x - from.x, '東', '西'], [to.z - from.z, '南', '北'], [to.y - from.y, '上', '下']] as const;
  const words = parts.flatMap(([delta, plus, minus]) => delta === 0 ? [] : [`${delta > 0 ? plus : minus}${Math.abs(delta)}`]);
  return words.length ? words.join('・') : '同じマス';
}

/**
 * The retreat line of `away`: the nearest cell (by steps, then by distance) of the walk's own steps without digging (`RETREAT_STEPS` at most) from
 * where the hostile's line is cut, with the block that cuts it; or null (she is already out of its sight, or the map certifies no such cell within the steps).
 */
export function retreatLine(view: MapView, look: Look, feet: P, hostile: { id: string; name: string; at: P }): string | null {
  if (cutBetween(look, hostile.at, feet)) return null;
  const seen = new Set<string>([`${feet.x},${feet.y},${feet.z}`]);
  let frontier: P[] = [feet];
  let cells = 0;
  for (let steps = 1; steps <= RETREAT_STEPS && frontier.length; steps += 1) {
    const found: Array<{ cell: P; hit: Hit }> = [], following: P[] = [];
    for (const from of frontier) {
      for (const dir of DIRS) {
        if (dir.dx !== 0 && dir.dz !== 0 && !cornerOk(view, from, dir.dx, dir.dz)) continue;
        const best = bestStep(stepOptions(view, from, from.x + dir.dx, from.z + dir.dz));
        if (!best || best.dig.length) continue;
        const key = `${best.to.x},${best.to.y},${best.to.z}`;
        if (seen.has(key) || (cells += 1) > RETREAT_CELLS) continue;
        seen.add(key);
        following.push(best.to);
        const hit = cutBetween(look, hostile.at, best.to);
        if (hit) found.push({ cell: best.to, hit });
      }
    }
    if (found.length) {
      const near = (c: P) => Math.hypot(c.x - feet.x, c.y - feet.y, c.z - feet.z);
      const pick = found.sort((a, b) => near(a.cell) - near(b.cell))[0]!;
      return `#${hostile.id} ${hostile.name} の射線を切れる最寄りの立ち位置: ${ptText(pick.cell)}（${word(feet, pick.cell)}、歩いて ${steps} 歩。`
        + `間に ${ptText(pick.hit.cell)} ${nameOf(pick.hit.symbol)}）`;
    }
    frontier = following;
  }
  // None found: the map may not show the blocks between (above her feet the map is the top grid only); no line, never 「無い」.
  return null;
}
