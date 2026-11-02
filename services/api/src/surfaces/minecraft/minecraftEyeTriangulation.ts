/**
 * The stronghold from the eyes she has thrown (a pure calculation; no clock, no store, no model).
 *
 * The body reports each thrown ender eye as the point she threw it from, the compass bearing of its flight (0 north = -z,
 * 90 east = +x) and how far it flew (`EnderEyeFlight`). A thrown eye flies toward the nearest stronghold, so the stronghold
 * lies on the ray from the throw along that bearing. Two rays from different places meet there.
 *
 * What is computed is only what the throws say, and it says how sure it is:
 * - forward only: a meeting point behind a throw is not a stronghold the eye flew toward;
 * - lines that are nearly parallel meet far away and by chance: no point is given;
 * - the error is estimated from how far each eye flew (a short flight fixes its bearing less well) and how far the
 *   point is; a point whose estimated error is too big to walk to is not given either.
 * It decides nothing: the model reads the point, the error and the places to throw from next, and chooses.
 */
export interface EyeThrow {
  /** The place she threw from (horizontal; the height is not used). */
  x: number;
  z: number;
  /** Compass degrees of the flight, 0 north (-z), 90 east (+x). */
  bearingDeg: number;
  /** Horizontal blocks the eye flew. */
  flew: number;
  /** The eye broke (true) or dropped to be picked up (false). */
  broke: boolean;
  /** It sank almost straight down: the stronghold is under or beside that place. */
  down?: boolean;
}

export interface Fix {
  x: number;
  z: number;
  /** A rough radius (blocks) inside which the stronghold is expected, by this calculation. */
  errorBlocks: number;
  /** How many throws agree on the point. */
  throws: number;
  /** Blocks from each throw's place to the point, in the order of the throws given. */
  ahead: number[];
}

/** A pair whose lines cross at less than this angle is not used. */
export const MIN_CROSSING_DEGREES = 8;
/** A point whose estimated error is above this is not given: it is not worth walking to. */
export const MAX_ERROR_BLOCKS = 300;
/** The error of a bearing is about this many blocks of sideways position over the blocks flown. */
const POSITION_NOISE_BLOCKS = 0.2;
const MIN_BEARING_ERROR_DEGREES = 0.5;
const MAX_BEARING_ERROR_DEGREES = 6;
const RAD = Math.PI / 180;

