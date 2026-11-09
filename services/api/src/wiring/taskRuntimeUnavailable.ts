import type { ActionExecution } from '../infra/context/actionExecution.js';
import { FCA_MODEL_BILLING, FcaDecisionUnavailableError } from '../mind/action/fca/fcaProviderRetry.js';
import type { TaskRuntime, TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { BILLING_PAUSED_SUMMARY, PROVIDER_UNAVAILABLE_SUMMARY, pausedReport } from './taskPauseNotice.js';
import { BODY_ABSENT_SUMMARY } from './fcaBodyRecoveryPolicy.js';

/**
 * A step whose decision never came back (`FcaDecisionUnavailableError`: the retries of `decideWithRetry` ran
 * out) ran nothing. It is
 * closed as `continue` with nothing added (no history round, no message consumed, so nothing is duplicated) and the task runs the
 * decision again from a fresh observation, after a longer wait each time. Minebot parity audit C-20, 2026-10-19: before, this
 * happened once in a task's lifetime and the second failure ended the run.
 *
 * A Minecraft request goes on through `BODY_UNAVAILABLE_CYCLES` such rounds (about three quarters of an hour of a provider's outage in all:
 * a run of 4 to 5 hours nobody watches, 2026-11-02, does not wait for a person for less) and is then paused as stopped, not failed: the owner
 * may resume it. Any other task keeps its one round and then fails with its report, as before. The count (`fcaProviderRetries`) is reset by
 * the next decision that comes back (`fcaRunner.ts`).
 */
export const BODY_UNAVAILABLE_CYCLES = 24;
const OTHER_UNAVAILABLE_CYCLES = 1;
const BODY_COOLDOWN_BASE_MS = 20_000;
const BODY_COOLDOWN_CAP_MS = 120_000;

/**
 * A decision that was not asked because the request's own body is not there (2026-11-02: the body alone went down in a recovery test, and each failing
 * decision cost about ¥3.5 while the failures climbed the ladder; `withBodyPresent`, `minecraftLlmcLifecycle.ts`) ran nothing and called no
 * model, so waiting for the body costs nothing: rounds of `BODY_ABSENT_WAIT_MS` for `BODY_ABSENT_CYCLES` of them (2 hours: a Spot VM that comes
 * back, a body that logs in again), then the request is paused as stopped, not failed. The owner may resume it.
 */
export const BODY_ABSENT_CODE = 'MINECRAFT_BODY_ABSENT';
export const BODY_ABSENT_REASON = 'body_absent';
export const BODY_ABSENT_CYCLES = 240;
const BODY_ABSENT_WAIT_MS = 30_000;

/** The wait before the next round of a Minecraft request: 20 s, 40 s, 80 s, 120 s, +-20%. */
export function unavailableCooldownMs(cycles: number, random: () => number = Math.random): number {
  return Math.round(Math.min(BODY_COOLDOWN_CAP_MS, BODY_COOLDOWN_BASE_MS * 2 ** cycles) * (0.8 + random() * 0.4));
}

/** The longest wait before another round, whatever the provider asks for (the lease is renewed meanwhile; a stop
 * ends the wait). */
export const UNAVAILABLE_WAIT_CAP_MS = 300_000;

/**
 * The wait before the next round: the round's own cooldown, never shorter than the `retry-after` the provider
 * sent with the failure that
 * ended the retries (one longer than `decideWithRetry` waits for), and never longer than
 * `UNAVAILABLE_WAIT_CAP_MS`. Before, a retry-after
 * above a minute ended the round and the next one asked again after about twenty seconds, into the provider's own wait.
 */
export function unavailableWaitMs(cooldownMs: number, retryAfterMs: number | null): number {
  return Math.min(UNAVAILABLE_WAIT_CAP_MS, Math.max(cooldownMs, retryAfterMs ?? 0));
}

/**
 * `continued`: the step is closed and the task runs again. `paused`: the Minecraft request is stopped,
 * resumable. `failed`: the task
 * failed with its report.
 */
export type UnavailableOutcome = 'continued' | 'paused' | 'failed';

export interface UnavailableParts {
  runtime: TaskRuntime; scopeKey: string;
  isBodyTask(taskId: string): boolean;
  /** The wait before another round of a task that is not a Minecraft request (3-5 s; tests: 0). */
  otherCooldownMs(): number;
  /** Tests: the wait of a Minecraft request's round, in place of its backoff. */
  bodyCooldownMs?: ((cycles: number) => number) | undefined;
  /** Fails a task that is not a Minecraft request with its report (a known failure: nothing ran); false: it cannot be failed. */
  fail(step: TaskStep): boolean;
  /** Writes the task's summary (what the owner and `task.get` read) without changing its state. */
  note(taskId: string, summary: string): void;
  /** Tells the owner (the task's report) that the task was paused, once per `key`. */
  pauseNotice(taskId: string, key: string, text: string): void;
  log(line: string): void;
}

/** True when the time passed; false when the step was stopped, including a stop that came before the wait began
 * (it waits for nothing). */
export function sleep(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve(true);
    }, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', stop, { once: true });
  });
}

