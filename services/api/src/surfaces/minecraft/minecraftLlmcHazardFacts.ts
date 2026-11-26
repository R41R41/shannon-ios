import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActHand, ActPos } from '../../contracts/minecraftActContract.js';
import { carriedItemCounts } from './minecraftItems.js';
import { finite, one, rec, world, type Hit } from './minecraftLlmcHealth.js';
import { readLayers } from './minecraftLlmcPreflightMap.js';
import { nearThreats } from './minecraftLlmcThreat.js';

/**
 * Run of 11/26 (6th, d0048〜d0052): she was struck by an enderman beside a lava pool, caught fire, ate while burning (health 4.1 → 2.1 in the meal)
 * and burned to death. The urgent input said nothing of fire (only 「打った相手: …・on_fire」 among numbers) nor of the lava 4 m away (the map's `l`
 * alone; the footing line only counts the eight cells round the feet). These lines are the facts of those, from the frame and the blows: they say
 * what is so and what it costs, and decide no hand. Numbers not measured (how long a fire lasts) are not said.
 */

/** A blow of fire is told as burning for this long after it (ms): the body's `onFire` is the fact when it sends it; the blow's kind is the head's own reading. */
export const BURN_WINDOW_MS = 3_000;
const BURN_KINDS = /^(?:on_fire|in_fire|lava)(?: |$)/u;
/** Whether one of the blows within `BURN_WINDOW_MS` before `at` was a fire's or lava's (the body's `attackerType`, as `createHitWatch` keeps it in `by`). */
export function burnedRecently(hits: readonly Hit[], at: number): boolean {
  return hits.some(hit => hit.by !== null && BURN_KINDS.test(hit.by) && at - hit.at <= BURN_WINDOW_MS && at - hit.at >= -1_000);
}

const dimensionOf = (w: Record<string, unknown>): string => String(w.dimension ?? '').replace(/^minecraft:/u, '');
/** What water can do about fire here: the Nether boils it away. */
export function waterWords(observation: BodyObservation | null): string {
  const w = world(observation);
  if (dimensionOf(w) === 'the_nether') return 'ネザーでは水が蒸発して使えない';
  return (carriedItemCounts(w, observation?.facts).get('water_bucket') ?? 0) > 0 ? 'この次元で水は使える（water_bucket を持っている）' : 'この次元で水は使えるが、水のバケツは持っていない';
}

/**
 * 「燃えている（毎秒 1 減る。今の体力 6.1 は毎秒 1 で約 7 秒分。ネザーでは水が蒸発して使えない）」: while the body says `onFire`, or a blow of fire was taken
 * within `BURN_WINDOW_MS` (`burning`). How long a fire lasts is not said (not measured); the health in seconds is arithmetic.
 */
export function burnLine(observation: BodyObservation | null, burning: boolean): string | null {
  const w = world(observation);
  if (w.onFire !== true && !burning) return null;
  const health = finite(w.health);
  return `燃えている（毎秒 1 減る${health !== null ? `。今の体力 ${one(health)} は毎秒 1 で約 ${Math.max(0, Math.ceil(health))} 秒分` : ''}。${waterWords(observation)}）`;
}

/** Lava within this many metres of her feet is said (and `LAVA_HEIGHT` levels under and over). */
export const LAVA_NEAR_METERS = 5.5;
const LAVA_UNDER = 3, LAVA_OVER = 2;
/** Lava this close (cells, either axis) at her feet's height or one under it is one push from her. */
const LAVA_ADJACENT = 2;
/** The reason beside the footing's and the lava's lines: what is so when she is pushed, and what a few cells of distance buys. */
export const LAVA_STEP_BACK = '溶岩が足の隣の高さにある時は、先に 2 マス以上離れてから戦う・食べる方が、押された時に安全（押されて入ると燃える）';
const compass = (dx: number, dz: number): string => {
  const ax = Math.abs(dx), az = Math.abs(dz);
  const ns = dz < 0 ? '北' : '南', ew = dx > 0 ? '東' : '西';
  if (ax >= az * 2) return ew;
  if (az >= ax * 2) return ns;
  return `${ns}${ew}`;
};
const heightWords = (dy: number): string => dy === 0 ? '同じ高さ' : dy > 0 ? `${dy} 上` : `${-dy} 下`;
function feetOf(w: Record<string, unknown>, fallback: ActPos | null): ActPos | null {
  const at = rec(w.position);
  if (at && [at.x, at.y, at.z].every(value => finite(value) !== null)) return { x: Math.floor(Number(at.x)), y: Math.floor(Number(at.y)), z: Math.floor(Number(at.z)) };
  return fallback;
}
/**
 * 「溶岩 (110,61,-298) 西 4m・同じ高さ（5.5m 内に 6 マス）・触れると燃える。ネザーでは水が蒸発して使えない」: the nearest lava cell the map shows within
 * `LAVA_NEAR_METERS` of her feet, whether she stands still or not (the footing line is only the eight cells round her feet). Said with the reason for
 * keeping away when it is one push from her. Null when the map shows none, or has no feet.
 */
