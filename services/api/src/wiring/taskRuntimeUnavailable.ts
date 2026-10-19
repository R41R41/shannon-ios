import type { ActionExecution } from '../infra/context/actionExecution.js';
import { FcaDecisionUnavailableError } from '../mind/action/fca/fcaProviderRetry.js';
import type { TaskRuntime, TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * A step whose decision never came back (`FcaDecisionUnavailableError`: the retries of `decideWithRetry` ran out) ran nothing. It is
 * closed as `continue` with nothing added (no history round, no message consumed, so nothing is duplicated) and the task runs the
 * decision again from a fresh observation, after a longer wait each time. Minebot parity audit C-20, 2026-10-19: before, this
 * happened once in a task's lifetime and the second failure ended the run.
 *
 * A Minecraft request goes on through `BODY_UNAVAILABLE_CYCLES` such rounds (about a quarter of an hour of a provider's outage in
 * all) and is then paused as stopped, not failed: the owner may resume it. Any other task keeps its one round and then fails with its
 * report, as before. The count (`fcaProviderRetries`) is reset by the next decision that comes back (`fcaRunner.ts`).
 */
export const BODY_UNAVAILABLE_CYCLES = 4;
const OTHER_UNAVAILABLE_CYCLES = 1;
const BODY_COOLDOWN_BASE_MS = 20_000;
const BODY_COOLDOWN_CAP_MS = 120_000;

/** The wait before the next round of a Minecraft request: 20 s, 40 s, 80 s, 120 s, +-20%. */
export function unavailableCooldownMs(cycles: number, random: () => number = Math.random): number {
  return Math.round(Math.min(BODY_COOLDOWN_CAP_MS, BODY_COOLDOWN_BASE_MS * 2 ** cycles) * (0.8 + random() * 0.4));
}

/** The longest wait before another round, whatever the provider asks for (the lease is renewed meanwhile; a stop ends the wait). */
export const UNAVAILABLE_WAIT_CAP_MS = 300_000;

/**
 * The wait before the next round: the round's own cooldown, never shorter than the `retry-after` the provider sent with the failure that
 * ended the retries (one longer than `decideWithRetry` waits for), and never longer than `UNAVAILABLE_WAIT_CAP_MS`. Before, a retry-after
 * above a minute ended the round and the next one asked again after about twenty seconds, into the provider's own wait.
 */
export function unavailableWaitMs(cooldownMs: number, retryAfterMs: number | null): number {
  return Math.min(UNAVAILABLE_WAIT_CAP_MS, Math.max(cooldownMs, retryAfterMs ?? 0));
}

/**
 * `continued`: the step is closed and the task runs again. `paused`: the Minecraft request is stopped, resumable. `failed`: the task
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
  log(line: string): void;
}

/** True when the time passed; false when the step was stopped, including a stop that came before the wait began (it waits for nothing). */
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

export const PROVIDER_UNAVAILABLE_SUMMARY = 'モデルの応答が続けて得られなかったため一時停止しています。応答が戻れば再開できます。';

/**
 * Settles a step that threw `FcaDecisionUnavailableError`, logging the closed code. Null: this is not an unavailable decision (or a
 * tool is in doubt, or the task is being stopped), and the caller judges the failure as before.
 */
export async function settleUnavailableStep(parts: UnavailableParts, step: TaskStep, error: unknown, execution: ActionExecution):
  Promise<UnavailableOutcome | null> {
  if (!(error instanceof FcaDecisionUnavailableError) || execution.stepOutcome === 'unknown') return null;
  // A task that is being stopped is the stop's to settle (the caller's `stoppedSafely`), however long this decision waited.
  if (parts.runtime.get(parts.scopeKey, step.taskId)?.phase !== 'executing') return null;
  const prior = step.snapshot.checkpoint && typeof step.snapshot.checkpoint === 'object' ? step.snapshot.checkpoint as Record<string, unknown> : {};
  const cycles = typeof prior.fcaProviderRetries === 'number' ? prior.fcaProviderRetries : 0;
  const body = parts.isBodyTask(step.taskId);
  if (cycles >= (body ? BODY_UNAVAILABLE_CYCLES : OTHER_UNAVAILABLE_CYCLES)) return finish(parts, step, error, body, prior, cycles);
  const milliseconds = unavailableWaitMs(body ? parts.bodyCooldownMs?.(cycles) ?? unavailableCooldownMs(cycles) : parts.otherCooldownMs(), error.retryAfterMs);
  if (!await sleep(milliseconds, execution.signal) || parts.runtime.get(parts.scopeKey, step.taskId)?.phase !== 'executing') return null;
  if (!close(parts, step, { ...prior, fcaProviderRetries: cycles + 1 })) return null;
  parts.log(`Shannon FCA step retried task=${step.taskId} code=${error.message}`);
  return 'continued';
}

/** The step committed as `continue` with nothing in it: a refused commit (a lost lease) leaves the step as it was. */
function close(parts: UnavailableParts, step: TaskStep, checkpoint: Record<string, unknown>): boolean {
  try {
    return parts.runtime.commitStep(step, { disposition: 'continue', history: [], consumedMessageIds: [], checkpoint }) !== null;
  } catch {
    return false;
  }
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
  parts.runtime.stop(parts.scopeKey, step.taskId, 'fca_provider_unavailable');
  parts.note(step.taskId, PROVIDER_UNAVAILABLE_SUMMARY);
  parts.log(`Shannon FCA step paused task=${step.taskId} code=${error.message} reason=provider_unavailable`);
  return 'paused';
}
