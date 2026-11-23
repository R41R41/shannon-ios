import { describe, expect, it, vi } from 'vitest';
import { decideInterruptibly, FCA_INTERRUPT } from '../src/mind/action/fca/fcaUrgentDecision.js';
import type { FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';

/** 11/24: the first request is kept running when the second is asked, and its answer is the decision when it comes back first and can be used. */
const out = (name: string): FcaModelOutput => ({ decision: { kind: 'tools', calls: [{ id: name, name, input: {} }] } } as unknown as FcaModelOutput);
const request = { transient: {} } as unknown as FcaModelInput;
const later = <T>(ms: number, value: T, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(value), ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const names = (output: FcaModelOutput): string[] => (output.decision as unknown as { calls: Array<{ name: string }> }).calls.map(call => call.name);

describe('an interrupted decision (fcaUrgentDecision)', () => {
  const run = async (firstMs: number, secondMs: number, usable: boolean | undefined) => {
    let asks = 0, polls = 0;
    const decided = vi.fn(), interrupted = vi.fn();
    const result = await decideInterruptibly({
      body: { interrupt: () => (++polls === 2 ? '急ぎ: zombie' : null), decided }, signal: new AbortController().signal, request,
      ask: (_asked, signal) => { asks += 1; return asks === 1 ? later(firstMs, out('first'), signal) : later(secondMs, out('second'), signal); },
      again: async asked => asked, interrupted, pollMs: 5, ...(usable === undefined ? {} : { usable: () => usable }) });
    return { result, decided, interrupted, asks };
  };
  it('uses the first answer when it comes back first and can be used', async () => {
    const { result, decided, interrupted } = await run(60, 400, true);
    expect(names(result)).toEqual(['first']);
    expect(decided).toHaveBeenCalledWith(expect.objectContaining({ aborted: false, thrownMs: 0 }));
    expect(interrupted).not.toHaveBeenCalled();
  });
  it('uses the second when the first cannot be used, when no way to tell is given, or when the second comes first', async () => {
    expect(names((await run(60, 150, false)).result)).toEqual(['second']);
    expect(names((await run(60, 150, undefined)).result)).toEqual(['second']);
    expect(names((await run(300, 40, true)).result)).toEqual(['second']);
  });
  it('does not keep a first answer that comes back later than keepMs after the interrupt', async () => {
    const { result } = await run(FCA_INTERRUPT.keepMs + 300, FCA_INTERRUPT.keepMs + 600, true);
    expect(names(result)).toEqual(['second']);
  }, 15_000);
});
