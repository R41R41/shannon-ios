import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { HandStop } from './minecraftLlmcHandGuards.js';
import { BODY_RULES, mapView, readLayers, type MapView } from './minecraftLlmcPreflightMap.js';
import { isHard, keyOf, nameOf, ptText, type P } from './minecraftLlmcWalkRules.js';

/**
 * mb-llmc v2 (実走36: 黒曜石づくり p7.2 で約 470 秒。置いた水が自分の通路に流れ込み、水中の dig は 1 マス 6〜7 秒、汲み戻しの use が 7 回
 * 「目との間が deepslate」「5m の届き外」で通らず、体の「溶岩が流れ込む」と「届かない」が交互に出た): 水・溶岩・黒曜石の事実を地図から書く
 * (`liquidLines`、live の `body.liquid`) と、届かない・見通せない源への bucket の use を送る前に止める (`useReachStop`)。
 * 地図の記号 (w 水源 / - 流れる水 / L 溶岩源 / l 流れる溶岩 / O 黒曜石) と足の位置だけから作る。事実だけで、手は決めない。
 */
const EYE = 1.62;
/**
 * How far dig, place, use, chest, furnace and craft reach: one number (mb-llmc-cand 2, `utils/blockReach.ts` `BLOCK_REACH`), measured from the
 * eye (the feet + 1.62) to the middle of the block. The body stops a hand beyond it without trying, so a bucket's use held beyond it
 * is a stop the body would have made.
 */
export const USE_REACH = 5.0;
/** What the run measured: a dig of a cell in water takes about 6 seconds, in air about 1. */
const WATER_DIG = '水中のマスの dig は 1 マス 6 秒ほど（空気中は約 1 秒）、流れの中の walk は同じマスで進めないことがある';
const RANGE = 7, SHOWN = 3;

interface Found { cell: P; reach: number; between: string | null }
interface Eye { x: number; y: number; z: number }

/** Every cell of the map with one of the symbols, within RANGE blocks across and 6 up or down of her feet. */
function cellsOf(view: MapView, feet: P, symbols: ReadonlySet<string>): P[] {
  const out: P[] = [];
  for (const [y, layer] of view.layers.layers) {
    if (Math.abs(y - feet.y) > 6) continue;
    for (const [key, symbol] of layer) {
      if (!symbols.has(symbol)) continue;
      const [x, z] = key.split(',').map(Number) as [number, number];
      if (Math.abs(x - feet.x) <= RANGE && Math.abs(z - feet.z) <= RANGE) out.push({ x, y, z });
    }
  }
  return out;
}
const center = (cell: P): Eye => ({ x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 });
const meters = (eye: Eye, cell: P): number => Math.hypot(center(cell).x - eye.x, center(cell).y - eye.y, center(cell).z - eye.z);

/** The first hard cell on the straight line from the eye to the cell's middle (her own two cells and the cell itself left out), or null. */
export function blockBetween(view: MapView, eye: Eye, target: P, feet: P): P | null {
  const to = center(target), length = Math.hypot(to.x - eye.x, to.y - eye.y, to.z - eye.z);
  const skip = new Set([keyOf(target), keyOf(feet), keyOf({ ...feet, y: feet.y + 1 })]);
  for (let at = 0.2; at < length; at += 0.1) {
    const cell = { x: Math.floor(eye.x + (to.x - eye.x) * at / length), y: Math.floor(eye.y + (to.y - eye.y) * at / length),
      z: Math.floor(eye.z + (to.z - eye.z) * at / length) };
    if (!skip.has(keyOf(cell)) && isHard(view.symbol(cell.x, cell.y, cell.z))) return cell;
  }
  return null;
}
function found(view: MapView, eye: Eye, feet: P, cell: P): Found {
  const between = blockBetween(view, eye, cell, feet);
  return { cell, reach: meters(eye, cell), between: between ? `${ptText(between)} ${nameOf(view.symbol(between.x, between.y, between.z))}` : null };
}
const nearest = (view: MapView, eye: Eye, feet: P, cells: P[]): Found[] => cells.map(cell => found(view, eye, feet, cell))
  .sort((a, b) => a.reach - b.reach).slice(0, SHOWN);
const reachWord = (item: Found): string => item.reach > USE_REACH ? `届かない（${USE_REACH}m まで）`
  : item.between ? `間に ${item.between}` : '届く';
const listing = (items: Found[]): string => items.map(item => `${ptText(item.cell)} 目から ${item.reach.toFixed(1)}m・${reachWord(item)}`).join(' / ');

/**
 * Water, lava and obsidian near her, from the map: the sources she can pour or draw from (with the distance from the eye and whether the line
 * is clear), how many cells flow, and the measured cost of a dig in water. Empty when the map shows none of them within range.
 */
