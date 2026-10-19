import { afterEach, describe, expect, it, vi } from 'vitest';
import { FcaDecisionUnavailableError } from '../src/mind/action/fca/fcaProviderRetry.js';
import {
  settleUnavailableStep, sleep, UNAVAILABLE_WAIT_CAP_MS, unavailableCooldownMs, unavailableWaitMs, type UnavailableParts,
} from '../src/wiring/taskRuntimeUnavailable.js';

/**
 * The rounds after a decision that never came back (Minebot parity audit C-20, 2026-10-19), and two things found in review: a wait does
 * not begin for a step that was already stopped (L-1: it held the lease for up to 144 s), and the provider's own `retry-after` is
 * respected between rounds (L-5: one above a minute ended the round and the next one asked again about twenty seconds later).
 */
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(options: { body?: boolean; cooldown?: number; phase?: string } = {}) {
  const commits: unknown[] = [];
  const parts: UnavailableParts = {
    runtime: { get: () => ({ phase: options.phase ?? 'executing' }), commitStep: (_step: unknown, commit: unknown) => { commits.push(commit); return {}; },
      stop: () => [] } as never,
    scopeKey: 'owner', isBodyTask: () => options.body ?? true, otherCooldownMs: () => options.cooldown ?? 4_000,
    bodyCooldownMs: () => options.cooldown ?? 20_000, fail: () => true, note: () => undefined, log: () => undefined,
  };
  const step = { id: 's1', taskId: 'task-1', scopeKey: 'owner', snapshot: { checkpoint: null } } as never;
  const execution = (signal: AbortSignal) => ({ signal, stepOutcome: undefined }) as never;
  return { parts, step, commits, execution };
}
const unavailable = (retryAfterMs: number | null = null) => new FcaDecisionUnavailableError('FCA_MODEL_HTTP_429', 'http_429', 5, false, retryAfterMs);

describe('a wait does not begin for a step that was stopped already (L-1)', () => {
  it('resolves false at once for an aborted signal, whatever the time asked', async () => {
    const controller = new AbortController();
    controller.abort();
    const begun = Date.now();
    expect(await sleep(144_000, controller.signal)).toBe(false);
    expect(Date.now() - begun).toBeLessThan(1_000);
  });

  it('still waits the time for a live signal, and ends the wait at once when the signal aborts meanwhile', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settled: boolean | null = null;
    void sleep(5_000, controller.signal).then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const aborted = new AbortController();
    let second: boolean | null = null;
    void sleep(60_000, aborted.signal).then(value => { second = value; });
    aborted.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(false);
  });

  it('leaves a step whose signal was aborted before the round to its caller: no wait, nothing committed', async () => {
    const f = fixture({ cooldown: 120_000 });
    const controller = new AbortController();
    controller.abort();
    const begun = Date.now();
    expect(await settleUnavailableStep(f.parts, f.step, unavailable(), f.execution(controller.signal))).toBeNull();
    expect(Date.now() - begun).toBeLessThan(1_000); // before: the 120 s cooldown was waited out first
    expect(f.commits).toEqual([]);
  });
});

describe('the provider\'s retry-after is respected between rounds (L-5)', () => {
  it('waits at least as long as the retry-after that ended the retries, then continues', async () => {
    vi.useFakeTimers();
    const f = fixture({ cooldown: 20_000 });
    const controller = new AbortController();
    let outcome: string | null | undefined;
    void settleUnavailableStep(f.parts, f.step, unavailable(90_000), f.execution(controller.signal)).then(value => { outcome = value; });
    await vi.advanceTimersByTimeAsync(20_000); // the round's own cooldown: not enough
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(69_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('continued');
    expect(f.commits).toHaveLength(1);
  });

  it('keeps the round\'s own cooldown when the provider asked for less, and never waits past the cap', () => {
    expect(unavailableWaitMs(20_000, null)).toBe(20_000);
    expect(unavailableWaitMs(20_000, 5_000)).toBe(20_000);
    expect(unavailableWaitMs(20_000, 61_000)).toBe(61_000);
    expect(unavailableWaitMs(20_000, 600_000)).toBe(UNAVAILABLE_WAIT_CAP_MS);
    expect(unavailableWaitMs(unavailableCooldownMs(3, () => 1), null)).toBeLessThanOrEqual(UNAVAILABLE_WAIT_CAP_MS);
  });

  it('applies to a task that is not a Minecraft request as well', async () => {
    vi.useFakeTimers();
    const f = fixture({ body: false, cooldown: 4_000 });
    let outcome: string | null | undefined;
    void settleUnavailableStep(f.parts, f.step, unavailable(30_000), f.execution(new AbortController().signal)).then(value => { outcome = value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('continued');
  });
});