export function lavaNearLine(observation: BodyObservation | null): string | null {
  const w = world(observation);
  const layers = readLayers(typeof w.localMap === 'string' ? w.localMap : undefined);
  const feet = feetOf(w, layers?.feet ?? null);
  if (!layers || !feet) return null;
  const found: Array<{ x: number; y: number; z: number; far: number }> = [];
  for (const [y, cells] of layers.layers) {
    const dy = y - feet.y;
    if (dy < -LAVA_UNDER || dy > LAVA_OVER) continue;
    for (const [key, symbol] of cells) {
      if (symbol !== 'l' && symbol !== 'L') continue;
      const [x, z] = key.split(',').map(Number) as [number, number];
      const far = Math.hypot(x - feet.x, dy, z - feet.z);
      if (far <= LAVA_NEAR_METERS) found.push({ x, y, z, far });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => a.far - b.far);
  const near = found[0]!, dy = near.y - feet.y, dx = near.x - feet.x, dz = near.z - feet.z;
  const adjacent = dy >= -1 && dy <= 0 && Math.max(Math.abs(dx), Math.abs(dz)) <= LAVA_ADJACENT;
  return `溶岩 (${near.x},${near.y},${near.z}) ${compass(dx, dz)} ${Math.round(Math.hypot(dx, dz))}m・${heightWords(dy)}（${LAVA_NEAR_METERS}m 内に ${found.length} マス）・`
    + `触れると燃える（燃えている間は毎秒 1 減り、溶岩の中ではそれより速く減る）。${waterWords(observation)}${adjacent ? `。${LAVA_STEP_BACK}` : ''}`;
}

// ---- the line to where the hands go

/** An enemy this close to the line from her feet to where she goes is said. */
export const ROUTE_ENEMY_METERS = 12;
const ROUTE_KINDS = 4;
const POS_AT = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/u;
/** The first coordinates a text names (a plan node's place), or null. */
export function posIn(text: string | null | undefined): ActPos | null {
  const match = POS_AT.exec(text ?? '');
  return match ? { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) } : null;
}
/** Where the last walking hand of the queue's open items goes (a go or walk: `to`, the first of `goals`, the end of `path`), or null. */
export function queueGoal(ahead: ReadonlyArray<{ hands: readonly ActHand[] }> | undefined): ActPos | null {
  let goal: ActPos | null = null;
  for (const item of ahead ?? []) for (const hand of item.hands) {
    if (hand.do !== 'go' && hand.do !== 'walk') continue;
    const at = hand.to ?? hand.goals?.[0] ?? hand.path?.at(-1);
    if (at) goal = at;
  }
  return goal;
}
export interface Goal { at: ActPos; from: 'queue' | 'plan' }
const distanceToSegment = (p: ActPos, a: ActPos, b: ActPos): number => {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, length2 = abx * abx + aby * aby + abz * abz;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / length2));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby), p.z - (a.z + t * abz));
};
/**
 * 「行き先の線の近く（予定の go (24,46,-24) までの線から 12m 内）: enderman ×9（25〜35m 先・怒っていない）」: the hostiles and neutrals the frame lists within
 * `ROUTE_ENEMY_METERS` of the straight line from her feet to where she goes, by kind, with how far from her they stand and the mood the body says of an
 * enderman (a look angers a calm one). The line is not the way the road runs: it says who is beside the straight line. Null when none, or no goal.
 */
