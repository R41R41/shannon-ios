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
 * A request nobody is watching (a Minecraft request not held on a failure; the filming run, 4 to 5 hours, 2026-11-02) does not stop at the
 * ladder's stop: it has its plan made again by the strong model (`minecraftLlmcReplan.ts`: at least 10 minutes apart, 6 an hour, 30 a run)
 * and goes on. It stops only when failed steps in a row, after the fifth was read, have gone on for this long with nothing moved (the
 * plans made meanwhile did not help: 3 of them at the 10-minute spacing), or at this many in a row whatever the time.
 */
export const UNATTENDED_STALL_MS = 30 * 60_000;
export const UNATTENDED_HARD_LIMIT = 200;

/** The stop of a request nobody is watching; the review at three failures (`FAILURE_REVIEW_AT`) is the same. */
export function unattendedFailureStops(input: { body: boolean; failures: number; priorFailures: number; since: number | null; now: number }): boolean {
  const { body, failures, priorFailures, since, now } = input;
  if (!body) return failures >= FAILURE_STOP_AFTER;
  if (failures <= FAILURE_STOP_AFTER || priorFailures < FAILURE_STOP_AFTER) return false;
  return failures >= UNATTENDED_HARD_LIMIT || (since !== null && now - since >= UNATTENDED_STALL_MS);
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
