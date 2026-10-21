import type { Cell } from './minecraftProcedureFacts.js';

/**
 * What a trip costs, in seconds (mb-r22, run 22: the bucket was made 40 blocks under ground with no water near, the diamonds were dug at
 * Y-58 with it empty, and the water was fetched by 130 steps back up, 155 s, while a water she remembered lay 20 m from the lava). The
 * rates are the run's own: a climb is a block a step (155 s for 130), a drop 1 s a block (95 s for 97), a walk through rock 1.5 s a
 * metre, on the ground 0.45 s (77 m in 30 s). A stair dug on the diagonal does the height and the way at once, so the longer of the two
 * is what it takes, and a quarter of the shorter is added for the turns.
 */
export const TRIP = Object.freeze({ upPerBlock: 1.2, downPerBlock: 1.0, groundPerMetre: 0.45, rockPerMetre: 1.5, surfaceY: 50 });

/** Seconds from one cell to another. */
export function tripSeconds(from: Cell, to: Cell): number {
  const flat = Math.hypot(to.x - from.x, to.z - from.z), rise = to.y - from.y;
  const vertical = rise >= 0 ? rise * TRIP.upPerBlock : -rise * TRIP.downPerBlock;
  const open = from.y >= TRIP.surfaceY && to.y >= TRIP.surfaceY;
  const horizontal = flat * (open ? TRIP.groundPerMetre : TRIP.rockPerMetre);
  return Math.max(vertical, horizontal) + 0.25 * Math.min(vertical, horizontal);
}

/** Water below this height, reached from above it, is a cave's or the sea floor's: a walk into rock that costs this much more. */
const CAVE_WATER_Y = 60, CAVE_WATER_SECONDS = 25;

/**
 * What it costs to fill the bucket at `water` instead of going straight to where she is going next (`after`: the places the next steps
 * are, the nearest counts). With no place after, the trip to the water alone. Never negative.
 */
export function waterDetour(from: Cell, water: Cell, after: readonly Cell[]): number {
  const there = tripSeconds(from, water) + (water.y < CAVE_WATER_Y && from.y >= CAVE_WATER_Y ? CAVE_WATER_SECONDS : 0);
  if (!after.length) return there;
  const onward = Math.min(...after.map(cell => tripSeconds(water, cell)));
  const direct = Math.min(...after.map(cell => tripSeconds(from, cell)));
  return Math.max(0, there + onward - direct);
}

export interface WaterChoice { cell: Cell; seconds: number }

/**
 * The water that costs the least detour, of those known (the body's find and the map's memory together), within `maxSeconds`; the order
 * given breaks ties. Undefined when none is worth it.
 */
export function bestWater(from: Cell | null, cells: readonly Cell[], after: readonly Cell[], maxSeconds: number): WaterChoice | undefined {
  let best: WaterChoice | undefined;
  for (const cell of cells) {
    const seconds = from ? waterDetour(from, cell, after) : 0;
    if (seconds <= maxSeconds && (!best || seconds < best.seconds)) best = { cell, seconds };
  }
  return best;
}