export function routeEnemiesLine(observation: BodyObservation | null, goal: Goal | null): string | null {
  if (!goal) return null;
  const w = world(observation), feet = feetOf(w, null);
  if (!feet) return null;
  const kinds = new Map<string, { n: number; min: number; max: number; calm: number; angry: number }>();
  for (const threat of nearThreats(observation)) {
    if (!threat.at || distanceToSegment(threat.at, feet, goal.at) > ROUTE_ENEMY_METERS) continue;
    const kind = kinds.get(threat.name) ?? { n: 0, min: Infinity, max: 0, calm: 0, angry: 0 };
    kind.n += 1;
    kind.min = Math.min(kind.min, threat.distance);
    kind.max = Math.max(kind.max, threat.distance);
    if (threat.angry === false) kind.calm += 1;
    if (threat.angry === true) kind.angry += 1;
    kinds.set(threat.name, kind);
  }
  if (!kinds.size) return null;
  const shown = [...kinds].sort((a, b) => a[1].min - b[1].min).slice(0, ROUTE_KINDS).map(([name, kind]) => {
    const range = Math.round(kind.min) === Math.round(kind.max) ? `${Math.round(kind.min)}m 先` : `${Math.round(kind.min)}〜${Math.round(kind.max)}m 先`;
    const mood = name !== 'enderman' ? '' : kind.angry === 0 ? (kind.calm === kind.n ? '・怒っていない' : '')
      : `・怒っている ${kind.angry}${kind.calm ? `・怒っていない ${kind.calm}` : ''}`;
    return `${name} ×${kind.n}（${range}${mood}）`;
  });
  const to = `(${goal.at.x},${goal.at.y},${goal.at.z})`;
  return `行き先の線の近く（${goal.from === 'queue' ? '予定の go' : '計画の場所'} ${to} までの線から ${ROUTE_ENEMY_METERS}m 内）: ${shown.join('・')}`;
}

// ---- how old the input is

/**
 * 「この入力は 0.4 秒前の観測。返事が体に届くまでにさらに約 3.7 秒かかる（直近の急ぎの判断の長さ）。エンダーマンは打たれるとテレポートして消えることがある」:
 * run of 11/26 (d0049): the input was 13.3 s, the hand reached the body at 17.27 s, and in those 4 s the enderman it named was gone, so the attack took another
 * way. The age is the frame's (`stateAt`) at the time of the request; the wait is the length of the last urgent decision (not known before the first).
 * The enderman's way is said only when one is near or has struck her.
 */
export function inputAgeLine(observation: BodyObservation | null, nowMs: number, lastDecisionMs: number | null, hitByEnderman: boolean): string | null {
  const at = Date.parse(observation?.stateAt ?? '');
  if (!Number.isFinite(at)) return null;
  const age = Math.max(0, (nowMs - at) / 1000);
  const enderman = hitByEnderman || nearThreats(observation).some(threat => threat.name === 'enderman' && threat.distance <= 16);
  return `この入力は ${one(age)} 秒前の観測${lastDecisionMs !== null ? `。返事が体に届くまでにさらに約 ${one(lastDecisionMs / 1000)} 秒かかる（直近の急ぎの判断の長さ）` : ''}`
    + `${enderman ? '。エンダーマンは打たれるとテレポートして消えることがある' : ''}`;
}

// ---- a drop with an angry one beside it

/** An angry hostile this close to a dropped item (metres across, and up or down) is said beside the item's line. */
export const DROP_GUARD_METERS = 1.5, DROP_GUARD_HEIGHT = 2;
/**
 * 「・その 1m に怒った enderman #4（足元より 3 下）」: run of 11/26 (6th): a pearl lay in a hole where an angry enderman stood; the fight did not reach it, the
 * pickup went down, and health fell from 20 to 2.7. The enemy beside a dropped item, from the threats' own places and mood (the body's `angry`), against
 * her feet's height. Empty when none stands beside it.
 */
export function dropGuardWords(item: Record<string, unknown>, w: Record<string, unknown>): string {
  const at = rec(item.position), feet = rec(w.position);
  if (!at || finite(at.x) === null || finite(at.y) === null || finite(at.z) === null) return '';
  const feetY = finite(feet?.y);
  const guards = (Array.isArray(w.nearbyThreats) ? w.nearbyThreats : []).flatMap(raw => {
    const threat = rec(raw), place = rec(threat?.position);
    if (!threat || !place || threat.angry !== true || typeof threat.name !== 'string' || finite(place.x) === null || finite(place.y) === null || finite(place.z) === null) return [];
    const across = Math.hypot(Number(place.x) - Number(at.x), Number(place.z) - Number(at.z)), height = Math.abs(Number(place.y) - Number(at.y));
    if (across > DROP_GUARD_METERS || height > DROP_GUARD_HEIGHT) return [];
    const below = feetY === null ? null : Math.round(feetY - Number(place.y));
    return [`${threat.name}${Number.isInteger(threat.id) ? ` #${threat.id}` : ''}${below === null ? '' : below > 0 ? `（足元より ${below} 下）` : below < 0 ? `（足元より ${-below} 上）` : '（足元と同じ高さ）'}`];
  });
  return guards.length ? `・その 1m に怒った ${guards.slice(0, 2).join('・')}` : '';
}
