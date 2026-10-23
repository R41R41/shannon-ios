import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActHand, ActPos } from '../../contracts/minecraftActContract.js';
import { columnKey, keptColumnFact } from './minecraftLlmcFooting.js';
import { BODY_RULES, mapView, PORTAL, posText, readLayers, type BodyRules, type Cell, type MapView } from './minecraftLlmcPreflightMap.js';
import { routeAnswer, routeWhy } from './minecraftLlmcPreflightRoute.js';
import { nearestStand } from './minecraftLlmcWalkRules.js';
import { placeStop, unstandable, type ColumnOf, type Found, type PreflightCode } from './minecraftLlmcPreflightStand.js';

export type { PreflightCode };

/**
 * mb-llmc act-preflight (Syzygy ADR-0014 D3 "決まりはまずコードで守る", D0 "不明は不明のまま"; owner 2026-10-23; head switch
 * SHANNON_MINECRAFT_ACT_PREFLIGHT, default off). Before an `mc.act` goes to the body, its hands are walked in order against the newest
 * frame's map (and the cell column answers the head has kept): a hand the body's own rules refuse *at its start* for a reason the map shows
 * for certain is not sent, and the fact comes back at once as the act's result. The hand is never mended and nothing is added to the act
 * (no new automatic move of the body); a cell the map does not show, a symbol that is not plain, a hand whose effect on the map is not
 * known, or a map older than the frame all leave the act as it is — the body says its own stop.
 *
 * What the body refuses at a hand's start (Shannon-mb-llmc-r10 `primitives/walk.ts`, `utils/walkRules.ts`, `primitives/place.ts`):
 * - walk, for the target and every point of a path, when its range is under one (the act's default is 0.5): `unstandable` — the feet cell is
 *   a wall or something never entered (lava, fire, cobweb, magma), the head cell likewise, or there is no floor under the feet cell
 *   (air, water or lava there: the walk does not "step down to" a target; a floor that is not under it is not its floor).
 *   The stop is `一歩ではない`. The drop of three of the walk's rules is a rule of the route between cells, not of a target.
 * - walk, when no route reaches the target without digging or laying a block even taking every cell the map does not name the way that lets
 *   her through (`minecraftLlmcPreflightRoute.ts`): the route search finds no way either (`no_path`, `段差`, `頭の高さ`, a drop past three).
 * - place, for each cell: the cell holds a block that is not replaced (`置けない`: は埋まっている), or no neighbour is a block to set against
 *   (all six faces known to be open: `置けない`: 支えになる面が無い).
 * The cells the earlier hands of the same act change are written on the map as they would be (a dig opens its cells, a place fills them);
 * a hand whose effect is not known (a `use`, a pillarUp from an unknown place) ends the walk-through there.
 */
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const cellOf = (value: unknown): Cell | null => {
  const at = value as Record<string, unknown> | null;
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } : null;
};

/** The world the walk-through reads: the frame's map text, her feet cell in the frame, and the head's kept `column` answers. */
export interface PreflightWorld {
  map: string | undefined;
  feet: ActPos | null;
  column?: ColumnOf;
  /** SHANNON_MINECRAFT_LLMC_V2: the symbols the guards did not name are read as the body's walk reads them (`BodyRules`). */
  rules?: BodyRules;
}
export interface PreflightStop {
  /** 1-based, as the result's lines count the hands. */
  hand: number;
  kind: 'walk' | 'place';
  /** The body's closed word for the stop it would have made. */
  word: '一歩ではない' | '置けない';
  code: PreflightCode;
  cell: ActPos;
  why: string;
}

/** Which of the checks are on (the route is the newest; each can be named off to see what it adds). */
export interface PreflightOptions {
  route?: boolean;
  bodyRules?: boolean;
  /**
   * SHANNON_MINECRAFT_LLMC_V2: a place with `onFail: 'continue'` that the map faults is not a stop (the body skips the cell and goes on): the fact is
   * pushed to `notes` and the walk-through ends there (what the hand then did to the map is not known).
   */
  continuePlace?: boolean;
  notes?: string[];
}

