/**
 * A content-free line when this process's event loop was blocked: no timer could fire, so no lease was renewed and no request
 * was answered (2026-10-12: ~100 s inside a voice turn, seen only as unrenewed leases and other services' timeouts).
 */
export const EVENT_LOOP_WATCH = Object.freeze({ intervalMilliseconds: 1_000, thresholdMilliseconds: 2_000 });

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
    if (late >= threshold) { try { log(`Shannon event loop blocked process=${process} ms=${late}`); } catch { /* never throws */ } }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}
