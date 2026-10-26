// 10/26: 削除された部品（main 0df88ce）の写し。r10Live.ts（v4 の古い比べ）だけが使う。本番のコードではない。
import type { BodyObservation } from '../../../src/contracts/bodyControlContract.js';
import type { ActPos } from '../../../src/contracts/minecraftActContract.js';
import { finite, plain, posText } from '../../../src/surfaces/minecraft/minecraftLlmcProbeInput.js';
import { isShooter, type NearThreat, type ThreatSight } from '../../../src/surfaces/minecraft/minecraftLlmcThreat.js';

/**
 * mb-llmc r10 (H5; run 34, 2026-10-22, +488–517: a piglin 6 m away with a crossbow, in sight, hit her six times in 14 s (health 20 → 11.3) and
 * no reflex ran; the head's first answer was a wall on the tunnel's axis, which did not stand between the two of them, its second an
 * `attack` hold against a piglin that never came within reach (8.4 s standing, 3.8 taken); the line was cut about 29 s after the first hit):
 *
 * - `sightLineCells`: the blocks the straight line from her eye to the shooter passes first, 1.5 m and 2.5 m out (the same straight line the
 *   body's `sight` walks: `solidBetween`, whose `between` is empty exactly when she is in sight, so the cells cannot come from it). A block placed in
 *   the first stands in that line, which a wall on the tunnel's axis does not. Said in the urgent line of a shooter she is in the sight of
 *   (`urgentFacts`: 「線上のマス (x,y,z)」), and in the result of an `attack` hold that stopped short of its target (`minecraftLlmcStopFacts.ts`).
 * Facts only; what to do (place on the line, step down, leave) stays the decision's.
 */
const EYE = 1.62, AIM = 1.0;
/** How far a hold reaches (the body's own words: 「目から3m・見える」). */
export const HOLD_REACH_METERS = 3;
/** The kinds besides `isShooter` that hit from a distance in the Nether (a piglin's crossbow). */
const SHOOTS_AT_RANGE = new Set(['piglin']);
/** A shooter, as the frame says it: she is seen from it, or its sight is not said. */
export const hurtsFromAfar = (name: string): boolean => isShooter(name) || SHOOTS_AT_RANGE.has(name);

interface Raw { x: number; y: number; z: number }
const rawOf = (value: unknown): Raw | null => {
  const at = plain(value), x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
  return x === null || y === null || z === null ? null : { x, y, z };
};

/** The cells the line from her eye to `threat`'s middle passes at 1.5 m and 2.5 m (her own two cells left out); none when it is nearer than 3 m. */
export function sightLineCells(feet: Raw | null, threat: Raw | null): ActPos[] {
  if (!feet || !threat) return [];
  const from = { x: feet.x, y: feet.y + EYE, z: feet.z }, to = { x: threat.x, y: threat.y + AIM, z: threat.z };
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length = Math.hypot(dx, dy, dz);
  if (length < HOLD_REACH_METERS) return [];
  const own = new Set([0, 1].map(up => `${Math.floor(feet.x)},${Math.floor(feet.y) + up},${Math.floor(feet.z)}`));
  const cells: ActPos[] = [];
  for (const out of [1.5, 2.5]) {
    const cell = { x: Math.floor(from.x + dx / length * out), y: Math.floor(from.y + dy / length * out), z: Math.floor(from.z + dz / length * out) };
    if (own.has(`${cell.x},${cell.y},${cell.z}`) || cells.some(item => item.x === cell.x && item.y === cell.y && item.z === cell.z)) continue;
    cells.push(cell);
  }
  return cells;
}

/** The threats of a frame with their raw places (the nearest first), for the line. */
function threatsOf(observation: BodyObservation | null): Array<{ id: number | null; name: string; distance: number; at: Raw | null; canSee: boolean | null }> {
  const world = plain(observation?.state.world);
  return (Array.isArray(world?.nearbyThreats) ? world!.nearbyThreats : []).flatMap(item => {
    const entity = plain(item), distance = finite(entity?.distance);
    if (!entity || typeof entity.name !== 'string' || distance === null) return [];
    return [{ id: typeof entity.id === 'number' && Number.isInteger(entity.id) ? entity.id : null, name: entity.name.toLowerCase(), distance,
      at: rawOf(entity.position), canSee: typeof entity.canSee === 'boolean' ? entity.canSee : null }];
  }).sort((left, right) => left.distance - right.distance);
}

/**
 * 「線上のマス (x,y,z)（目から 1.5m。ここにブロックを置くと射線が切れる）」 for the hostile `id` of the frame, or null (no place, nearer than 3 m,
 * or no cell). The second cell is named when there is one (「届かなければ (x,y,z)」).
 */
export function sightLineText(observation: BodyObservation | null, id: number | null, name?: string): string | null {
  const feet = rawOf(plain(observation?.state.world)?.position);
  const threat = threatsOf(observation).find(item => (id !== null ? item.id === id : item.name === name));
  const cells = sightLineCells(feet, threat?.at ?? null);
  if (!cells.length) return null;
  return `線上のマス ${posText(cells[0]!)}（目から約 1.5m。ここにブロックを置くと射線が切れる${cells[1] ? `。届かなければ ${posText(cells[1])}` : ''}。`
    + 'トンネルの軸に置いても線の上でなければ切れない）';
}

/** The line's cell for a near hostile that hurts from a distance and has her in its sight (the body's sight when it was asked, else the frame's `canSee`). */
export function shooterLineText(observation: BodyObservation | null, threat: NearThreat, sight?: ThreatSight): string | null {
  const seesHer = sight ? sight.visible : threat.canSee === true;
  return seesHer && hurtsFromAfar(threat.name) ? sightLineText(observation, threat.id, threat.name) : null;
}