export { PROVIDER_UNAVAILABLE_SUMMARY };

/**
 * What the step's ports hold of their own state by now (the plan, the new plans asked for, the waits). A step that ran nothing is closed with it, not with the
 * state it began with: a bound counted in the step (a new plan asked of the strong model) is not dealt again by a decision that failed (Codex, 2026-11-02).
 */
export type FreshCheckpoint = () => Record<string, unknown>;
function kept(fresh?: FreshCheckpoint): Record<string, unknown> {
  try {
    return fresh?.() ?? {};
  } catch {
    return {};
  }
}

/** How many rounds a request goes through before it is paused (a Minecraft request whose body is not there: `BODY_ABSENT_CYCLES`). */
const roundLimit = (body: boolean, absent: boolean): number => absent ? BODY_ABSENT_CYCLES : body ? BODY_UNAVAILABLE_CYCLES : OTHER_UNAVAILABLE_CYCLES;

/** The wait before the next round (tests replace a Minecraft request's wait with `bodyCooldownMs`). */
function roundWaitMs(parts: UnavailableParts, round: { body: boolean; absent: boolean; answered: boolean; cycles: number; retryAfterMs: number | null }): number {
  if (round.absent) return parts.bodyCooldownMs?.(round.cycles) ?? BODY_ABSENT_WAIT_MS;
  // end1108b: the provider answered (in words, or cut at its ceiling); it is not down, so a Minecraft request does not wait
  // 20 s-2 min for it with the body standing in the world. The round goes on after the short wait of any other task.
  const cooldown = round.body && !round.answered ? parts.bodyCooldownMs?.(round.cycles) ?? unavailableCooldownMs(round.cycles) : parts.otherCooldownMs();
  return unavailableWaitMs(cooldown, round.retryAfterMs);
}

/**
 * Settles a step that threw `FcaDecisionUnavailableError`, logging the closed code. Null: this is not an
 * unavailable decision (or a
 * tool is in doubt, or the task is being stopped), and the caller judges the failure as before.
 */
export async function settleUnavailableStep(parts: UnavailableParts, step: TaskStep, error: unknown, execution: ActionExecution, fresh?: FreshCheckpoint):
  Promise<UnavailableOutcome | null> {
  if (!(error instanceof FcaDecisionUnavailableError) || execution.stepOutcome === 'unknown') return null;
  // A task that is being stopped is the stop's to settle (the caller's `stoppedSafely`), however long this decision waited.
  if (parts.runtime.get(parts.scopeKey, step.taskId)?.phase !== 'executing') return null;
  const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object' ? step.snapshot.checkpoint as Record<string, unknown> : {};
  const cycles = typeof prior.fcaProviderRetries === 'number' ? prior.fcaProviderRetries : 0;
  const body = parts.isBodyTask(step.taskId);
  const absent = body && error.reason === BODY_ABSENT_REASON;
  if (cycles >= roundLimit(body, absent)) return finish(parts, step, error, body, { ...prior, ...kept(fresh) }, cycles);
  const answered = error.reason === 'no_decision' || error.reason === 'truncated';
  const milliseconds = roundWaitMs(parts, { body, absent, answered, cycles, retryAfterMs: error.retryAfterMs });
  if (!await sleep(milliseconds, execution.signal) || parts.runtime.get(parts.scopeKey, step.taskId)?.phase !== 'executing') return null;
  if (!close(parts, step, { ...prior, ...kept(fresh), fcaProviderRetries: cycles + 1 })) return null;
  parts.log(`Shannon FCA step retried task=${step.taskId} code=${error.message}`);
  return 'continued';
}

