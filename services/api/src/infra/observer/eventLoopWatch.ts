/**
 * A content-free line when this process's event loop was blocked: no timer could fire, so no lease was renewed and no request
 * was answered (2026-10-12: ~100 s inside a voice turn, seen only as unrenewed leases and other services' timeouts).
 * The threshold was 2 s until 2026-10-17; it is lower so that blocks shorter than 2 s are named too and can be compared with the
 * `Shannon FCA source walk` and `Shannon slow tick` lines (production run 14: 204 blocks in 30 min).
 */
export const EVENT_LOOP_WATCH = Object.freeze({ intervalMilliseconds: 1_000, thresholdMilliseconds: 500 });

let blockedTotalMilliseconds = 0;
/**
 * The sum of the blocks this process's watch has named so far (each at least the threshold; shorter ones are not counted), for
 * measurement: the difference of two readings is the blocked time between them (`fca_decision_metrics`). 0 where no watch runs.
 */
export function eventLoopBlockedMilliseconds(): number { return blockedTotalMilliseconds; }

export function startEventLoopWatch(process: string, options: { now?: () => number; log?: (line: string) => void;
  intervalMilliseconds?: number; thresholdMilliseconds?: number } = {}): () => void {
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? (line => console.warn(line));
  const interval = options.intervalMilliseconds ?? EVENT_LOOP_WATCH.intervalMilliseconds;
  const threshold = options.thresholdMilliseconds ?? EVENT_LOOP_WATCH.thresholdMilliseconds;
  let expected = now() + interval;
  const timer = setInterval(() => {
    const at = now(), late = Math.round(at - expected);
    expected = at + interval;
    if (late >= threshold) blockedTotalMilliseconds += late;
    if (late >= threshold) { try { log(`Shannon event loop blocked process=${process} ms=${late}`); } catch { /* never throws */ } }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** What one timer callback may hold the API's one thread before it is named in journald (`timedTick`). */
export const SLOW_TICK_MILLISECONDS = 250;

/**
 * Runs one synchronous timer callback and names it, content-free, when it held the thread longer than `SLOW_TICK_MILLISECONDS`:
 * the event-loop watch above says that the loop was blocked, this says by which periodic job (2026-10-13: 2-3 s every 5 s, seen
 * only as blocks and as Jev calls that timed out inside voice and text turns).
 */
export function timedTick<T>(name: string, work: () => T,
  options: { now?: () => number; log?: (line: string) => void; thresholdMilliseconds?: number } = {}): T {
  const now = options.now ?? (() => performance.now());
  const started = now();
  try { return work(); } finally {
    const spent = Math.round(now() - started);
    if (spent >= (options.thresholdMilliseconds ?? SLOW_TICK_MILLISECONDS)) {
      try { (options.log ?? (line => console.warn(line)))(`Shannon slow tick name=${name} ms=${spent}`); } catch { /* never throws */ }
    }
  }
}
