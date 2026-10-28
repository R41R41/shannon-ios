import type { ActHand, ActInput, ActPos, HandKind } from './minecraftActContract.js';

/**
 * The time of each hand, from what it is asked (r2, 2026-10-22; run 27: a walk of 80 m west had a ceiling of 11.6 s whatever its length,
 * and 4 of the first 5 acts were cut at their deadline; its 2.4 s guess never asked the next decision ahead):
 * - walk: the way's length from where she will stand when it begins (her feet, then each hand's end) through `path` or to `to`,
 *   across and up; typical at 4.3 m/s, the ceiling at half that (a way round) plus 3 s; 32 m when where she stands is not known;
 * - go (run 39): the straight distance to the nearest of its cells at 4.3 m/s with a third more for the digging and the bridging, within its `seconds`
 *   (default 60); the ceiling is its `seconds` and 2 s, for the body stops the hand at `seconds` and the act's deadline must lie after it;
 * - obsidian, fight, mine, make, portal, smelt (run 39): the ceiling is the hand's `seconds` (obsidian 90, fight 20, mine 60, portal 60, smelt 30) and 2 s; the
 *   expected time is obsidian 20 s and 8 s each, fight half its seconds, mine 1.5 s a block, make 1 s and 0.5 s each, portal 25 s, smelt 6 s and 2 s a kind;
 * - vertical (continue contract 6): the steps (|toY − the feet's y when the hand begins|, her feet then each hand's end; 32 when where she stands is not known) times
 *   the time of a step, from a first guess (stairs 1.6 s, shaft 1.0 s, pillar 0.9 s; a hypothesis, not a promise) or from the `msPerUnit` the body returned for that
 *   form (`ActTimeTuning`); the ceiling is its `seconds` (default 60) and 2 s, for the body stops the hand at `seconds`;
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
/** go: the most the hand may take (its `seconds`), and about how long it takes (the straight way and a third more, within the most). */
export const GO_DEFAULT_SECONDS = 60;
const goMostMs = (hand: ActHand) => 1_000 * (hand.seconds ?? GO_DEFAULT_SECONDS);
/** The hands that take a range (run 39) and their default `seconds`. */
const SECONDS_BY_KIND: Partial<Record<HandKind, number>> = { obsidian: 90, fight: 20, mine: 60, portal: 60, smelt: 30 };
const mostMs = (hand: ActHand) => 1_000 * (hand.seconds ?? SECONDS_BY_KIND[hand.do] ?? 30) + 2_000;
const blocksOf = (hand: ActHand) => Math.max(1, hand.count ?? 1);
/**
 * vertical: about how long one step takes by form (ms; the first guess of the continue contract 6, a hypothesis until the body's `progress.msPerUnit` replaces it),
 * the steps when the feet's y is not known, and the most the hand may take when it names no `seconds`.
 */
export const VERTICAL_MS_PER_STEP: Readonly<Record<'stairs' | 'shaft' | 'pillar', number>> = { stairs: 1_600, shaft: 1_000, pillar: 900 };
export const VERTICAL_UNKNOWN_STEPS = 32;
/**
 * Amendment A-1 6: what a vertical hand means when it names no limit (the body's `VERTICAL_DEFAULTS`: 200 digs, 100 places, 60 seconds, a seal radius of 1) and the range
 * of its `seconds` (5 to 120, go's own). The short grammar shows both to the model and `verticalProblem` checks the same range.
 */
