import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { milestoneNow } from './minecraftStage.js';
import { minecraftProcedureFacts } from './minecraftProcedureFacts.js';

/**
 * The route's lateness looked at between decisions (mb-r25, Minecraft run 25: one call of the procedures ran 436 s, then 484 s, and the
 * route was asked again for lateness only at the call's end -- 545 s and 1,034 s, after the iron pickaxe at 319 and the bucket at 549 --
 * so the answer came after the steps it was for). The monitor's poll reads each frame, so the step now is read from it every
 * `WATCH_MS`, and a plan that is wanted is asked at once; the answer is taken whenever it comes (`createRoutePlanning`).
 */
const WATCH_MS = 5_000;

export function routeWatcher(parts: {
  plan: { watch(world: Record<string, unknown> | null, milestone: string | null, elapsedSeconds: number): void };
  createdAt: string; now(): number;
}): (frame: BodyObservation) => void {
  const began = Date.parse(parts.createdAt);
  let last = -Infinity;
  return frame => {
    const at = parts.now();
    if (at - last < WATCH_MS || !Number.isFinite(began) || frame.facts.alive === false) return;
    last = at;
    const world = frame.state.world && typeof frame.state.world === 'object' ? frame.state.world as Record<string, unknown> : null;
    parts.plan.watch(world, milestoneNow(minecraftProcedureFacts(frame).milestone).now.name, Math.max(0, (at - began) / 1000));
  };
}