/**
 * A-20 (run 47: the credit ran out, the provider refused with HTTP 400, and the request was failed with the
 * world running): the decision was refused for the account's credit, so nothing
 * ran. A Minecraft request is paused (the step closed as `continue`, the request stopped, resumable) at once,
 * not after rounds: nothing is asked again until the balance is filled. False
 * for any other task (it fails as a refused request does) or when the step cannot be closed.
 */
export function pauseForBilling(parts: UnavailableParts, step: TaskStep, execution: ActionExecution, fresh?: FreshCheckpoint): boolean {
  if (execution.stepOutcome === 'unknown' || !parts.isBodyTask(step.taskId) || parts.runtime.get(parts.scopeKey,
     step.taskId)?.phase !== 'executing') return false;
  const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object' ? step.snapshot.checkpoint as Record<string, unknown> : {};
  if (!close(parts, step, { ...prior, ...kept(fresh) })) return false;
  parts.runtime.stop(parts.scopeKey, step.taskId, 'fca_billing');
  parts.note(step.taskId, BILLING_PAUSED_SUMMARY);
  try {
    parts.pauseNotice(step.taskId, step.id, pausedReport(parts.runtime.get(parts.scopeKey, step.taskId)?.title ?? '', BILLING_PAUSED_SUMMARY));
  } catch { /* the task is paused either way; its summary says so */ }
  parts.log(`Shannon FCA step paused task=${step.taskId} code=${FCA_MODEL_BILLING} reason=billing`);
  return true;
}

/** The step committed as `continue` with nothing in it: a refused commit (a lost lease) leaves the step as it was. */
function close(parts: UnavailableParts, step: TaskStep, checkpoint: Record<string, unknown>): boolean {
  try {
    return parts.runtime.commitStep(step, { disposition: 'continue', history: [], consumedMessageIds: [], checkpoint }) !== null;
  } catch {
    return false;
  }
}

/** How a Minecraft request whose rounds are used up is paused: the provider's words, or the body's when it was the body that did not come. */
function pauseWords(error: Error): { reason: string; stop: string; summary: string } {
  return error instanceof FcaDecisionUnavailableError && error.reason === BODY_ABSENT_REASON
    ? { reason: 'body_absent', stop: 'fca_body_not_returned', summary: BODY_ABSENT_SUMMARY }
    : { reason: 'provider_unavailable', stop: 'fca_provider_unavailable', summary: PROVIDER_UNAVAILABLE_SUMMARY };
}

/** The rounds are used up: a Minecraft request is paused, any other task fails with its report. */
function finish(parts: UnavailableParts, step: TaskStep, error: Error, body: boolean, prior: Record<string, unknown>, cycles: number):
  UnavailableOutcome | null {
  if (!body) {
    if (!parts.fail(step)) return null;
    parts.log(`Shannon FCA step failed task=${step.taskId} code=${error.message}`);
    return 'failed';
  }
  if (!close(parts, step, { ...prior, fcaProviderRetries: cycles + 1 })) return null;
  const words = pauseWords(error);
  parts.runtime.stop(parts.scopeKey, step.taskId, words.stop);
  parts.note(step.taskId, words.summary);
  // The owner hears of it as he heard of the failure this replaced; once, whatever the pause then does (the step id is its key).
  try {
    parts.pauseNotice(step.taskId, step.id, pausedReport(parts.runtime.get(parts.scopeKey, step.taskId)?.title ?? '', words.summary));
  } catch { /* the task is paused either way; its summary says so */ }
  parts.log(`Shannon FCA step paused task=${step.taskId} code=${error.message} reason=${words.reason}`);
  return 'paused';
}