export const VERTICAL_DEFAULTS = { maxDig: 200, maxPlace: 100, seconds: 60, range: 1 } as const;
export const VERTICAL_SECONDS_RANGE = [5, 120] as const;
export const VERTICAL_DEFAULT_SECONDS = VERTICAL_DEFAULTS.seconds;
/** What the body measured: `progress.msPerUnit` of a vertical hand's result (ms a step), by the form that ran. Used in place of the first guess. */
export type ActTimeTuning = Partial<Record<keyof typeof VERTICAL_MS_PER_STEP, number>>;
/** A measured ms a step the estimate may take: a finite number of 100 ms to 20 s, else the first guess is kept. */
const measuredMs = (value: number | undefined): number | null => value !== undefined && Number.isFinite(value) && value >= 100 && value <= 20_000 ? value : null;
const verticalStepMs = (hand: ActHand, tune: ActTimeTuning): number => {
  const shape = hand.shape && Object.hasOwn(VERTICAL_MS_PER_STEP, hand.shape) ? hand.shape : 'stairs';
  return measuredMs(tune[shape]) ?? VERTICAL_MS_PER_STEP[shape];
};
/** The steps of a vertical hand from the feet's y when it begins (the whole y of the feet; null: not known). */
export function verticalSteps(hand: ActHand, feetY: number | null): number {
  return feetY === null || typeof hand.toY !== 'number' ? VERTICAL_UNKNOWN_STEPS : Math.abs(hand.toY - Math.floor(feetY));
}
const verticalMostMs = (hand: ActHand) => 1_000 * (hand.seconds ?? VERTICAL_DEFAULT_SECONDS) + 2_000;
const COMPASS_STEP: Readonly<Record<string, { x: number; z: number }>> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };
const goTypicalMs = (hand: ActHand, metres: number) => Math.min(goMostMs(hand), 1_000 + 1.3 * walkMs(hand, metres));
const CEILING_MS: Partial<Record<HandKind, HandTime>> = {
  walk: (hand, metres) => 3_000 + 2 * walkMs(hand, metres), go: hand => goMostMs(hand) + 2_000,
  obsidian: mostMs, fight: mostMs, mine: mostMs, portal: mostMs, smelt: mostMs, vertical: verticalMostMs, make: hand => 3_000 + 1_000 * blocksOf(hand),
  dig: hand => 10_000 * cells(hand), place: hand => 1_500 * cells(hand),
  pillarUp: hand => 1_200 * times(hand), attack: hand => 1_000 * (hand.seconds ?? 20) + 2_000,
  shoot: hand => (1_500 + 1_000 * (hand.charge ?? 1)) * times(hand), wait: hand => 1_000 * (hand.seconds ?? 1) + 500,
  pickup: hand => 3_000 + 1_000 * (hand.range ?? 6), use: () => 4_000, craft: hand => 2_000 + 300 * Math.min(64, hand.count ?? 1),
  jump: hand => 1_000 * times(hand) + 500, chest: () => 6_000, furnace: () => 5_000, eat: () => 4_000,
};
const TYPICAL_MS: Partial<Record<HandKind, HandTime>> = {
  walk: (hand, metres) => 500 + walkMs(hand, metres), go: goTypicalMs,
  obsidian: hand => Math.min(mostMs(hand), 20_000 + 8_000 * blocksOf(hand)), fight: hand => 500 * (hand.seconds ?? 20),
  mine: hand => Math.min(mostMs(hand), 1_500 * blocksOf(hand) + 1_000),
  make: hand => 1_000 + 500 * blocksOf(hand), portal: () => 25_000, smelt: hand => 6_000 + 2_000 * (hand.items?.length ?? 1),
  dig: hand => 900 * cells(hand), place: hand => 400 * cells(hand),
  pillarUp: hand => 600 * times(hand), attack: hand => Math.min(8_000, 1_000 * (hand.seconds ?? 6)), wait: hand => 1_000 * (hand.seconds ?? 1),
  eat: () => 1_700, pickup: hand => 1_000 + 300 * (hand.range ?? 6), use: () => 1_000, shoot: hand => (500 + 1_000 * (hand.charge ?? 1)) * times(hand),
  craft: hand => 500 + 150 * Math.min(64, hand.count ?? 1), jump: hand => 600 * times(hand), chest: () => 1_500, furnace: () => 1_200,
  equip: () => 300, look: () => 200, sneak: () => 200, drop: hand => 300 * (hand.items?.length ?? 1),
};
const distance = (from: ActPos, to: ActPos) => Math.hypot(to.x - from.x, to.z - from.z) + Math.abs(to.y - from.y);
/** A walk's points; a go's single cell, or the nearest of its goals (the first when she is not known to stand anywhere). */
function nearestOf(hand: ActHand, at: ActPos | null): readonly ActPos[] {
  if (hand.do === 'walk') return hand.path?.length ? hand.path : hand.to ? [hand.to] : [];
  if (hand.to) return [hand.to];
  const goals = hand.goals ?? [];
  if (!at || goals.length < 2) return goals.slice(0, 1);
  const absolute = (goal: ActPos) => hand.rel ? { x: at.x + goal.x, y: at.y + goal.y, z: at.z + goal.z } : goal;
  return [goals.reduce((best, goal) => distance(at, absolute(goal)) < distance(at, absolute(best)) ? goal : best)];
}
/** Each hand with the metres it walks: from `from` (her feet when the act begins), each hand starting where the one before ended. */
function handMetres(input: ActInput, from: ActPos | null): Array<{ hand: ActHand; metres: number; steps?: number }> {
  let at: ActPos | null = from ? { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) } : null;
  return input.hands.map(hand => {
    if (hand.do === 'pillarUp' && at) at = { ...at, y: at.y + times(hand) };
    if (hand.do === 'vertical') {
      // The steps from where she will stand, and where the next hand starts: the y asked for, and for stairs one cell on toward each step.
      const steps = verticalSteps(hand, at ? at.y : null), way = hand.shape === 'stairs' && hand.toward ? COMPASS_STEP[hand.toward] : undefined;
      if (at && typeof hand.toY === 'number') at = { x: at.x + (way?.x ?? 0) * steps, y: hand.toY, z: at.z + (way?.z ?? 0) * steps };
      return { hand, metres: 0, steps };
    }
    if (hand.do !== 'walk' && hand.do !== 'go') return { hand, metres: 0 };
    const points = nearestOf(hand, at).map(point => hand.rel && at
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
function typicalTimes(input: ActInput, from: ActPos | null, tune: ActTimeTuning): number[] {
  return handMetres(input, from).map(({ hand, metres, steps }) => hand.do === 'vertical'
    ? Math.min(verticalMostMs(hand) - 2_000, 1_000 + (steps ?? VERTICAL_UNKNOWN_STEPS) * verticalStepMs(hand, tune))
    : TYPICAL_MS[hand.do]?.(hand, metres) ?? 400);
}
/** How long an act is likely to take (for asking the next decision while it runs); every pass of a repeat, not capped. */
export function actExpectedMilliseconds(input: ActInput, from: ActPos | null = null, tune: ActTimeTuning = {}): number {
  return Math.round(typicalTimes(input, from, tune).reduce((sum, time) => sum + time, 0) * passes(input));
}
/**
 * How much of an act is likely left (the task queue's calling condition): with the body's progress (the hand running, 1-based, and the pass),
 * the hands from the running one to the pass's end and the passes after it; without it, the expected time less what has run. Never below zero.
 * `tune`: the ms a step the body measured for a vertical form (`progress.msPerUnit` of its result), in place of the first guess.
 */
export function actRemainingMilliseconds(input: ActInput, from: ActPos | null, progress: { hand: number; iteration: number } | null,
  elapsedMs: number, tune: ActTimeTuning = {}): number {
  const times = typicalTimes(input, from, tune), total = passes(input);
  if (!progress) return Math.max(0, Math.round(times.reduce((sum, time) => sum + time, 0) * total - Math.max(0, elapsedMs)));
  const pass = times.reduce((sum, time) => sum + time, 0);
  const rest = times.slice(Math.max(0, progress.hand - 1)).reduce((sum, time) => sum + time, 0);
  return Math.max(0, Math.round(rest + pass * Math.max(0, total - Math.max(1, progress.iteration))));
}
