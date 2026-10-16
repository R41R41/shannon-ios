/**
 * Time slicing of the evidence store's maintenance (`SQLiteFcaEvidenceStore.drain`).
 *
 * The API runs on one thread. Minecraft run 13 (2026-10-17), right after a step was retired: the event loop was blocked nine times,
 * 7.9 to 17.6 s each, for ~1.5 minutes. The store's `flush` ran on every wake tick (1 s), every prepare and every commit, as one
 * synchronous pass over every undelivered outcome and every ended task's held segment, each judged by a walk of the recall graph
 * (a held segment that cannot be shown is asked again, and walked again, at every flush). The work is the same; it is now cut into
 * units (one outcome, one queued appraisal, one segment) with the event loop let through between slices.
 */

/** A slice of units may run this long (ms) before the event loop is let through. One unit is never cut. */
export const FCA_DRAIN_SLICE_MS = 20;
/** A row or segment that could not be shown is not asked again by the sliced pass for this long (ms); the owner's own flush asks at once. */
export const FCA_UNSEEN_RETRY_MS = 10_000;
const UNSEEN_KEPT = 1_024;

/** One turn of the event loop. */
export const nextLoopTurn = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

/** What a sliced run measured: its longest synchronous slice, and how many times it let the loop through. */
export interface FcaDrainMeasure { longestSliceMs: number; yields: number }

/** Runs `units` to the end, letting the event loop through whenever a slice has lasted `sliceMs`; a unit that throws ends the run. */
export async function runSliced(units: Iterator<void>, sliceMs: number = FCA_DRAIN_SLICE_MS): Promise<FcaDrainMeasure> {
  const measure: FcaDrainMeasure = { longestSliceMs: 0, yields: 0 };
  let sliceStarted = performance.now();
  for (;;) {
    const next = units.next();
    const elapsed = performance.now() - sliceStarted;
    measure.longestSliceMs = Math.max(measure.longestSliceMs, elapsed);
    if (next.done) return measure;
    if (elapsed >= sliceMs) {
      await nextLoopTurn();
      measure.yields += 1;
      sliceStarted = performance.now();
    }
  }
}

/** Keys not shown a moment ago (monotonic clock), so that a withheld row is not walked again at every tick. */
export class FcaUnseenBackoff {
  private readonly until = new Map<string, number>();
  constructor(private readonly clock: () => number = () => performance.now(), private readonly retryMs: number = FCA_UNSEEN_RETRY_MS) {}
  skips(key: string): boolean {
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (this.clock() < until) return true;
    this.until.delete(key);
    return false;
  }
  unseen(key: string): void {
    this.until.delete(key);
    if (this.until.size >= UNSEEN_KEPT) this.until.delete(this.until.keys().next().value!);
    this.until.set(key, this.clock() + this.retryMs);
  }
  shown(key: string): void { this.until.delete(key); }
}
