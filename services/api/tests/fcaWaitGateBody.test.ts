import { describe, expect, it } from 'vitest';
import { FCA_WAIT_REFUSALS, fcaWaitGate } from '../src/mind/action/fca/fcaWaitGate.js';

/** The isolated lab of 11/3: five of seven runs stopped on `wait_without_counterpart` when the head, with nothing to send, waited three times. */
const step = { scopeKey: 'owner', taskId: 't' } as never;
const runtime = { get: () => ({ childIds: [] as string[] }) } as never;

describe('the wait gate of a body task', () => {
  it('turns the wait away again after the refusals, and never stops it', () => {
    const gate = fcaWaitGate(step, runtime, () => false, { fcaWaitRefusals: FCA_WAIT_REFUSALS });
    expect(gate.apply('wait', true)).toEqual({ disposition: 'continue', refusedWaits: FCA_WAIT_REFUSALS, stop: false });
  });
  it('still counts the first refusals, and a task that is not a body task is stopped after them as before', () => {
    expect(fcaWaitGate(step, runtime, () => false, {}).apply('wait', true)).toEqual({ disposition: 'continue', refusedWaits: 1, stop: false });
    expect(fcaWaitGate(step, runtime, () => false, { fcaWaitRefusals: FCA_WAIT_REFUSALS }).apply('wait')).toEqual({ disposition: 'wait', refusedWaits: FCA_WAIT_REFUSALS, stop: true });
    expect(fcaWaitGate(step, runtime, () => true, { fcaWaitRefusals: FCA_WAIT_REFUSALS }).apply('wait', true).disposition).toBe('wait');
  });
});