export function liquidLines(view: MapView, feet: P): string[] {
  const eye = { x: feet.x + 0.5, y: feet.y + EYE, z: feet.z + 0.5 };
  const sources = cellsOf(view, feet, new Set(['w'])), flows = cellsOf(view, feet, new Set(['-']));
  const lava = cellsOf(view, feet, new Set(['L'])), lavaFlows = cellsOf(view, feet, new Set(['l'])), obsidian = cellsOf(view, feet, new Set(['O']));
  const lines: string[] = [];
  if (sources.length || flows.length) {
    lines.push(`水: 源 ${sources.length} マス・流れ ${flows.length} マス（足の周り ${RANGE} マス内）。${WATER_DIG}`);
    if (sources.length) lines.push(`水の源（汲み戻せる）: ${listing(nearest(view, eye, feet, sources))}`);
  }
  if (lava.length || lavaFlows.length) {
    lines.push(`溶岩: 源 ${lava.length} マス・流れ ${lavaFlows.length} マス${lava.length ? `。近い源: ${listing(nearest(view, eye, feet, lava))}` : ''}`);
  }
  if (obsidian.length) lines.push(`黒曜石 ${obsidian.length} マス: ${listing(nearest(view, eye, feet, obsidian))}`);
  return lines;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
/** Hands that move her somewhere not known or change what stands between: a use after one of them is not judged (a walk: `afterWalk`). */
const MOVES = new Set(['go', 'pillarUp', 'jump', 'dig', 'place', 'pickup', 'attack', 'shoot', 'chest', 'furnace', 'craft']);
/** Where an exact walk (one with a range under 1, to a cell or along a path) leaves her: the cell, or null (a loose one, a relative one). */
function afterWalk(hand: Rec): P | null {
  const last = Array.isArray(hand.path) && hand.path.length ? rec(hand.path.at(-1)) : rec(hand.to);
  const range = num(hand.range) ?? 0.5;
  if (!last || hand.rel === true || range >= 1) return null;
  const cell = { x: Math.floor(Number(last.x)), y: Math.floor(Number(last.y)), z: Math.floor(Number(last.z)) };
  return [cell.x, cell.y, cell.z].every(Number.isFinite) ? cell : null;
}

/**
 * A bucket's use (water, lava or empty) at a cell out of her reach, or with a hard block between the eye and the cell: the first such hand, held
 * before it is sent (the body says 「目との間が deepslate」/「届かない」 after trying). Judged from where the hands before it leave her (the frame's
 * position, then each exact walk's cell), for a use that nothing before it digs, places or moves loosely; on a map drawn for her feet. Facts only:
 * how to get a clear line is the decision's.
 */
export function useReachStop(input: unknown, frame: BodyObservation | null): HandStop | null {
  const world = rec(frame?.state.world), at = rec(world?.position);
  const x = num(at?.x), y = num(at?.y), z = num(at?.z);
  const layers = typeof world?.localMap === 'string' ? readLayers(world.localMap, BODY_RULES) : null;
  const hands = Array.isArray(rec(input)?.hands) ? rec(input)!.hands as unknown[] : [];
  if (!layers || x === null || y === null || z === null) return null;
  const feet = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  if (keyOf(feet) !== keyOf(layers.feet)) return null;
  const view = mapView(layers);
  let stand = feet, eye = { x, y: y + EYE, z };
  for (const [index, raw] of hands.entries()) {
    const hand = rec(raw);
    if (!hand) continue;
    if (MOVES.has(String(hand.do))) break;
    if (hand.do === 'walk') {
      const there = afterWalk(hand);
      if (!there) break;
      stand = there;
      eye = { x: there.x + 0.5, y: there.y + EYE, z: there.z + 0.5 };
      continue;
    }
    const cell = bucketTarget(hand, view);
    const stop = cell ? reachStop(index + 1, String(hand.item), view, eye, stand, cell) : null;
    if (stop) return stop;
  }
  return null;
}
/** The cell a bucket's use names, when the hand is one and the map shows the cell. */
function bucketTarget(hand: Rec, view: MapView): P | null {
  const target = Array.isArray(hand.at) ? rec(hand.at[0]) : null;
  if (hand.do !== 'use' || hand.rel === true || typeof hand.item !== 'string' || !/bucket$/u.test(hand.item) || !target) return null;
  const cell = { x: Number(target.x), y: Number(target.y), z: Number(target.z) };
  return [cell.x, cell.y, cell.z].every(Number.isFinite) && view.known(cell.x, cell.y, cell.z) ? cell : null;
}
function reachStop(hand: number, item: string, view: MapView, eye: Eye, feet: P, cell: P): HandStop | null {
  const reach = meters(eye, cell);
  const symbol = view.symbol(cell.x, cell.y, cell.z), what = `${ptText(cell)}（${nameOf(symbol)}）`;
  if (reach > USE_REACH) {
    return { hand, kind: 'use', code: 'use_reach', line: `${item} の use: ${what} は目から ${reach.toFixed(1)}m（dig・place・use は ${USE_REACH}m まで）。`
      + `${ptText(cell)} の ${USE_REACH}m 内に立ってから use する（先に walk）` };
  }
  const between = blockBetween(view, eye, cell, feet);
  if (!between) return null;
  const wall = `${ptText(between)} ${nameOf(view.symbol(between.x, between.y, between.z))}`;
  return { hand, kind: 'use', code: 'use_blocked', line: `${item} の use: 目から ${what} への線の間に ${wall} がある`
    + '（use は目からそのマスの面が見える所で。間のブロックを先に dig するか、見通せる立ち位置へ）' };
}
