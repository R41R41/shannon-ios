/**
 * What a body task does with failed steps in a row (mb-r23, Minecraft run 23, 2026-10-21: the task stopped at the fifth failed step with
 * 9 of 10 obsidian, the instant its commit was made; the result of that last call, which carried the body's own next move, was never
 * read by a decision, and three of the five "failures" had made things: the diamond pickaxe, six obsidian, three more).
 *
 * The ladder, in order:
 * 1. A call that failed but made something (`ToolResult.progressed`: the pack grew, a milestone was passed) is not a failed step.
 * 2. From `FAILURE_REVIEW_AT` failures in a row the next decision is told to look back before it acts (`minecraftFailureReview.ts`): the
 *    reasons of the last failures, the numbers below, and to find the cause (look at the surroundings and the pack) or take another way.
 * 3. The task stops only on a failure that comes after a decision has read the `FAILURE_STOP_AFTER`th, and then only when nothing has
 *    moved for `FAILURE_STALL_MS` (nothing carried, no milestone, no place), or at `FAILURE_HARD_LIMIT` in a row, whatever the time.
 *
 * A task that is not a body task keeps the old rule (the fifth failed step stops it): its tools fail in a second, and there is no
 * progress to measure.
 */
export const FAILURE_REVIEW_AT = 3;
export const FAILURE_STOP_AFTER = 5;
export const FAILURE_HARD_LIMIT = 10;
export const FAILURE_STALL_MS = 120_000;

/** The checkpoint key of the time (ms) the failures in a row began, absent while none is running. */
export const FAILURE_SINCE_KEY = 'fcaFailureSince';

/** When the failures in a row of a stored checkpoint began (ms), or null. */
export function failureSinceOf(checkpoint: Readonly<Record<string, unknown>>): number | null {
  const value = Number(checkpoint[FAILURE_SINCE_KEY]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The beginning of the failures in a row after a step: kept while they go on, set by the step that began them, gone when they end. */
export function nextFailureSince(since: number | null, priorFailures: number, failures: number, stepStartedAt: number): number | null {
  if (failures <= 0) return null;
  return priorFailures <= 0 || since === null ? stepStartedAt : since;
}

/** The checkpoint entry to commit: explicit null clears a stored one. */
export function failureSinceCheckpoint(since: number | null, prior: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (since === null) return failureSinceOf(prior) === null ? {} : { [FAILURE_SINCE_KEY]: null };
  return { [FAILURE_SINCE_KEY]: since };
}

/**
 * Whether the failures in a row stop the task now. `priorFailures` is the count the step's decision began with: it was made having read
 * the result of the failure that brought the count to that.
 */
export function failureStops(input: { body: boolean; failures: number; priorFailures: number; since: number | null; now: number }): boolean {
  const { body, failures, priorFailures, since, now } = input;
  if (!body) return failures >= FAILURE_STOP_AFTER;
  if (failures <= FAILURE_STOP_AFTER || priorFailures < FAILURE_STOP_AFTER) return false;
  return failures >= FAILURE_HARD_LIMIT || (since !== null && now - since >= FAILURE_STALL_MS);
}
