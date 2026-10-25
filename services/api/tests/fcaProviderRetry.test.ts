import { describe, expect, it, vi } from 'vitest';
import { FcaNoDecisionError, FcaNoResponseError } from '../src/mind/action/fca/fcaNoResponse.js';
import type { FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import {
  decideWithRetry, FCA_RETRY_POLICY, FcaDecisionUnavailableError, FcaProviderError, retryableStatus, retryVerdict, retryWaitMs,
  type FcaRetryParts,
} from '../src/mind/action/fca/fcaProviderRetry.js';

/**
 * The retry policy of one FCA decision (Minebot parity audit C-20, 2026-10-19): which failures are asked again, how long each wait is,
 * and where the retries end. Pure: the clock, the random source and the waits are injected.
 */
const output: FcaModelOutput = { decision: { kind: 'wait', summary: 'ok' }, history: [] };
const noWait = (suggested: number) => { waits.push(suggested); return 0; };
let waits: number[] = [];
const parts = (patch: Partial<FcaRetryParts> = {}): FcaRetryParts => {
  waits = [];
  return { signal: new AbortController().signal, recheck: async () => undefined, delay: noWait, random: () => 0.5, ...patch };
};
function script(failures: unknown[]) {
  let calls = 0;
  return { attempt: async () => {
    const next = failures[calls];
    calls += 1;
    if (next !== undefined) throw next;
    return output;
  }, calls: () => calls };
}

describe('which failures are asked again', () => {
  it.each([408, 409, 429, 500, 502, 503, 504, 529])('HTTP %s carries no decision and may pass', status => {
    expect(retryableStatus(status)).toBe(true);
    expect(retryVerdict(new FcaProviderError(status, 2_000))).toEqual({ reason: `http_${status}`, possiblyBilled: false, retryAfterMs: 2_000 });
  });

  it.each([400, 401, 403, 404, 413, 422])('HTTP %s is a refusal that an identical request meets again', status => {
    expect(retryableStatus(status)).toBe(false);
    expect(retryVerdict(new FcaProviderError(status))).toBeNull();
  });

  it('asks again after a request that got no answer, and says whether the provider may have charged it', () => {
    expect(retryVerdict(new FcaNoResponseError())).toEqual({ reason: 'no_response', possiblyBilled: true, retryAfterMs: null });
    expect(retryVerdict(new FcaNoResponseError({ reason: 'timeout', possiblyBilled: true, message: 'FCA_MODEL_ABORTED' }))).toMatchObject({ reason: 'timeout', possiblyBilled: true });
    expect(retryVerdict(new FcaNoResponseError({ possiblyBilled: false }))).toMatchObject({ possiblyBilled: false });
  });

  it('never asks again after anything else: a decoded refusal, an invalid answer, a plain closed code', () => {
    for (const error of [new Error('FCA_MODEL_HTTP_503'), new Error('FCA_MODEL_RESPONSE_UNKNOWN'), new Error('FCA_MODEL_TRUNCATED'), 'x', null]) {
      expect(retryVerdict(error)).toBeNull();
    }
  });
});

describe('the wait between attempts', () => {
  it('doubles from two seconds to the cap, jittered by a quarter either way', () => {
    const middle = [1, 2, 3, 4, 5, 6].map(failed => retryWaitMs(failed, null, FCA_RETRY_POLICY, () => 0.5));
    expect(middle).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(retryWaitMs(3, null, FCA_RETRY_POLICY, () => 0)).toBe(6_000);
    expect(retryWaitMs(3, null, FCA_RETRY_POLICY, () => 1)).toBe(10_000);
    for (const random of [0, 0.25, 0.9999]) expect(retryWaitMs(2, null, FCA_RETRY_POLICY, () => random)).toBeGreaterThanOrEqual(3_000);
  });

  it('is never shorter than the provider\'s retry-after, and never longer than the longest one it waits for', () => {
    expect(retryWaitMs(1, 12_000, FCA_RETRY_POLICY, () => 0.5)).toBe(12_000);
    expect(retryWaitMs(4, 1_000, FCA_RETRY_POLICY, () => 0.5)).toBe(16_000);
    expect(retryWaitMs(1, 60_000, FCA_RETRY_POLICY, () => 0.5)).toBe(60_000);
  });
});

describe('asking for a decision again', () => {
  it('returns the first answer without waiting', async () => {
    const run = script([]);
    expect(await decideWithRetry(run.attempt, parts())).toBe(output);
    expect(run.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('asks again after two server errors and a throttling, waiting the suggested time, and logs each retry without content', async () => {
    const run = script([new FcaProviderError(503), new FcaProviderError(529), new FcaProviderError(429, 9_000)]);
    const log: string[] = [];
    expect(await decideWithRetry(run.attempt, parts({ log: line => log.push(line) }))).toBe(output);
    expect(run.calls()).toBe(4);
    expect(waits).toEqual([2_000, 4_000, 9_000]);
    expect(log).toEqual(['Shannon FCA decision retry reason=http_503 attempt=2/5 waitMs=0', 'Shannon FCA decision retry reason=http_529 attempt=3/5 waitMs=0',
      'Shannon FCA decision retry reason=http_429 attempt=4/5 waitMs=0']);
  });

  it('runs the caller\'s own gate before every further request, and a refusal there ends the decision as it ended before', async () => {
    const run = script([new FcaProviderError(503), new FcaProviderError(503)]);
    const recheck = vi.fn(async () => undefined);
    await decideWithRetry(run.attempt, parts({ recheck }));
    expect(recheck).toHaveBeenCalledTimes(2);
    const held = script([new FcaProviderError(503)]);
    await expect(decideWithRetry(held.attempt, parts({ recheck: async () => { throw new Error('FCA_EXECUTION_HELD'); } }))).rejects.toThrow('FCA_EXECUTION_HELD');
    expect(held.calls()).toBe(1);
  });

  it('passes any other failure through at once, with no wait', async () => {
    const run = script([new Error('FCA_MODEL_TRUNCATED')]);
    await expect(decideWithRetry(run.attempt, parts())).rejects.toThrow('FCA_MODEL_TRUNCATED');
    expect(run.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('gives up after five attempts with the last failure\'s closed code and a count', async () => {
    const run = script(Array(9).fill(new FcaProviderError(529)));
    const log: string[] = [];
    const failure = await decideWithRetry(run.attempt, parts({ log: line => log.push(line) })).catch(error => error as FcaDecisionUnavailableError);
    expect(failure).toBeInstanceOf(FcaDecisionUnavailableError);
    expect(failure).toMatchObject({ message: 'FCA_MODEL_HTTP_529', reason: 'http_529', attempts: 5, possiblyBilled: false });
    expect(run.calls()).toBe(5);
    expect(log.at(-1)).toBe('Shannon FCA decision unavailable reason=http_529 attempts=5');
  });

  it('stops asking once three requests that the provider may have charged have failed, and says so', async () => {
    const run = script(Array(9).fill(new FcaNoResponseError({ reason: 'timeout', possiblyBilled: true, message: 'FCA_MODEL_ABORTED' })));
    const failure = await decideWithRetry(run.attempt, parts()).catch(error => error as FcaDecisionUnavailableError);
    expect(failure).toMatchObject({ message: 'FCA_MODEL_ABORTED', reason: 'timeout', attempts: 3, possiblyBilled: true });
    expect(run.calls()).toBe(3);
    // Failures that never left this machine are not counted against that bound.
    const refused = script(Array(9).fill(new FcaNoResponseError({ possiblyBilled: false })));
    const never = await decideWithRetry(refused.attempt, parts()).catch(error => error as FcaDecisionUnavailableError);
    expect(never).toMatchObject({ attempts: 5, possiblyBilled: false });
  });

  it('stops where the next wait would pass two minutes since the first attempt began', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const slow = async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 60_000)); // each request takes a minute, then fails
        throw new FcaProviderError(503);
      };
      const outcome = decideWithRetry(slow, { signal: new AbortController().signal, recheck: async () => undefined, random: () => 0.5 })
        .catch(error => error as FcaDecisionUnavailableError);
      await vi.advanceTimersByTimeAsync(60_000); // the first fails at 60 s and waits 2 s
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(60_000); // the second fails at 122 s: another wait would pass 120 s
      expect(await outcome).toBeInstanceOf(FcaDecisionUnavailableError);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for a retry-after longer than a minute, and leaves the next round to the step', async () => {
    const run = script([new FcaProviderError(429, 61_000)]);
    const failure = await decideWithRetry(run.attempt, parts()).catch(error => error as FcaDecisionUnavailableError);
    expect(failure).toMatchObject({ message: 'FCA_MODEL_HTTP_429', attempts: 1 });
    expect(run.calls()).toBe(1);
    // The step's own wait afterwards must not be shorter than what the provider asked (L-5, `taskRuntimeUnavailable.ts`).
    expect(failure).toMatchObject({ retryAfterMs: 61_000 });
    const none = script(Array(9).fill(new FcaProviderError(503)));
    expect(await decideWithRetry(none.attempt, parts()).catch(error => error as FcaDecisionUnavailableError)).toMatchObject({ retryAfterMs: null });
  });

  it('asks for the request to be rebuilt before a further attempt once it is ten seconds old, and not before (M-6)', async () => {
    let time = 0;
    const fails = [new FcaProviderError(503), new FcaProviderError(503), new FcaProviderError(503), new FcaProviderError(503)];
    let calls = 0;
    const slow = async () => {
      calls += 1;
      time += 3_000; // every request takes three seconds, then fails
      const next = fails[calls - 1];
      if (next) throw next;
      return output;
    };
    const refresh = vi.fn(async () => undefined);
    const log: string[] = [];
    expect(await decideWithRetry(slow, parts({ now: () => time, refresh, log: line => log.push(line) }))).toBe(output);
    // After the 1st, 2nd and 3rd failure the request is 3, 6 and 9 seconds old; after the 4th, 12: rebuilt once, then sent.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toBe(5);
    expect(log.filter(line => line.includes('request refreshed'))).toHaveLength(1);
  });

  it('runs the gate again after the rebuilding, immediately before the attempt: wait, gate, rebuilding, gate, attempt (M-A)', async () => {
    let time = 0;
    const order: string[] = [];
    let calls = 0;
    const slow = async () => {
      calls += 1;
      order.push(`attempt${calls}`);
      time += 11_000;
      if (calls === 1) throw new FcaProviderError(503);
      return output;
    };
    await decideWithRetry(slow, parts({ now: () => time, delay: () => { order.push('wait'); return 0; },
      recheck: async () => { order.push('gate'); }, refresh: async () => { order.push('rebuild'); } }));
    expect(order).toEqual(['attempt1', 'wait', 'gate', 'rebuild', 'gate', 'attempt2']);
    // A request that is not rebuilt (not old enough) is gated once, as before.
    const young: string[] = [];
    let n = 0;
    await decideWithRetry(async () => { n += 1; young.push(`attempt${n}`); if (n === 1) throw new FcaProviderError(503); return output; },
      parts({ now: () => 0, recheck: async () => { young.push('gate'); }, refresh: async () => { young.push('rebuild'); } }));
    expect(young).toEqual(['attempt1', 'gate', 'attempt2']);
  });

  it('sends nothing when the gate refuses after the rebuilding, and the refusal is the gate\'s own (M-A)', async () => {
    let time = 0, gates = 0, sent = 0;
    const attempt = async () => {
      sent += 1;
      time += 11_000;
      throw new FcaProviderError(503);
    };
    const refusal = decideWithRetry(attempt, parts({ now: () => time, refresh: async () => undefined,
      recheck: async () => { gates += 1; if (gates === 2) throw new Error('FCA_EXECUTION_HELD'); } }));
    await expect(refusal).rejects.toThrow('FCA_EXECUTION_HELD');
    expect(sent).toBe(1); // the second request was never sent
    expect(gates).toBe(2);
  });

  it('treats a stop that arrived while it was deciding to wait as a stop: no wait is taken, no gate is run, nothing is sent', async () => {
    const controller = new AbortController();
    const recheck = vi.fn(async () => undefined);
    const run = script([new FcaProviderError(503), new FcaProviderError(503)]);
    // The stop arrives after the failure was judged retryable and before the wait begins (here: while the wait is being worked out).
    const outcome = decideWithRetry(run.attempt, parts({ signal: controller.signal, recheck, delay: () => { controller.abort(); return 60_000; } }));
    await expect(outcome).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(run.calls()).toBe(1);
    expect(recheck).not.toHaveBeenCalled();
  });

  it('rebuilds a request again when the next one grows old as well, and ends the decision if the rebuilding itself fails', async () => {
    let time = 0;
    const attempt = async () => {
      time += 11_000;
      throw new FcaProviderError(503);
    };
    const refresh = vi.fn(async () => undefined);
    await decideWithRetry(attempt, parts({ now: () => time, refresh, policy: { ...FCA_RETRY_POLICY, maxElapsedMs: 10_000_000 } })).catch(() => undefined);
    expect(refresh).toHaveBeenCalledTimes(4); // five attempts, a rebuilding between each
    const broken = script([new FcaProviderError(503)]);
    let clock = 0;
    const slowFail = async () => {
      clock += 11_000;
      return broken.attempt();
    };
    await expect(decideWithRetry(slowFail, parts({ now: () => clock, refresh: async () => { throw new Error('FCA_BODY_REVISION_UNKNOWN'); } })))
      .rejects.toThrow('FCA_BODY_REVISION_UNKNOWN');
    expect(broken.calls()).toBe(1);
  });

  it('stops when the task\'s budget has no room for another request that may be charged', async () => {
    const run = script(Array(9).fill(new FcaProviderError(503)));
    let room = 2;
    const failure = await decideWithRetry(run.attempt, parts({ afford: () => (room -= 1) >= 0 })).catch(error => error as FcaDecisionUnavailableError);
    expect(failure).toBeInstanceOf(FcaDecisionUnavailableError);
    expect(run.calls()).toBe(3);
  });

  it('marks each failed attempt as one that carried no decision, and ends a wait at once when the step is stopped', async () => {
    const seen: string[] = [];
    const run = script([new FcaProviderError(500), new FcaNoResponseError()]);
    await decideWithRetry(run.attempt, parts({ failed: verdict => seen.push(verdict.reason) }));
    expect(seen).toEqual(['http_500', 'no_response']);

    const controller = new AbortController();
    const stopping = script([new FcaProviderError(503), new FcaProviderError(503)]);
    const waiting = decideWithRetry(stopping.attempt, parts({ signal: controller.signal, delay: () => 60_000 }));
    setTimeout(() => controller.abort(), 5);
    await expect(waiting).rejects.toThrow('FCA_MODEL_ABORTED');
    expect(stopping.calls()).toBe(1);
  });

  it('passes a failure by when the step was already stopped, whatever it was', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = script([new FcaProviderError(503)]);
    await expect(decideWithRetry(run.attempt, parts({ signal: controller.signal }))).rejects.toThrow('FCA_MODEL_HTTP_503');
    expect(run.calls()).toBe(1);
  });
});

describe('an answer that called no tool (production 2026-10-26 04:50, Sonnet 5.5: end_turn, 1 of 16 decisions)', () => {
  it('is asked again once, with the same closed code if it fails again, and is not counted as a charge in doubt', async () => {
    expect(retryVerdict(new FcaNoDecisionError())).toEqual({ reason: 'no_decision', possiblyBilled: false, retryAfterMs: null, attempts: 2 });
    const again = script([new FcaNoDecisionError()]);
    const log: string[] = [];
    expect(await decideWithRetry(again.attempt, parts({ log: line => log.push(line) }))).toBe(output);
    expect(again.calls()).toBe(2);
    expect(log).toEqual(['Shannon FCA decision retry reason=no_decision attempt=2/2 waitMs=0']);
    const same = script(Array(5).fill(new FcaNoDecisionError()));
    const failure = await decideWithRetry(same.attempt, parts()).catch(error => error as FcaDecisionUnavailableError);
    expect(failure).toBeInstanceOf(FcaDecisionUnavailableError);
    expect(failure).toMatchObject({ message: 'FCA_MODEL_DECISION_MISSING', reason: 'no_decision', attempts: 2, possiblyBilled: false });
    expect(same.calls()).toBe(2);
  });

  it('counts its requests with the others of the decision: a miss after a provider failure is not asked a third time', async () => {
    const mixed = script([new FcaNoDecisionError(), new FcaProviderError(503), new FcaNoDecisionError()]);
    const failure = await decideWithRetry(mixed.attempt, parts()).catch(error => error as FcaDecisionUnavailableError);
    expect(failure).toMatchObject({ message: 'FCA_MODEL_DECISION_MISSING', reason: 'no_decision', attempts: 3 });
    expect(mixed.calls()).toBe(3);
  });
});
