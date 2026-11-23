import { setTimeout as delay } from 'node:timers/promises';

/**
 * How long the owner's login, logout, start and stop wait for what is still settling before they are refused (Minecraft run, 2026-11-23
 * 17:39). The owner pressed 「出る」 right after her plan was stopped: the body was still held for a moment and the first press was refused
 * with `lease_conflict`; ten seconds later it went through, and two seconds after that the operator's own `logout` was refused with
 * `unresolved_operation` because the receipt of the one just finished had not been written yet. Both clear by themselves within a few
 * seconds, so the operation looks again for a short while instead of answering at once. It only waits: every condition that refused
 * before still refuses after the wait, with the same words.
 */
export const LIFECYCLE_UNRESOLVED_WAIT_MS = 5_000;
/** The body's (or the Minecraft slot's) hold released by the work the logout stopped: a plan's lease is let go within seconds of the stop. */
export const LIFECYCLE_BODY_WAIT_MS = 8_000;
export const LIFECYCLE_WAIT_STEP_MS = 250;

/** The waits of one operation (tests shorten them). */
export interface LifecycleWaits { unresolvedMs?: number | undefined; bodyMs?: number | undefined; stepMs?: number | undefined }

/** The waits with their defaults filled in. */
export function resolveWaits(waits?: LifecycleWaits): Required<LifecycleWaits> {
  return { unresolvedMs: waits?.unresolvedMs ?? LIFECYCLE_UNRESOLVED_WAIT_MS, bodyMs: waits?.bodyMs ?? LIFECYCLE_BODY_WAIT_MS,
    stepMs: waits?.stepMs ?? LIFECYCLE_WAIT_STEP_MS };
}

/** Looks again while `blocked()` holds, up to `waitMs`; true when it cleared (at once or in time), false when it still blocks. */
export async function waitWhileBlocked(blocked: () => boolean | Promise<boolean>, waitMs: number, stepMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (!await blocked()) return true;
    if (Date.now() >= until) return false;
    await delay(stepMs);
  }
}

/** The last answer of `ask`, asked again every `stepMs` while `blocked` holds for it, up to `waitMs` (the first look is the caller's). */
export async function askWhileBlocked<T>(ask: () => T, blocked: (answer: T) => boolean, waitMs: number, stepMs: number): Promise<T> {
  const until = Date.now() + waitMs;
  for (;;) {
    await delay(stepMs);
    const answer = ask();
    if (!blocked(answer) || Date.now() >= until) return answer;
  }
}