/**
 * Where she is, as far as the walk-through knows. `at`: the cell she stands in for certain. `via`: where the route search starts when she
 * does not stand at `at` for certain: a dig that walks to pick up, a walk within a range, an attack or a pickup move her only by the walk's
 * rules, so wherever she stands after them is a place the walk reaches from here — if the target is not reached from here it is not reached
 * from there either (a place she can get to from here, and the target from it, would be a way).
 */
interface Track { at: Cell | null; via: Cell | null }

/** The cells of a hand's coordinates (relative ones from her feet when the hand begins; none when she is not known to be anywhere). */
function cellsOf(list: readonly unknown[], base: Cell | null | undefined): Cell[] {
  const out: Cell[] = [];
  for (const value of list) {
    const cell = cellOf(value);
    if (!cell) continue;
    if (base === undefined) out.push(cell);
    else if (base) out.push({ x: base.x + cell.x, y: base.y + cell.y, z: base.z + cell.z });
  }
  return out;
}
const walkPoints = (hand: ActHand): readonly unknown[] => hand.path?.length ? hand.path : hand.to ? [hand.to] : [];

/** No route: the target is a standing place the map shows whole, and the search finds no way to it from where she stands (unnamed cells taken kindly). */
function noRoute(from: Cell | null, to: Cell, view: MapView): Found | null {
  const shown = [0, 1, -1].every(dy => view.known(to.x, to.y + dy, to.z));
  if (!from || !shown || (from.x === to.x && from.y === to.y && from.z === to.z)) return null;
  const answer = routeAnswer(view, from, to);
  if (answer.reachable) return null;
  return { code: 'no_route', cell: to, why: `${posText(to)} へ掘らず置かずに行く道が無い（${routeWhy(view, from, to, answer)}）` };
}

/**
 * SHANNON_MINECRAFT_LLMC_V2: a target whose own cell is a wall (a trunk, rock, a wart block) is told with the standing place beside it, nearest to
 * the feet the map was drawn for: 「隣の立てるマス (x,y,z)」, or that the map shows none.
 */
function withNeighbour(found: Found, target: Cell, view: MapView): Found {
  if (found.code !== 'feet_solid' && found.code !== 'head_solid') return found;
  const stand = nearestStand(view, target, view.layers.feet);
  return { ...found, why: `${found.why}（${stand ? `隣の立てるマス ${posText(stand)}` : '隣の立てるマスは地図に無い'}）` };
}
/** A walk's targets (a path's points, or the one): each a place no body stands in, or with no route to it from the one before. */
function walkStop(hand: ActHand, origin: Cell | null, base: Cell | null | undefined, view: MapView, world: PreflightWorld,
  options: PreflightOptions): Found | null {
  const points = cellsOf(walkPoints(hand), base);
  if (points.length !== walkPoints(hand).length) return null;
  let from = origin;
  for (const [i, cell] of points.entries()) {
    // A point other than the last has range 0; the last has the hand's range (default 0.5). A range of one or more asks no stand.
    const range = i === points.length - 1 ? (finite(hand.range) ? hand.range : 0.5) : 0;
    if (range >= 1) continue;
    // SHANNON_MINECRAFT_LLMC_V2 (run 37: the walk into the gate's cell was held, 「塞がっている」): a portal is entered by walking into it.
    if (options.bodyRules && view.symbol(cell.x, cell.y, cell.z) === PORTAL) {
      from = cell;
      continue;
    }
    const found = unstandable(cell, view, world.column) ?? (options.route !== false ? noRoute(from, cell, view) : null);
    if (found) return options.bodyRules ? withNeighbour(found, cell, view) : found;
    from = cell;
  }
  return null;
}

/** A place's cells in order: each a filled cell, or one with no face (a cell this hand placed before gives the next its face). */
function placeCellsStop(hand: ActHand, base: Cell | null | undefined, view: MapView): Found | null {
  const cells = cellsOf(hand.at ?? [], base);
  if (cells.length !== (hand.at?.length ?? 0)) return null;
  const placed = new Set<string>();
  for (const cell of cells) {
    const found = placeStop(cell, view, placed, hand.face !== undefined);
    if (found) return found;
    placed.add(`${cell.x},${cell.y},${cell.z}`);
  }
  return null;
}

