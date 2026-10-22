/**
 * Work that can give the API's one thread back between its steps (2026-10-22, production run 31: the body recall's first pool held the
 * thread 2,448 + 1,318 + 1,428 ms, its source check 862 ms of it). A generator: each `yield` is a point where nothing is half done, and
 * what runs between two of them is a few rows or one remembered turn's verdict. `whole` runs it at once (what the synchronous calls
 * were and are); `inTurns` gives the loop back at those points once a turn has run `sliceMs`, so other requests and the body's frames
 * get through. The steps compute what the whole run computes, in the same order: a caller that runs them in turns changes only when.
 */
export type Steps<T> = Generator<void, T, undefined>;

/** All the steps at once, as the synchronous call. */
export function whole<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** The longest turn of the loop the work held, and how many it took (content-free, for the decision's measure). */
export interface TurnsMeasure { longestMs: number; turns: number }

/**
 * How long one turn of the loop runs before the work gives it back. A step is a few milliseconds at most on a desktop (a remembered
 * turn's verdict, a page of rows), so a turn stays under 50 ms on the VM too, where the same code runs several times slower.
 */
export const STEP_SLICE_MS = 10;

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * The steps, with the loop given back whenever one turn has run `sliceMs` (and before the first: the caller's own turn may be long
 * already). `signal`: an abort is seen at each give-back, and the steps are closed (`return`), so that what they hold is let go.
 */
export async function inTurns<T>(steps: Steps<T>, options: { clock?: () => number; sliceMs?: number; signal?: AbortSignal;
  measure?: TurnsMeasure } = {}): Promise<T> {
  const clock = options.clock ?? (() => performance.now()), slice = options.sliceMs ?? STEP_SLICE_MS;
  try {
    await turn();
    options.signal?.throwIfAborted();
    let began = clock();
    for (;;) {
      const step = steps.next();
      const now = clock();
      if (options.measure) options.measure.longestMs = Math.max(options.measure.longestMs, Math.round(now - began));
      if (step.done) return step.value;
      if (now - began < slice) continue;
      if (options.measure) options.measure.turns += 1;
      await turn();
      options.signal?.throwIfAborted();
      began = clock();
    }
  } finally {
    steps.return(undefined as never);
  }
}
