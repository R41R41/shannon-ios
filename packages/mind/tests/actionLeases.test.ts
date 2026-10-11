import { describe, expect, it } from 'vitest';
import {
  LEASE_RULES, classifyLease, leaseAttemptKnown, leaseLive, leaseOutcome, leaseUnsent, unsentLeaseExpiry, type LeaseFacts,
} from '../src/index.js';

const at = '2026-10-12T10:00:00.000Z';
const lease = { id: 'a1', generation: 2, holder: 'h1' };
const running: LeaseFacts = {
  state: 'running', generation: 2, holder: 'h1', lastHolder: 'h1', leaseUntil: '2026-10-12T10:00:30.000Z', deadline: null, sent: false, result: null,
};

describe('one lease judgement (ADR-0009 stage 1, S1)', () => {
  it('holds a lease only for its own attempt, in a state of the rule, before its time', () => {
    expect(leaseLive(running, lease, at, LEASE_RULES.step)).toBe(true);
    expect(leaseLive({ ...running, generation: 3 }, lease, at, LEASE_RULES.step)).toBe(false);
    expect(leaseLive({ ...running, holder: 'h2' }, lease, at, LEASE_RULES.step)).toBe(false);
    expect(leaseLive({ ...running, state: 'waiting' }, lease, at, LEASE_RULES.step)).toBe(false);
    expect(leaseLive({ ...running, state: 'waiting' }, lease, at, LEASE_RULES.store)).toBe(true);
    expect(leaseLive({ ...running, state: 'stopping' }, lease, at, LEASE_RULES.live)).toBe(true);
    expect(leaseLive({ ...running, leaseUntil: at }, lease, at, LEASE_RULES.store)).toBe(false);
    expect(leaseLive({ ...running, leaseUntil: null }, lease, at, LEASE_RULES.live)).toBe(false);
  });

  it('keeps the two time comparisons apart: parsed instants and ISO text', () => {
    const withoutMilliseconds = { ...running, leaseUntil: '2026-10-12T10:00:00Z' };
    expect(leaseLive(withoutMilliseconds, lease, at, LEASE_RULES.store)).toBe(false);
    expect(leaseLive(withoutMilliseconds, lease, at, LEASE_RULES.step)).toBe(true);
    const offsetDeadline = { ...running, deadline: '2026-10-12T18:59:00+09:00' };
    expect(leaseLive(offsetDeadline, lease, at, LEASE_RULES.store)).toBe(false);
    expect(leaseLive(offsetDeadline, lease, at, LEASE_RULES.lifecycle)).toBe(true);
    expect(leaseLive(offsetDeadline, lease, at, LEASE_RULES.step)).toBe(true);
  });

  it('classifies a lease for recovery in the order the FCA runtime asks', () => {
    const expired = { ...running, state: 'cancelled' as const, generation: 3, holder: null, leaseUntil: null, result: 'lease_expired' };
    expect(classifyLease(expired, lease, at)).toBe('expired_unsent');
    expect(classifyLease({ ...expired, sent: true }, lease, at)).toBe('superseded');
    const acknowledged = { ...running, state: 'cancelled' as const, holder: null, result: 'fca_stop_acknowledged' };
    expect(classifyLease(acknowledged, lease, at)).toBe('stop_acknowledged');
    expect(classifyLease(running, lease, at)).toBe('live');
    expect(classifyLease({ ...running, state: 'completed' }, lease, at)).toBe('closed_unsent');
    expect(classifyLease({ ...running, state: 'unknown', sent: true }, lease, at)).toBe('unknown');
    expect(classifyLease(null, lease, at)).toBe('missing');
    expect(['missing', 'superseded', 'unknown'].map(standing => leaseOutcome(standing as never))).toEqual(['unknown', 'unknown', 'unknown']);
    expect(['expired_unsent', 'stop_acknowledged', 'closed_unsent'].map(standing => leaseOutcome(standing as never))).toEqual(['safe', 'safe', 'safe']);
  });

  it('knows this attempt, the one just before it, an unsent attempt and an expiry that dispatched nothing', () => {
    expect(leaseAttemptKnown({ ...running, holder: null }, lease)).toBe(true);
    expect(leaseAttemptKnown({ ...running, generation: 3, holder: 'h9' }, lease)).toBe(true);
    expect(leaseAttemptKnown({ ...running, generation: 4 }, lease)).toBe(false);
    expect(leaseUnsent(running, lease)).toBe(true);
    expect(leaseUnsent({ ...running, sent: true }, lease)).toBe(false);
    const expiry = { ...running, state: 'cancelled' as const, generation: 3, holder: null, leaseUntil: null, result: 'lease_expired' };
    expect(unsentLeaseExpiry(expiry)).toBe(true);
    expect(unsentLeaseExpiry({ ...expiry, lastHolder: '' })).toBe(false);
    expect(unsentLeaseExpiry({ ...expiry, generation: 1 })).toBe(false);
  });
});
