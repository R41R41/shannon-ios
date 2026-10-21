/** How old a lease grant may be reused between checks of a step by default (`FCA_PERMIT_REUSE_MS` of `fcaRunnerWords.ts`). */
export const FCA_PERMIT_REUSE_DEFAULT_MS = 250;

/**
 * Whether a check of a step asks the lease now: `fresh` always and `reuse` past 250 ms by default. With a step's window (design
 * mb-llm-centric 2.3, a step's fixed cost of 0.5 s at most: `FcaStepPorts.permitWindowMs`) both only past it: the lease is the step's,
 * a body tool asks it with its own resource, and the commit checks it in its transaction. `local` never.
 */
export function permitDue(mode: 'fresh' | 'reuse' | 'local', sinceMs: number, windowMs?: number): boolean {
  if (mode === 'local') return false;
  if (windowMs !== undefined) return sinceMs > windowMs;
  return mode === 'fresh' || sinceMs > FCA_PERMIT_REUSE_DEFAULT_MS;
}
