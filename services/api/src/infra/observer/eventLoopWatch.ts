import { monitorEventLoopDelay } from 'node:perf_hooks';

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

/**
 * The synchronous work that held this process's thread, by name (mb-llmc r8; run 32: of seven blocks (9.5 s) one of 3.5 s and one of 2.1 s
 * had no name, the watch saying only that the loop was late, after the fact). A piece of synchronous work run through `namedWork` (the
 * source guard's parts, the FCA step's synchronous parts, the observed synchronous spans, the periodic jobs) that lasts `WORK_SPAN_MIN_MS`
 * or more is kept in a small ring with its start and end; a block that is named afterwards says which of them it overlapped, by name and
 * milliseconds (`during=`). A block with no `during=` was held by nothing that is named: a collection (`Shannon gc pause`), or work not yet
 * named, which is then the next one to name. Asynchronous waits are not work and are not kept; only the slices of code between them are.
 */
export const WORK_SPAN_MIN_MS = 15;
const WORK_SPANS_KEPT = 128;
interface WorkSpan { name: string; start: number; end: number }
const workSpans: WorkSpan[] = [];

/** Runs `work` and keeps its span when it lasted `WORK_SPAN_MIN_MS` or more (`clock`: for tests). */
export function namedWork<T>(name: string, work: () => T, clock: () => number = () => performance.now()): T {
  const start = clock();
  try { return work(); } finally {
    const end = clock();
    if (end - start >= WORK_SPAN_MIN_MS) {
      workSpans.push({ name, start, end });
      if (workSpans.length > WORK_SPANS_KEPT) workSpans.splice(0, workSpans.length - WORK_SPANS_KEPT);
    }
  }
}

/** The named work that overlapped `[from, to]`, longest overlap first: `name:ms,name:ms` (at most `limit`), or '' when none did. */
export function workDuring(from: number, to: number, limit = 4): string {
  const overlaps = new Map<string, number>();
  for (const span of workSpans) {
    const ms = Math.min(span.end, to) - Math.max(span.start, from);
    if (ms >= WORK_SPAN_MIN_MS / 2) overlaps.set(span.name, (overlaps.get(span.name) ?? 0) + ms);
  }
  return [...overlaps].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([name, ms]) => `${name}:${Math.round(ms)}`).join(',');
}
/** For tests: no span is kept. */
export function forgetWorkSpans(): void { workSpans.length = 0; }

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
    // The block is the time the timer was late: the work named inside `[at - late, at]` held it (the clock is the work spans' own: `performance.now`).
    const during = late >= threshold && !options.now ? workDuring(at - late, at) : '';
    if (late >= threshold) {
      try { log(`Shannon event loop blocked process=${process} ms=${late}${during ? ` during=${during}` : ''}`); } catch { /* never throws */ }
    }
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * A delay of the loop shorter than the watch above sees (`EVENT_LOOP_WATCH`: its timer is late by a block only when a block covers its
 * due time, and it names from half a second), measured as Node's `monitorEventLoopDelay` does, at `resolutionMilliseconds`: each interval
 * its longest delay and its p99 are read; a longest delay of `thresholdMilliseconds` or more is named with the work that overlapped the interval.
 */
export const EVENT_LOOP_DELAY = Object.freeze({ intervalMilliseconds: 1_000, thresholdMilliseconds: 100, resolutionMilliseconds: 10 });
export interface DelayReading { maxMs: number; p99Ms: number }
export function startEventLoopDelayWatch(process: string, options: { log?: (line: string) => void; now?: () => number; intervalMilliseconds?: number;
  thresholdMilliseconds?: number; read?: () => DelayReading | null } = {}): () => void {
  const log = options.log ?? (line => console.warn(line)), now = options.now ?? (() => performance.now());
  const interval = options.intervalMilliseconds ?? EVENT_LOOP_DELAY.intervalMilliseconds;
  const threshold = options.thresholdMilliseconds ?? EVENT_LOOP_DELAY.thresholdMilliseconds;
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  if (!options.read) {
    try {
      histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY.resolutionMilliseconds });
      histogram.enable();
    } catch { histogram = null; }
  }
  const read = options.read ?? (() => {
    if (!histogram) return null;
    const reading = { maxMs: histogram.max / 1e6, p99Ms: histogram.percentile(99) / 1e6 };
    histogram.reset();
    return reading;
  });
  const timer = setInterval(() => {
    const at = now(), reading = read();
    if (!reading || !Number.isFinite(reading.maxMs) || reading.maxMs < threshold) return;
    const during = workDuring(at - interval, at);
    const line = `Shannon event loop delay process=${process} max=${Math.round(reading.maxMs)} p99=${Math.round(reading.p99Ms)}`;
    try { log(`${line}${during ? ` during=${during}` : ''}`); } catch { /* never throws */ }
  }, interval);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    histogram?.disable();
  };
}

/** A collection pause at least this long is named (`startGcWatch`). */
export const GC_WATCH = Object.freeze({ thresholdMilliseconds: 100 });
type GcEntry = { duration: number; detail?: unknown; kind?: unknown };
const GC_KINDS: Readonly<Record<number, string>> = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb' };
/**
 * A content-free line when a garbage collection held this process's thread (mb-llmc r7, 2026-10-22: of the API's blocks in run 31, the
 * three at 10:51:55–52:00 were the body recall's first pool, `bodyTaskRecall.ts`; the ones at 10:51:13 and 10:51:37, during a model's
 * wait with no recall, no source walk and no slow tick, had no name: a collection is the likeliest, now said when it is one). `observe`:
 * for tests, the entries' source (default: `node:perf_hooks` gc entries).
 */
export function startGcWatch(process: string, options: { log?: (line: string) => void; thresholdMilliseconds?: number;
  heapMb?: () => number; observe?: (each: (entry: GcEntry) => void) => () => void } = {}): () => void {
  const log = options.log ?? (line => console.warn(line));
  const threshold = options.thresholdMilliseconds ?? GC_WATCH.thresholdMilliseconds;
  const heapMb = options.heapMb ?? (() => Math.round(globalThis.process.memoryUsage().heapUsed / 1_048_576));
  const each = (entry: GcEntry) => {
    if (!(entry.duration >= threshold)) return;
    const kind = Number((entry.detail as { kind?: unknown } | undefined)?.kind ?? entry.kind);
    const line = `Shannon gc pause process=${process} kind=${GC_KINDS[kind] ?? 'other'} ms=${Math.round(entry.duration)} heapMb=${heapMb()}`;
    try { log(line); } catch { /* never throws */ }
  };
  if (options.observe) return options.observe(each);
  try {
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) each(entry as unknown as GcEntry); });
    observer.observe({ entryTypes: ['gc'] });
    return () => observer.disconnect();
  } catch { return () => undefined; }
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
  try { return namedWork(`tick_${name}`, work); } finally {
    const spent = Math.round(now() - started);
    if (spent >= (options.thresholdMilliseconds ?? SLOW_TICK_MILLISECONDS)) {
      try { (options.log ?? (line => console.warn(line)))(`Shannon slow tick name=${name} ms=${spent}`); } catch { /* never throws */ }
    }
  }
}
