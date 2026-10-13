import { afterEach, describe, expect, it, vi } from 'vitest';
import { JEV_STALL_GRACE_MILLISECONDS, JevChoiceClient, stallTolerantTimeout } from '../src/infra/models/jev/jevChoice.js';

/**
 * 2026-10-13: both Jev calls of a voice turn "timed out" together at 1.2 s and 1.4 s (timeout 0.9 s) while Jev answered in
 * 0.2-0.4 s: the API's one thread was blocked, and the late timer won against the answer already waiting to be read.
 */
afterEach(() => { vi.useRealTimers(); });

describe('Jev timeout after a blocked thread', () => {
  it('times out on time when the timer fires on time', async () => {
    vi.useFakeTimers();
    let now = 0;
    const timeout = stallTolerantTimeout(900, () => now);
    now = 900; await vi.advanceTimersByTimeAsync(900);
    expect(timeout.signal.aborted).toBe(true);
    expect((timeout.signal.reason as DOMException).name).toBe('TimeoutError');
  });

  it('gives a call whose timer fired late one short grace, then times out', async () => {
    vi.useFakeTimers();
    let now = 0;
    const timeout = stallTolerantTimeout(900, () => now);
    now = 1_400; await vi.advanceTimersByTimeAsync(900); // The thread was blocked: the timer runs 500 ms late.
    expect(timeout.signal.aborted).toBe(false);
    now += JEV_STALL_GRACE_MILLISECONDS; await vi.advanceTimersByTimeAsync(JEV_STALL_GRACE_MILLISECONDS);
    expect(timeout.signal.aborted).toBe(true);
  });

  it('reads an answer that was waiting when the late timer fired', async () => {
    let release!: () => void;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>(resolve => { release = resolve; });
      init?.signal?.throwIfAborted();
      return Response.json({ answers: { a: { choice: 'x' } } });
    }) as typeof fetch;
    const client = new JevChoiceClient({ apiKey: 'test-only', fetcher, timeoutMilliseconds: 20 });
    const asked = client.ask({}, { a: { type: 'choice' } });
    const blockedUntil = performance.now() + 150; while (performance.now() < blockedUntil) { /* the thread is busy */ }
    setImmediate(() => release()); // The answer arrived during the block; it is read right after the timers run.
    await expect(asked).resolves.toEqual({ answers: { a: { choice: 'x' } } });
  });
});
