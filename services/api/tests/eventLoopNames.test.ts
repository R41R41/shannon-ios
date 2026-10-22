import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_LOOP_DELAY, forgetWorkSpans, namedWork, startEventLoopDelayWatch, startEventLoopWatch, WORK_SPAN_MIN_MS, workDuring,
} from '../src/infra/observer/eventLoopWatch.js';
import { fcaDecisionMetrics } from '../src/mind/action/fca/fcaDecisionMetrics.js';
import { FcaWalkTiming } from '../src/mind/action/fca/fcaWalkTiming.js';

/**
 * mb-llmc r8 (production run 32, 2026-10-22: seven blocks of the API's loop, 9.5 s in all; the one of 3.5 s and the one of 2.1 s had no name,
 * the watch saying only that its timer was late): the synchronous work that held the thread is kept by name, and a block says which of it
 * overlapped, in milliseconds; a delay of 100 ms or more is named too, as Node's `monitorEventLoopDelay` measures it.
 */
afterEach(() => { forgetWorkSpans(); vi.useRealTimers(); });
const spin = (milliseconds: number) => { const until = performance.now() + milliseconds; while (performance.now() < until) { /* held */ } };

describe('named work', () => {
  it('keeps the work that lasted, by name and by when it ran; a quick one is not kept', () => {
    const at = performance.now();
    namedWork('quick', () => spin(1));
    namedWork('source_walk_walk', () => spin(WORK_SPAN_MIN_MS + 10));
    const during = workDuring(at - 5, performance.now() + 5);
    expect(during).toMatch(/^source_walk_walk:\d+$/u);
    expect(Number(during.split(':')[1])).toBeGreaterThanOrEqual(WORK_SPAN_MIN_MS);
    expect(during).not.toContain('quick');
    expect(workDuring(at - 5_000, at - 4_000)).toBe('');
  });

  it('counts a name once with its time summed, longest first, at most four; keeps the work\'s result and its throw', () => {
    let now = 100;
    const timed = (name: string, ms: number) => namedWork(name, () => { now += ms; return name; }, () => now);
    expect(timed('a', 30)).toBe('a');
    timed('b', 90);
    timed('a', 50);
    timed('c', 20);
    timed('d', 25);
    timed('e', 60);
    expect(workDuring(0, 1_000)).toBe('b:90,a:80,e:60,d:25');
    expect(workDuring(0, 1_000, 2)).toBe('b:90,a:80');
    // Only the part of a span inside the window counts.
    expect(workDuring(250, 300)).toBe('a:20,c:20,d:10');
    expect(() => namedWork('boom', () => { throw new Error('x'); })).toThrow('x');
  });

  it('is on the source guard\'s parts, the FCA step\'s synchronous parts and the periodic jobs', () => {
    const timing = new FcaWalkTiming(() => performance.now());
    const metrics = fcaDecisionMetrics('task-1', '2026-10-22T00:00:00.000Z', {});
    const at = performance.now();
    timing.time('walk', () => spin(WORK_SPAN_MIN_MS + 5));
    metrics.timedSync('commitMs', () => spin(WORK_SPAN_MIN_MS + 5));
    const during = workDuring(at - 5, performance.now() + 5);
    expect(during).toContain('source_walk_walk:');
    expect(during).toContain('fca_commitMs:');
  });
});

describe('a block names what it overlapped', () => {
  it('the watch of the loop says it after the length, only when named work overlapped it (a fake clock keeps the old line)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    let now = 0;
    const stop = startEventLoopWatch('api', { now: () => now, log: line => lines.push(line) });
    namedWork('source_walk_walk', () => spin(WORK_SPAN_MIN_MS + 1));
    now = 1_000 + 800; await vi.advanceTimersByTimeAsync(1_000);
    stop();
    expect(lines).toEqual(['Shannon event loop blocked process=api ms=800']);
  });

  it('a delay of 100 ms or more is named with the work of the interval, with its p99; a smaller one is not', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    let reading: { maxMs: number; p99Ms: number } | null = { maxMs: 40, p99Ms: 12 };
    const real = performance.now();
    namedWork('observe_native', () => spin(WORK_SPAN_MIN_MS + 5));
    let now = real + 1_000;
    const stop = startEventLoopDelayWatch('api', { now: () => now, log: line => lines.push(line), read: () => reading });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines).toEqual([]);
    reading = { maxMs: 180.4, p99Ms: 60.2 };
    now = real + 900;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Shannon event loop delay process=api max=180 p99=60 during=observe_native:\d+$/u);
    reading = null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines).toHaveLength(1);
    stop();
    expect(EVENT_LOOP_DELAY.thresholdMilliseconds).toBe(100);
  });

  it('with Node\'s own histogram it starts and stops, and names nothing in a quiet loop', async () => {
    const lines: string[] = [];
    const stop = startEventLoopDelayWatch('api', { log: line => lines.push(line), intervalMilliseconds: 20 });
    await new Promise(resolve => setTimeout(resolve, 70));
    stop();
    expect(lines).toEqual([]);
  });
});
