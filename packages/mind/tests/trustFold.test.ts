import { describe, expect, it } from 'vitest';
import { TRUST_KINDS, TRUST_PARAMETERS, trustFold, trustSettlements, validTrustParameters, type TrustEntry, type TrustParameters } from '../src/index.js';

/** A parameter set for the shape only: no number of it is decided (owner approval), and none is used by the service. */
const SHAPE: TrustParameters = {
  initial: 0.5, step: { promise_kept: 0.03, promise_broken: -0.15, owner_confirmed: 0.02, owner_corrected: -0.05 },
  maximumLoss: -0.2, maximumGain: 0.05, floorRatio: 0.5,
};
const entry = (kind: TrustEntry['kind'], conversationId: string, minute: number): TrustEntry => ({ kind, conversationId, at: new Date(Date.UTC(2026, 9, 7, 3, minute)).toISOString() });

describe('the trust fold (structure only)', () => {
  it('is inert: its parameters are unset, so it answers null whatever the entries', () => {
    expect(TRUST_PARAMETERS).toBeNull();
    expect(trustFold([])).toBeNull();
    expect(trustFold([entry('promise_kept', 'c1', 0), entry('promise_broken', 'c2', 1)])).toBeNull();
    expect(TRUST_KINDS).toEqual(['promise_kept', 'promise_broken', 'owner_confirmed', 'owner_corrected']);
  });

  it('settles once per conversation, in time order, and drops unknown kinds', () => {
    const settlements = trustSettlements([entry('promise_kept', 'c2', 5), entry('owner_confirmed', 'c1', 1), entry('promise_broken', 'c1', 3), { kind: 'flattered' as never, conversationId: 'c3', at: '2026-10-07T03:00:00.000Z' }]);
    expect(settlements.map(item => [item.conversationId, item.kinds])).toEqual([['c1', ['owner_confirmed', 'promise_broken']], ['c2', ['promise_kept']]]);
  });

  it('with a parameter set: loses easily, gains hard, clamps a conversation, and keeps a floor under its highest value', () => {
    expect(validTrustParameters(SHAPE)).toBe(true);
    expect(trustFold([], SHAPE)).toBe(0.5);
    // Three promises kept in one conversation gain at most 0.05.
    expect(trustFold([entry('promise_kept', 'c1', 0), entry('promise_kept', 'c1', 1), entry('promise_kept', 'c1', 2)], SHAPE)).toBeCloseTo(0.55);
    // The same three in three conversations gain three times.
    expect(trustFold([entry('promise_kept', 'c1', 0), entry('promise_kept', 'c2', 1), entry('promise_kept', 'c3', 2)], SHAPE)).toBeCloseTo(0.59);
    // A broken promise costs more than a kept one gives.
    expect(trustFold([entry('promise_broken', 'c1', 0)], SHAPE)).toBeCloseTo(0.35);
    // Many losses stop at half of the highest value reached.
    const losses = Array.from({ length: 10 }, (_, index) => entry('promise_broken', `c${index}`, index));
    expect(trustFold(losses, SHAPE)).toBeCloseTo(0.25);
  });

  it('refuses a malformed parameter set, so a mistake cannot move anything', () => {
    for (const bad of [{ ...SHAPE, maximumGain: 0.3 }, { ...SHAPE, maximumLoss: 0.1 }, { ...SHAPE, floorRatio: 1 }, { ...SHAPE, initial: 2 }, { ...SHAPE, initial: Number.NaN },
      { ...SHAPE, step: { promise_kept: 0.1 } as TrustParameters['step'] }]) {
      expect(validTrustParameters(bad)).toBe(false);
      expect(trustFold([entry('promise_kept', 'c1', 0)], bad)).toBeNull();
    }
  });
});
