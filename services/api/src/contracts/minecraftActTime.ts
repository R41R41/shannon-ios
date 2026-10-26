import type { ActHand, ActInput, ActPos, HandKind } from './minecraftActContract.js';

/**
 * The time of each hand, from what it is asked (r2, 2026-10-22; run 27: a walk of 80 m west had a ceiling of 11.6 s whatever its length,
 * and 4 of the first 5 acts were cut at their deadline; its 2.4 s guess never asked the next decision ahead):
 * - walk: the way's length from where she will stand when it begins (her feet, then each hand's end) through `path` or to `to`,
 *   across and up; typical at 4.3 m/s, the ceiling at half that (a way round) plus 3 s; 32 m when where she stands is not known;
 * - dig, place: by the cells; pillarUp, jump, shoot: by `n`; attack and wait: by `seconds`; craft: by `count`; the rest fixed.
 * Task queue: an act that repeats its hands (`repeat`) takes that many times as long; the ceiling is still the body's one bound,
 * the expected time is not capped.
 */
const WALK_MPS = 4.3, SPRINT_MPS = 5.6, UNKNOWN_WALK_M = 32;
/** The longest act (the body's own bound is 180 s; the command adds its margin). */
export const ACT_MAX_MS = 170_000;
type HandTime = (hand: ActHand, metres: number) => number;
const cells = (hand: ActHand) => hand.at?.length ?? 1, times = (hand: ActHand) => hand.n ?? 1;
const walkMs = (hand: ActHand, metres: number) => 1_000 * metres / (hand.sprint ? SPRINT_MPS : WALK_MPS);
const CEILING_MS: Partial<Record<HandKind, HandTime>> = {
  walk: (hand, metres) => 3_000 + 2 * walkMs(hand, metres), dig: hand => 10_000 * cells(hand), place: hand => 1_500 * cells(hand),
  pillarUp: hand => 1_200 * times(hand), attack: hand => 1_000 * (hand.seconds ?? 20) + 2_000,
  shoot: hand => (1_500 + 1_000 * (hand.charge ?? 1)) * times(hand), wait: hand => 1_000 * (hand.seconds ?? 1) + 500,
  pickup: hand => 3_000 + 1_000 * (hand.range ?? 6), use: () => 4_000, craft: hand => 2_000 + 300 * Math.min(64, hand.count ?? 1),
  jump: hand => 1_000 * times(hand) + 500, chest: () => 6_000, furnace: () => 5_000, eat: () => 4_000,
};
const TYPICAL_MS: Partial<Record<HandKind, HandTime>> = {
  walk: (hand, metres) => 500 + walkMs(hand, metres), dig: hand => 900 * cells(hand), place: hand => 400 * cells(hand),
  pillarUp: hand => 600 * times(hand), attack: hand => Math.min(8_000, 1_000 * (hand.seconds ?? 6)), wait: hand => 1_000 * (hand.seconds ?? 1),
  eat: () => 1_700, pickup: hand => 1_000 + 300 * (hand.range ?? 6), use: () => 1_000, shoot: hand => (500 + 1_000 * (hand.charge ?? 1)) * times(hand),
  craft: hand => 500 + 150 * Math.min(64, hand.count ?? 1), jump: hand => 600 * times(hand), chest: () => 1_500, furnace: () => 1_200,
  equip: () => 300, look: () => 200, sneak: () => 200, drop: hand => 300 * (hand.items?.length ?? 1),
};
const distance = (from: ActPos, to: ActPos) => Math.hypot(to.x - from.x, to.z - from.z) + Math.abs(to.y - from.y);
/** Each hand with the metres it walks: from `from` (her feet when the act begins), each hand starting where the one before ended. */
function handMetres(input: ActInput, from: ActPos | null): Array<{ hand: ActHand; metres: number }> {
  let at: ActPos | null = from ? { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) } : null;
  return input.hands.map(hand => {
    if (hand.do === 'pillarUp' && at) at = { ...at, y: at.y + times(hand) };
    if (hand.do !== 'walk') return { hand, metres: 0 };
    const points = (hand.path?.length ? hand.path : hand.to ? [hand.to] : []).map(point => hand.rel && at
      ? { x: at.x + point.x, y: at.y + point.y, z: at.z + point.z } : point);
    if (!points.length) return { hand, metres: 0 };
    let metres = 0;
    if (hand.rel && !at) metres = points.reduce((sum, point, index) => sum + distance(index ? points[index - 1]! : { x: 0, y: 0, z: 0 }, point), 0);
    else if (!at) metres = UNKNOWN_WALK_M + points.slice(1).reduce((sum, point, index) => sum + distance(points[index]!, point), 0);
    else metres = points.reduce((sum, point, index) => sum + distance(index ? points[index - 1]! : at!, point), 0);
    at = hand.rel && !at ? null : points[points.length - 1]!;
    return { hand, metres };
  });
}
/** How many times the hands run: the act's `repeat` (2–8), else once. */
const passes = (input: ActInput): number => Number.isInteger(input.repeat) && input.repeat! >= 2 ? Math.min(8, input.repeat!) : 1;
/** How long an act may run on the body: the sum of each hand's ceiling times its passes, within 5 s and `ACT_MAX_MS` (the command adds its own margin). */
export function actMilliseconds(input: ActInput, from: ActPos | null = null): number {
  const total = handMetres(input, from).reduce((sum, { hand, metres }) => sum + (CEILING_MS[hand.do]?.(hand, metres) ?? 2_000), 0) * passes(input);
  return Math.round(Math.max(5_000, Math.min(ACT_MAX_MS, total)));
}
/** The typical time of each hand of one pass. */
function typicalTimes(input: ActInput, from: ActPos | null): number[] {
  return handMetres(input, from).map(({ hand, metres }) => TYPICAL_MS[hand.do]?.(hand, metres) ?? 400);
}
/** How long an act is likely to take (for asking the next decision while it runs); every pass of a repeat, not capped. */
export function actExpectedMilliseconds(input: ActInput, from: ActPos | null = null): number {
  return Math.round(typicalTimes(input, from).reduce((sum, time) => sum + time, 0) * passes(input));
}
/**
 * How much of an act is likely left (the task queue's calling condition): with the body's progress (the hand running, 1-based, and the pass),
 * the hands from the running one to the pass's end and the passes after it; without it, the expected time less what has run. Never below zero.
 */
export function actRemainingMilliseconds(input: ActInput, from: ActPos | null, progress: { hand: number; iteration: number } | null,
  elapsedMs: number): number {
  const times = typicalTimes(input, from), total = passes(input);
  if (!progress) return Math.max(0, Math.round(times.reduce((sum, time) => sum + time, 0) * total - Math.max(0, elapsedMs)));
  const pass = times.reduce((sum, time) => sum + time, 0);
  const rest = times.slice(Math.max(0, progress.hand - 1)).reduce((sum, time) => sum + time, 0);
  return Math.max(0, Math.round(rest + pass * Math.max(0, total - Math.max(1, progress.iteration))));
}
