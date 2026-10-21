import type { BodyObservation } from '../../contracts/bodyControlContract.js';

/**
 * A procedure is not started on a body that has just come back and is not steady yet (mb-r22, owner's coordinator 2026-10-21: run 22's
 * body froze at 1,087 s and was cut off, the task resumed after the login and its procedure ran at once, and the body froze the same way
 * 9 s later). After the body arrived (login, reconnection, respawn: `MinecraftControl.arrivedAt`) the procedure waits for the frames to come
 * steadily: `SETTLE.afterArrivalMs` since the arrival and `SETTLE.frames` frames within the last `SETTLE.windowMs`, none more than
 * `SETTLE.maxGapMs` after the one before. A body whose event loop is held sends no frame, so the wait goes on, and past `SETTLE.giveUpMs` the
 * turn goes back to the planner with the reason (it can wait, or look at the body). A body that arrived long ago is not asked to settle.
 */
export const SETTLE = Object.freeze({ recentMs: 40_000, afterArrivalMs: 6_000, windowMs: 5_000, frames: 3, maxGapMs: 2_000, giveUpMs: 45_000, pollMs: 250 });

export interface SettleParts {
  arrivedAt?(): number | null;
  observe(): BodyObservation | null;
  now(): number;
  sleep?(milliseconds: number): Promise<void>;
}

/** Whether the frames seen (the times each new one was first seen) are steady at `now`. */
export function framesSteady(seen: readonly number[], now: number): boolean {
  const recent = seen.filter(at => now - at <= SETTLE.windowMs);
  if (recent.length < SETTLE.frames || now - recent.at(-1)! > SETTLE.maxGapMs) return false;
  return recent.every((at, index) => index === 0 || at - recent[index - 1]! <= SETTLE.maxGapMs);
}

/** Null when the body is steady (or has not just arrived); else the reason the turn goes back, after waiting as long as `giveUpMs`. */
export async function settledBody(parts: SettleParts, signal: AbortSignal): Promise<string | null> {
  const arrived = parts.arrivedAt?.() ?? null;
  const started = parts.now();
  if (arrived === null || started - arrived > SETTLE.recentMs) return null;
  const sleep = parts.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const seen: number[] = [];
  let last: number | null = null;
  while (!signal.aborted) {
    const at = parts.now(), frame = parts.observe();
    if (frame && frame.sequence !== last) {
      last = frame.sequence;
      seen.push(at);
    }
    if (at - arrived >= SETTLE.afterArrivalMs && framesSteady(seen, at)) return null;
    if (at - started >= SETTLE.giveUpMs) return `体が戻ってまだ落ち着いていない（観測が${seen.length ? '途切れる' : '届かない'}、${Math.round((at - arrived) / 1000)}秒）`;
    await sleep(SETTLE.pollMs);
  }
  return null;
}