function handStop(hand: ActHand, number: number, origin: Cell | null, base: Cell | null | undefined, view: MapView, world: PreflightWorld,
  options: PreflightOptions): PreflightStop | null {
  if (hand.do === 'walk') {
    const found = walkStop(hand, origin, base, view, world, options);
    return found ? { hand: number, kind: 'walk', word: '一歩ではない', ...found } : null;
  }
  if (hand.do === 'place') {
    const found = placeCellsStop(hand, base, view);
    return found ? { hand: number, kind: 'place', word: '置けない', ...found } : null;
  }
  return null;
}

/** A walk, when it goes as asked: she stands at its last cell (a range of one or more, or a cell unknown, leaves it a place the walk reaches). */
function afterWalk(hand: ActHand, track: Track, base: Cell | null | undefined): void {
  const last = cellsOf(walkPoints(hand), base).at(-1);
  const exact = !!last && !(finite(hand.range) && hand.range >= 1);
  track.at = exact ? last! : null;
  if (exact) track.via = last!;
}

/** A dig opens its cells and, by default, walks to pick up what dropped: afterwards she stands somewhere the walk reaches from here. */
function afterDig(hand: ActHand, track: Track, base: Cell | null | undefined, view: MapView): void {
  for (const cell of cellsOf(hand.at ?? [], base)) view.open(cell);
  if (hand.collect === false) return;
  track.via = track.at ?? track.via;
  track.at = null;
}

/** A place fills its cells; blocks put down can cut the ways she came by, so from a place not known for certain the route is not known any more. */
function afterPlace(hand: ActHand, track: Track, base: Cell | null | undefined, view: MapView): void {
  for (const cell of cellsOf(hand.at ?? [], base)) view.fill(cell);
  if (!track.at) track.via = null;
}

/** A pillar: the blocks go under the feet one by one. False from an unknown place (the map after it is not known). */
function afterPillar(hand: ActHand, track: Track, view: MapView): boolean {
  if (!track.at) return false;
  const rise = finite(hand.n) ? Math.max(1, Math.floor(hand.n)) : 1;
  for (let n = 0; n < rise; n += 1) view.fill({ x: track.at.x, y: track.at.y + n, z: track.at.z });
  track.at = { x: track.at.x, y: track.at.y + rise, z: track.at.z };
  track.via = track.at;
  return true;
}

/** What the hand does to the map and to where she stands, when it goes as asked. False: its effect is not known, the walk-through ends. */
function advance(hand: ActHand, track: Track, base: Cell | null | undefined, view: MapView): boolean {
  switch (hand.do) {
    case 'walk':
      afterWalk(hand, track, base);
      return true;
    case 'dig':
      afterDig(hand, track, base, view);
      return true;
    case 'place':
      afterPlace(hand, track, base, view);
      return true;
    case 'pillarUp': return afterPillar(hand, track, view);
    case 'use': return false;
    case 'attack': case 'pickup': case 'shoot': case 'drop':
      track.via = track.at ?? track.via;
      track.at = null;
      return true;
    default: return true;
  }
}

/**
 * The first hand of the act the body would refuse at its start for a reason the map shows for certain, or null (the act goes as it is).
 * `input` is the act as `llmcPrepare` leaves it.
 */
export function preflightAct(input: unknown, world: PreflightWorld, options: PreflightOptions = {}): PreflightStop | null {
  const start = startOf(input, world);
  if (!start) return null;
  const { hands, view, track } = start;
  for (const [index, raw] of hands.entries()) {
    const hand = raw as ActHand | null;
    if (!hand || typeof hand !== 'object') return null;
    // Relative cells count from where she stands when the hand begins: not known, the hands after it cannot be walked through.
    if (hand.rel === true && !track.at) return null;
    const base: Cell | null | undefined = hand.rel === true ? track.at : undefined;
    const stop = handStop(hand, index + 1, track.at ?? track.via, base, view, world, options);
    if (stop && options.continuePlace && stop.kind === 'place' && hand.onFail === 'continue') {
      options.notes?.push(`手 ${stop.hand} place: ${stop.why}。onFail continue なので体は飛ばして続ける（この手の他のマスは置く）`);
      return null;
    }
    if (stop) return stop;
    if (!advance(hand, track, base, view)) return null;
  }
  return null;
}

