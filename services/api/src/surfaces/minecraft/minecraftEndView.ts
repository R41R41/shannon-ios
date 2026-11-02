import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { marksOf } from './minecraftSeenMarks.js';

/**
 * What the body says of the End fight, read into one shape. The body (S1, `EndObservation` of `dragonState.ts`; the observations the isolated lab
 * made are `tests/fixtures/minecraft/end-observation.expected.json`) puts the parts of the fight directly in the frame's `state.world`, only in the
 * End: `dragon` (id, health /200, phase 0..10 and its name, `phaseFor` seconds, `perched`, `position`, `yaw`, `distance`, `headPosition` when it is
 * perched, `headReach` metres from the eye to the head's box, `strike` whether a blow is in reach; the whole field is absent when the dragon is not
 * in view), `crystals` (`remaining` of ten: standing or not seen yet; `gone`; `caged`; `list` nearest first with `position`, `distance`, `caged`,
 * `healing` and `blast`; `unseen`), `perch`, `dragonBreath` (x y z, `radius`, `dangerRadius`) and `dragonFireballs` (a count). A body that sends
 * none of them still marks the dragon, the crystals and the perch on the map (`mapLandmarks`): that is read instead, with what the marks can say
 * (the dragon's health; the crystals in view, not how many are left).
 */
type Rec = Record<string, unknown>;
export interface Point {
  x: number;
  y: number;
  z: number;
}
export interface EndCrystal {
  id: number | null;
  position: Point;
  caged: boolean | null;
  distance: number | null;
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
  position: Point | null;
  headPosition: Point | null;
  /** Metres from her to the dragon. */
  distance: number | null;
  /** Metres from her eye to the head's box (when it is perched), and whether a blow reaches. */
  headReach: number | null;
  strike: boolean | null;
}
export interface EndCloud {
  x: number;
  y: number | null;
  z: number;
  /** The cloud's radius now (it grows with its age) and the radius the body keeps away from (7 or more). */
  radius: number | null;
  dangerRadius: number | null;
}
export interface EndView {
  dragon: EndDragon | null;
  perch: Point | null;
  crystals: { remaining: number | null; gone: number | null; caged: number | null; unseen: number | null; visible: number | null; list: EndCrystal[] };
  breath: EndCloud[];
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
    phaseName: typeof item.phaseName === 'string' ? item.phaseName : null, phaseFor: num(item.phaseFor), perched: item.perched === true,
    position: point(item.position), headPosition: point(item.headPosition), distance: num(item.distance),
    headReach: num(item.headReach), strike: typeof item.strike === 'boolean' ? item.strike : null };
}

function crystalOf(raw: unknown): EndCrystal[] {
  const item = rec(raw);
  const position = point(item?.position);
  if (!item || !position) return [];
  const caged = typeof item.caged === 'boolean' ? item.caged : null;
  return [{ id: num(item.id), position, caged, distance: num(item.distance), healing: item.healing === true, blast: num(item.blast) }];
}

function cloudOf(raw: unknown): EndCloud[] {
  const cloud = rec(raw);
  const x = num(cloud?.x);
  const z = num(cloud?.z);
  return x === null || z === null ? [] : [{ x, y: num(cloud?.y), z, radius: num(cloud?.radius), dangerRadius: num(cloud?.dangerRadius) }];
}

function fromBody(world: Rec): EndView {
  const crystals = rec(world.crystals);
  return { dragon: dragonOf(world.dragon), perch: point(world.perch),
    crystals: { remaining: num(crystals?.remaining), gone: num(crystals?.gone), caged: num(crystals?.caged), visible: null,
      unseen: Array.isArray(crystals?.unseen) ? crystals.unseen.length : null,
      list: (Array.isArray(crystals?.list) ? crystals.list : []).flatMap(crystalOf).slice(0, 10) },
    breath: (Array.isArray(world.dragonBreath) ? world.dragonBreath : []).flatMap(cloudOf).slice(0, 4),
    fireballs: num(world.dragonFireballs) ?? 0 };
}

/** The map marks of the End (`! エンダードラゴン (x,y,z) … id N 体力 H/200`, `! エンドクリスタル`, `X 止まり木`), for a body that sends no fight fields. */
function fromMarks(world: Rec | null): EndView | null {
  const marks = marksOf(world?.mapLandmarks);
  const dragon = marks.find(mark => mark.label === 'エンダードラゴン');
  const crystals = marks.filter(mark => mark.label === 'エンドクリスタル');
  const perch = marks.find(mark => mark.label === '止まり木');
  if (!dragon && !crystals.length && !perch) return null;
  const health = dragon ? /体力\s*([\d.]+)\/200/u.exec(dragon.rest) : null;
  return { dragon: dragon ? { id: null, health: health ? Number(health[1]) : null, phase: null, phaseName: null, phaseFor: null, perched: false,
      position: { x: dragon.x, y: dragon.y, z: dragon.z }, headPosition: null, distance: null, headReach: null, strike: null } : null,
    perch: perch ? { x: perch.x, y: perch.y, z: perch.z } : null,
    crystals: { remaining: null, gone: null, caged: null, unseen: null, visible: crystals.length, list: [] }, breath: [], fireballs: 0 };
}

/** The parts of the fight the body names directly in `state.world`; it sends none of them outside the End. */
const FIGHT_FIELDS = ['dragon', 'crystals', 'perch', 'dragonBreath', 'dragonFireballs'] as const;

/**
 * The End fight as the frame says it: from the fight fields in `state.world`, else from the map marks; null outside the End or with nothing to say.
 */
export function endViewOf(observation: BodyObservation | null): EndView | null {
  const world = rec(observation?.state.world);
  const fought = world !== null && FIGHT_FIELDS.some(field => world[field] !== undefined);
  return fought ? fromBody(world) : fromMarks(world);
}

/** The end crystals left on the island, as the body counts them (`crystals.remaining`, of ten); null when it does not count. */
export function crystalsLeft(observation: BodyObservation | null): number | null {
  const left = endViewOf(observation)?.crystals.remaining ?? null;
  return left !== null && Number.isInteger(left) && left >= 0 && left <= 99 ? left : null;
}