interface Ray {
  x: number;
  z: number;
  dx: number;
  dz: number;
  sigma: number;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The unit vector of a compass bearing: east is +x, north is -z. */
export function bearingVector(bearingDeg: number): { dx: number; dz: number } {
  const angle = bearingDeg * RAD;
  return { dx: Math.sin(angle), dz: -Math.cos(angle) };
}

/** The compass bearing (0 north, 90 east, 0..360) from one place to another. */
export function bearingBetween(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const degrees = Math.atan2(to.x - from.x, -(to.z - from.z)) / RAD;
  return Math.round(((degrees % 360) + 360) % 360 * 10) / 10;
}

/** The compass word of a bearing: 北, 北東, 東, ... */
export function compassWord(bearingDeg: number): string {
  const names = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  return names[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8]!;
}

function bearingErrorRadians(flew: number): number {
  const wanted = Math.atan2(POSITION_NOISE_BLOCKS, Math.max(1, flew));
  return Math.min(MAX_BEARING_ERROR_DEGREES * RAD, Math.max(MIN_BEARING_ERROR_DEGREES * RAD, wanted));
}

function rayOf(item: EyeThrow): Ray | null {
  if (![item.x, item.z, item.bearingDeg, item.flew].every(finite)) return null;
  const { dx, dz } = bearingVector(item.bearingDeg);
  return { x: item.x, z: item.z, dx, dz, sigma: bearingErrorRadians(item.flew) };
}

const cross = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx;

/** Where two rays meet and how far along each (null when parallel). */
function crossing(a: Ray, b: Ray): { x: number; z: number; ta: number; tb: number; sine: number } | null {
  const sine = cross(a.dx, a.dz, b.dx, b.dz);
  if (Math.abs(sine) < 1e-9) return null;
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const ta = cross(rx, rz, b.dx, b.dz) / sine;
  const tb = cross(rx, rz, a.dx, a.dz) / sine;
  return { x: a.x + ta * a.dx, z: a.z + ta * a.dz, ta, tb, sine: Math.abs(sine) };
}

/** The rays' weighted least-squares point and its covariance matrix; the weights follow each ray's error at its distance. */
function leastSquares(rays: readonly Ray[], start: { x: number; z: number }): { x: number; z: number; xx: number; xz: number; zz: number } | null {
  let x = start.x;
  let z = start.z;
  let cov = { xx: 0, xz: 0, zz: 0 };
  for (let round = 0; round < 4; round += 1) {
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    for (const ray of rays) {
      const along = Math.max(8, (x - ray.x) * ray.dx + (z - ray.z) * ray.dz);
      const weight = 1 / ((along * ray.sigma) ** 2);
      const m11 = 1 - ray.dx * ray.dx;
      const m12 = -ray.dx * ray.dz;
      const m22 = 1 - ray.dz * ray.dz;
      a11 += weight * m11;
      a12 += weight * m12;
      a22 += weight * m22;
      b1 += weight * (m11 * ray.x + m12 * ray.z);
      b2 += weight * (m12 * ray.x + m22 * ray.z);
    }
    const det = a11 * a22 - a12 * a12;
    if (!(det > 1e-12)) return null;
    x = (a22 * b1 - a12 * b2) / det;
    z = (a11 * b2 - a12 * b1) / det;
    cov = { xx: a22 / det, xz: -a12 / det, zz: a11 / det };
  }
  return { x, z, ...cov };
}

/** The radius of the error: twice the long half-axis of the one-sigma ellipse. */
function errorRadius(cov: { xx: number; xz: number; zz: number }): number {
  const mean = (cov.xx + cov.zz) / 2;
  const spread = Math.sqrt(Math.max(0, ((cov.xx - cov.zz) / 2) ** 2 + cov.xz ** 2));
  return 2 * Math.sqrt(Math.max(0, mean + spread));
}

/** Whether a point is ahead of a ray (the eye flew toward it). */
const isAhead = (ray: Ray, x: number, z: number): boolean => (x - ray.x) * ray.dx + (z - ray.z) * ray.dz > 0;

/** The throws that agree with a point: ahead, and not farther off the line than three times the line's own error there. */
function agreeing(rays: readonly Ray[], x: number, z: number): number[] {
  const out: number[] = [];
  rays.forEach((ray, index) => {
    const along = (x - ray.x) * ray.dx + (z - ray.z) * ray.dz;
    const off = Math.abs(cross(x - ray.x, z - ray.z, ray.dx, ray.dz));
    if (along > 0 && off <= Math.max(25, 3 * along * ray.sigma)) out.push(index);
  });
  return out;
}

/** The best point two or more throws give, or null. A broken or fallen eye flew the same; both are used. */
export function stronghold(throws: readonly EyeThrow[]): Fix | null {
  const rays = throws.map(rayOf);
  let best: { fix: Fix; score: number } | null = null;
  for (let i = 0; i < rays.length; i += 1) {
    for (let j = i + 1; j < rays.length; j += 1) {
      const found = pairFix(rays, i, j);
      if (found && (!best || found.score > best.score)) best = found;
    }
  }
  return best?.fix ?? null;
}

function pairFix(rays: ReadonlyArray<Ray | null>, i: number, j: number): { fix: Fix; score: number } | null {
  const a = rays[i];
  const b = rays[j];
  if (!a || !b) return null;
  const meet = crossing(a, b);
  if (!meet || meet.ta <= 0 || meet.tb <= 0 || meet.sine < Math.sin(MIN_CROSSING_DEGREES * RAD)) return null;
  const valid = rays.map((ray, index) => ({ ray, index })).filter((item): item is { ray: Ray; index: number } => item.ray !== null);
  const set = agreeing(valid.map(item => item.ray), meet.x, meet.z).map(index => valid[index]!);
  const point = leastSquares(set.map(item => item.ray), meet);
  if (!point || set.some(item => !isAhead(item.ray, point.x, point.z))) return null;
  const errorBlocks = errorRadius(point);
  if (errorBlocks > MAX_ERROR_BLOCKS) return null;
  const ahead = rays.map(ray => ray ? Math.round(Math.hypot(point.x - ray.x, point.z - ray.z)) : 0);
  const fix: Fix = { x: Math.round(point.x), z: Math.round(point.z), errorBlocks: Math.max(1, Math.round(errorBlocks)), throws: set.length, ahead };
  return { fix, score: set.length * 1000 - errorBlocks };
}

/** A place to throw from next, with the bearing it will be seen from. */
export interface ThrowPlace {
  x: number;
  z: number;
  /** Blocks from the last throw. */
  from: number;
}

/** The distances sideways (blocks) a second throw is suggested at, widening with each pair that did not give a point. */
export const SIDEWAYS_BLOCKS: readonly number[] = [100, 200, 400];

/**
 * Where to throw the next eye when there is no point yet: sideways of the last throw's line, on either side, far enough that
 * the two lines cross at an angle the calculation can use. `failed` is how many pairs of throws gave no point so far.
 */
export function nextThrowPlaces(last: EyeThrow, failed: number): ThrowPlace[] {
  const ray = rayOf(last);
  if (!ray) return [];
  const distance = SIDEWAYS_BLOCKS[Math.min(Math.max(0, failed), SIDEWAYS_BLOCKS.length - 1)]!;
  const sideX = -ray.dz;
  const sideZ = ray.dx;
  return [1, -1].map(side => ({ x: Math.round(last.x + side * sideX * distance), z: Math.round(last.z + side * sideZ * distance), from: distance }));
}

/** The place on the line toward the point to throw from again, `short` blocks before the point (the nearer, the smaller the error). */
export function nearThrowPlace(from: { x: number; z: number }, fix: Fix, short: number): ThrowPlace | null {
  const distance = Math.hypot(fix.x - from.x, fix.z - from.z);
  if (!(distance > short + 20)) return null;
  const fraction = (distance - short) / distance;
  return { x: Math.round(from.x + (fix.x - from.x) * fraction), z: Math.round(from.z + (fix.z - from.z) * fraction), from: Math.round(distance - short) };
}