/** The hands, the map with its overlay and where she stands, when the act and the frame can be walked through at all. */
function startOf(input: unknown, world: PreflightWorld): { hands: unknown[]; view: MapView; track: Track } | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const layers = readLayers(world.map, world.rules);
  const feet = world.feet ? cellOf(world.feet) : null;
  if (!Array.isArray(hands) || !layers || !feet) return null;
  // A map drawn for another cell than the frame's feet is older than the frame: it says nothing of the world now.
  if (feet.x !== layers.feet.x || feet.y !== layers.feet.y || feet.z !== layers.feet.z) return null;
  return { hands, view: mapView(layers), track: { at: feet, via: feet } };
}

/** The preflight of an act against the newest frame of the body (its map, her feet) and the column answers the head kept for the task. */
export function preflightOfFrame(input: unknown, frame: BodyObservation | null, taskId: string, options?: PreflightOptions): PreflightStop | null {
  const world = frame?.state.world as { localMap?: unknown; dimension?: unknown; position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined;
  const at = world?.position;
  const feet = at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
  const facts = keptColumnFact(taskId);
  const map = typeof world?.localMap === 'string' ? world.localMap : undefined;
  const rules = options?.bodyRules ? BODY_RULES : undefined;
  return preflightAct(input, { map, feet, ...(rules ? { rules } : {}), column: (cell, feetY) => facts(columnKey(cell, feetY)) }, options);
}

/** The act's result when it is held: the body's closed word first, the hand, the fact, and that the body was sent nothing. */
export function preflightText(stop: PreflightStop): string {
  const how = stop.kind === 'walk'
    ? 'walk は掘らず置かない。先に dig か place で足と頭の 2 マスと床を整えるか、別の道・別の着く所へ'
    : stop.code === 'occupied' ? '置く必要が無いか、別のマスへ' : '固いブロックに接するマスから順に置く';
  return `送る前に止めた（体には何も送っていない。手は 1 つも動いていない）: 手 ${stop.hand} ${stop.kind} ${stop.word}: ${stop.why}（地図で確かめた）。${how}。`;
}
export type { Cell };

/**
 * Where she stands after the first `count` hands of the act, when they go as asked, as far as the walk-through knows (the same tracking as the
 * preflight's): `at` the cell she stands in for certain (the last walk's end, a pillar's top), or null when a hand after it moves her in a way
 * the map does not say (a dig that walks to pick up, an attack, a pickup); `via` the cell she is near then. Null when the act or the frame
 * cannot be walked through. Used to say, when only part of an act is sent, where the sent hands leave her.
 */
export function standAfterHands(input: unknown, frame: BodyObservation | null, taskId: string, count: number): { at: Cell | null; via: Cell | null } | null {
  const world = frame?.state.world as { localMap?: unknown; dimension?: unknown; position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined;
  const at = world?.position;
  const feet = at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
  const map = typeof world?.localMap === 'string' ? world.localMap : undefined;
  const start = startOf(input, { map, feet, rules: BODY_RULES, column: (cell, feetY) => keptColumnFact(taskId)(columnKey(cell, feetY)) });
  if (!start) return null;
  const { hands, view, track } = start;
  for (const [index, raw] of hands.entries()) {
    if (index >= count) break;
    const hand = raw as ActHand | null;
    if (!hand || typeof hand !== 'object' || (hand.rel === true && !track.at)) return { at: null, via: track.via };
    if (!advance(hand, track, hand.rel === true ? track.at : undefined, view)) return { at: null, via: track.via };
  }
  return { at: track.at, via: track.via };
}
