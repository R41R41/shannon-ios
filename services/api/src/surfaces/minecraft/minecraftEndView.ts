import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { marksOf } from './minecraftSeenMarks.js';

/**
 * What the body says of the End fight, read into one shape. The body (2026-11-02, `dragonState.ts` `endObservation`) puts it in the frame's
 * `state.end` (to be moved to `state.world.end`; both are read), only in the End: `dragon` (id, health /200, phase 0..10 and its name,
 * `phaseFor` seconds, `perched`, `at`, `head`, `headReach` metres from the eye to the head's box, `strike` whether a blow is in reach),
 * `fountain` (the perch), `crystals` (`remaining` of ten: standing or not seen yet; `gone`; `caged`; `list` nearest first with `healing`
 * and `blast`; `unseen`), `clouds` (the breath, x y z r) and `fireballs`. A body that sends neither still marks the dragon, the crystals
 * and the perch on the map (`mapLandmarks`): that is read instead, with what the marks can say (the dragon's health; the crystals in
 * view, not how many are left).
 */
type Rec = Record<string, unknown>;
export interface Point {
  x: number;
  y: number;
  z: number;
}
export interface EndCrystal {
  id: number | null;
  at: Point;
  caged: boolean | null;
  dist: number | null;
  healing: boolean;
  /** The health she would lose if it blew where she stands (the body's estimate, within the blast's reach only). */
  blast: number | null;
}
export interface EndDragon {
  id: number | null;
  health: number | null;
  phase: number | null;
  phaseName: string | null;
  /** Seconds the dragon has been in this phase, as the body watched. */
  phaseFor: number | null;
  perched: boolean;
  at: Point | null;
  head: Point | null;
  /** Metres from her eye to the head's box (when it is perched), and whether a blow reaches. */
  headReach: number | null;
  strike: boolean | null;
}
export interface EndView {
  dragon: EndDragon | null;
  fountain: Point | null;
  crystals: { remaining: number | null; gone: number | null; caged: number | null; unseen: number | null; visible: number | null; list: EndCrystal[] };
  clouds: Array<{ x: number; y: number | null; z: number; r: number | null }>;
  fireballs: number;
}

const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const point = (value: unknown): Point | null => {
  const item = rec(value);
  const x = num(item?.x);
  const y = num(item?.y);
  const z = num(item?.z);
  return x === null || y === null || z === null ? null : { x, y, z };
};

function dragonOf(raw: unknown): EndDragon | null {
  const item = rec(raw);
  if (!item) return null;
  const phase = num(item.phase);
  return { id: num(item.id), health: num(item.health), phase: phase !== null && Number.isInteger(phase) && phase >= 0 && phase <= 10 ? phase : null,
    phaseName: typeof item.phaseName === 'string' ? item.phaseName : null, phaseFor: num(item.phaseFor), perched: item.perched === true, at: point(item.at),
    head: point(item.head), headReach: num(item.headReach), strike: typeof item.strike === 'boolean' ? item.strike : null };
}

function crystalOf(raw: unknown): EndCrystal[] {
  const item = rec(raw);
  const at = point(item);
  if (!item || !at) return [];
  const caged = typeof item.caged === 'boolean' ? item.caged : null;
  return [{ id: num(item.id), at, caged, dist: num(item.dist), healing: item.healing === true, blast: num(item.blast) }];
}

function fromBody(end: Rec): EndView {
  const crystals = rec(end.crystals);
  return { dragon: dragonOf(end.dragon), fountain: point(end.fountain),
    crystals: { remaining: num(crystals?.remaining), gone: num(crystals?.gone), caged: num(crystals?.caged), visible: null,
      unseen: Array.isArray(crystals?.unseen) ? crystals.unseen.length : null,
      list: (Array.isArray(crystals?.list) ? crystals.list : []).flatMap(crystalOf).slice(0, 10) },
    clouds: (Array.isArray(end.clouds) ? end.clouds : []).flatMap(item => {
      const cloud = rec(item);
      const x = num(cloud?.x);
      const z = num(cloud?.z);
      return x === null || z === null ? [] : [{ x, y: num(cloud?.y), z, r: num(cloud?.r) }];
    }).slice(0, 4),
    fireballs: num(end.fireballs) ?? 0 };
}

/** The older form: the map marks of the End (`! エンダードラゴン (x,y,z) … id N 体力 H/200`, `! エンドクリスタル`, `X 止まり木`). */
function fromMarks(world: Rec | null): EndView | null {
  const marks = marksOf(world?.mapLandmarks);
  const dragon = marks.find(mark => mark.label === 'エンダードラゴン');
  const crystals = marks.filter(mark => mark.label === 'エンドクリスタル');
  const perch = marks.find(mark => mark.label === '止まり木');
  if (!dragon && !crystals.length && !perch) return null;
  const health = dragon ? /体力\s*([\d.]+)\/200/u.exec(dragon.rest) : null;
  return { dragon: dragon ? { id: null, health: health ? Number(health[1]) : null, phase: null, phaseName: null, phaseFor: null, perched: false,
      at: { x: dragon.x, y: dragon.y, z: dragon.z }, head: null, headReach: null, strike: null } : null,
    fountain: perch ? { x: perch.x, y: perch.y, z: perch.z } : null,
    crystals: { remaining: null, gone: null, caged: null, unseen: null, visible: crystals.length, list: [] }, clouds: [], fireballs: 0 };
}

/**
 * The End fight as the frame says it: from `state.world.end` (the one place the fight is kept in, decided 2026-11-02) or `state.end` (where the
 * body's first form put it), else from the map marks; null outside the End or with nothing to say. The inside is the same in both places.
 */
export function endViewOf(observation: BodyObservation | null): EndView | null {
  const world = rec(observation?.state.world);
  const end = rec(world?.end) ?? rec(observation?.state.end);
  return end ? fromBody(end) : fromMarks(world);
}

/** The end crystals left on the island, as the body counts them (`state.end.crystals.remaining`, of ten); null when it does not count. */
export function crystalsLeft(observation: BodyObservation | null): number | null {
  const left = endViewOf(observation)?.crystals.remaining ?? null;
  return left !== null && Number.isInteger(left) && left >= 0 && left <= 99 ? left : null;
}
