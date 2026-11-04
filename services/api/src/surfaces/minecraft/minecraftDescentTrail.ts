import type { DoneFacts } from './minecraftConditions.js';
import { DESCENT_SURFACE_Y } from './minecraftPlanDone.js';

/**
 * The way she came down, kept by the head (the whole-run audit of 11/4, order 2; run61, 11/4: from the diamonds at y -33 to the surface took about
 * 7 minutes of new water stairs and rock stairs, and she died on the way up in a cave at y 44, about 3 minutes after sunrise). Each decision's feet
 * in the overworld: at or above the surface's y (`DESCENT_SURFACE_Y`) the trail starts again from there; below it a point is added every
 * `SPACING` blocks, a point she comes back to cuts the trail there (the way up along it), and a jump of more than `JUMP` blocks (a death, a
 * respawn) starts it again. Below the surface the line says the trail back to the surface and that the dark below does not keep the hour. A fact
 * of where she walked and dug; it names no hand, and a way walked down is not proved safe going up.
 */
export const SPACING = 5;
const JUMP = 64;
const BACK = 3;
const KEEP = 40;
const SHOWN = 6;
type Point = { x: number; y: number; z: number };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const pointOf = (value: unknown): Point | null => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  return raw && finite(raw.x) && finite(raw.y) && finite(raw.z) ? { x: Math.floor(raw.x), y: Math.floor(raw.y), z: Math.floor(raw.z) } : null;
};
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cell = (p: Point): string => `(${p.x},${p.y},${p.z})`;

function readTrail(saved: unknown): Point[] {
  const raw = saved && typeof saved === 'object' ? saved as { v?: unknown; trail?: unknown } : null;
  return raw?.v === 1 && Array.isArray(raw.trail) ? raw.trail.map(pointOf).filter((p): p is Point => p !== null).slice(-KEEP) : [];
}

/** The trail with this frame's feet (pure). */
export function nextTrail(trail: readonly Point[], facts: Pick<DoneFacts, 'dimension' | 'feet'>): Point[] {
  const feet = facts.feet ? pointOf(facts.feet) : null;
  if ((facts.dimension ?? 'overworld') !== 'overworld' || !feet) return [];
  if (feet.y >= DESCENT_SURFACE_Y) return [feet];
  const last = trail.at(-1);
  if (!last || distance(last, feet) > JUMP) return [feet];
  const back = trail.slice(0, -1).findIndex(point => distance(point, feet) <= BACK);
  if (back >= 0) return trail.slice(0, back + 1);
  if (distance(last, feet) < SPACING) return [...trail];
  const longer = [...trail, feet];
  return longer.length > KEEP ? [longer[0]!, ...longer.slice(longer.length - KEEP + 1)] : longer;
}

/** The line below the surface: now, the points back, and the surface's end of it; null above the surface or with nothing kept. */
export function trailLine(trail: readonly Point[], facts: Pick<DoneFacts, 'dimension' | 'feet'>): string | null {
  const feet = facts.feet ? pointOf(facts.feet) : null;
  if ((facts.dimension ?? 'overworld') !== 'overworld' || !feet || feet.y >= DESCENT_SURFACE_Y || trail.length < 2) return null;
  const start = trail[0]!, between = trail.slice(1).reverse().filter(point => distance(point, feet) >= SPACING);
  const shown = between.slice(0, SHOWN).map(cell), more = between.length - shown.length;
  const top = start.y >= DESCENT_SURFACE_Y ? `地表側 ${cell(start)}（y ${DESCENT_SURFACE_Y} 以上の最後の点）` : `最初の点 ${cell(start)}（地表は見ていない）`;
  const steps = [`今 ${cell(feet)}`, ...shown, ...more > 0 ? [`…ほか ${more} 点`] : [], top].join(' ← ');
  return `下りた跡（頭の控え。歩いた・掘った道で、下りの時は通れた）: ${steps}。地下は時刻にかかわらず暗く、敵が湧く（朝・昼でも）`;
}

export function createDescentTrail(saved: unknown) {
  let trail = readTrail(saved);
  return {
    /** This decision's frame: the trail moves with her feet; the line of it, or null. */
    line(facts: Pick<DoneFacts, 'dimension' | 'feet'>): string | null {
      trail = nextTrail(trail, facts);
      return trailLine(trail, facts);
    },
    checkpoint: () => ({ minecraftDescentTrail: { v: 1, trail: [...trail] } }),
  };
}
