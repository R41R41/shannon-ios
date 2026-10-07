import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_DECAY_V1, belowZeroSince, decayTransitions, evidenceNet, evidenceState, evidenceSums, evidenceUsable, type Evidence,
} from '../src/index.js';

const AT = '2026-10-07T03:00:00.000Z';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.parse(AT) - days * DAY).toISOString();
const at = (days: number) => new Date(Date.parse(AT) + days * DAY).toISOString();
const e = (kind: Evidence['kind'], daysAgo: number): Evidence => ({ kind, at: ago(daysAgo) });

describe('two-clock evidence decay (owner answer 4)', () => {
  it('has the half-lives, weights and lines of the plan', () => {
    expect(EVIDENCE_DECAY_V1).toMatchObject({ supportHalfLifeDays: 30, contraHalfLifeDays: 180, usableAt: 1, promotedAt: 2, retireAt: -2, putAwayAfterDays: 14 });
    expect(EVIDENCE_DECAY_V1.weights).toEqual({ owner_confirmed: 1, turn_support: 0.5, owner_denied: 1, ignored: 0.2 });
  });

  it('halves support every 30 days and contradiction every 180', () => {
    expect(evidenceSums([e('owner_confirmed', 30)], AT).support).toBeCloseTo(0.5);
    expect(evidenceSums([e('turn_support', 60)], AT).support).toBeCloseTo(0.125);
    expect(evidenceSums([e('owner_denied', 180)], AT).contra).toBeCloseTo(0.5);
    expect(evidenceSums([e('ignored', 0)], AT).contra).toBeCloseTo(0.2);
    expect(evidenceNet([e('owner_confirmed', 0), e('owner_denied', 0)], AT)).toBeCloseTo(0);
    // Evidence after `at` does not count yet; an unknown kind never does.
    expect(evidenceNet([e('owner_confirmed', -1)], AT)).toBe(0);
    expect(evidenceNet([{ kind: 'gossip' as never, at: AT }], AT)).toBe(0);
  });

  it('names the state by the net: usable at 1, promoted at 2, a retirement candidate at −2', () => {
    expect(evidenceState([], AT).status).toBe('unconfirmed');
    expect(evidenceState([e('owner_confirmed', 0)], AT).status).toBe('usable');
    expect(evidenceState([e('owner_confirmed', 0), e('owner_confirmed', 0)], AT).status).toBe('promoted');
    expect(evidenceState([e('owner_denied', 0), e('owner_denied', 0)], AT).status).toBe('retire_candidate');
    expect(evidenceUsable(evidenceState([e('owner_confirmed', 0)], AT))).toBe(true);
    expect(evidenceUsable(evidenceState([e('turn_support', 0)], AT))).toBe(false);
  });

  it('keeps the rule that something said once is not used: one turn is 0.5, two fresh turns reach the line', () => {
    expect(evidenceState([e('turn_support', 0)], AT).status).toBe('unconfirmed');
    expect(evidenceState([e('turn_support', 0), e('turn_support', 0)], AT).status).toBe('usable');
    // Two turns a month apart: the older counts half, so not yet.
    expect(evidenceState([e('turn_support', 30), e('turn_support', 0)], AT).status).toBe('unconfirmed');
  });

  it('lets an old support fade below an old contradiction: the contradiction outlasts it', () => {
    const items = [e('owner_confirmed', 0), e('ignored', 0), e('ignored', 0)];
    expect(evidenceNet(items, AT)).toBeCloseTo(0.6);
    // A year later the support is almost gone and the contradictions are not.
    expect(evidenceNet(items, at(365))).toBeLessThan(0);
  });

  it('finds since when the net has been below 0 without a break, crossing between evidence exactly', () => {
    expect(belowZeroSince([e('ignored', 3)], AT)).toBe(ago(3));
    expect(belowZeroSince([e('owner_confirmed', 0)], AT)).toBeNull();
    // Support 1 and contra 0.2 at the same time: net(t) = 2^(−t/30) − 0.2·2^(−t/180) crosses 0 at t = log2(5)/(1/30 − 1/180) days.
    const items = [e('owner_confirmed', 200), e('ignored', 200)];
    const crossingDays = Math.log2(5) / (1 / 30 - 1 / 180);
    const since = belowZeroSince(items, AT)!;
    expect(Math.abs(Date.parse(since) - (Date.parse(ago(200)) + crossingDays * DAY))).toBeLessThan(2);
    expect(evidenceNet(items, new Date(Date.parse(since) - 1_000).toISOString())).toBeGreaterThan(0);
    expect(evidenceNet(items, new Date(Date.parse(since) + 1_000).toISOString())).toBeLessThan(0);
    // A new support that lifts the net above 0 breaks the run; falling again starts a new one.
    const lifted = [...items, e('owner_confirmed', 10)];
    expect(evidenceNet(lifted, ago(10))).toBeGreaterThan(0);
    const again = belowZeroSince(lifted, at(400));
    expect(again).not.toBeNull();
    expect(Date.parse(again!)).toBeGreaterThan(Date.parse(ago(10)));
  });

  it('puts an item away after 14 days below 0, and not a day earlier', () => {
    expect(evidenceState([e('ignored', 13)], AT).status).toBe('unconfirmed');
    expect(evidenceState([e('ignored', 14)], AT).status).toBe('put_away');
    expect(evidenceState([e('ignored', 14)], AT).belowZeroSince).toBe(ago(14));
  });

  it('never touches a fact about the owner', () => {
    expect(evidenceState([e('owner_denied', 400), e('owner_denied', 400)], AT, { ownerFact: true })).toEqual({ status: 'exempt', net: 0, support: 0, contra: 0, belowZeroSince: null });
    expect(evidenceUsable(evidenceState([], AT, { ownerFact: true }))).toBe(true);
  });

  it('lists for the dry-run exactly the items whose handling would change, in id order', () => {
    const transitions = decayTransitions([
      { id: 'b-active-stays', evidence: [e('owner_confirmed', 0)], current: 'active' },
      { id: 'a-active-fades', evidence: [e('turn_support', 0)], current: 'active' },
      { id: 'c-faded-usable', evidence: [e('owner_confirmed', 1), e('turn_support', 1)], current: 'faded' },
      { id: 'd-retired-back', evidence: [e('owner_confirmed', 0)], current: 'retired' },
      { id: 'e-owner', evidence: [], current: 'retired', ownerFact: true },
      { id: 'f-retired-stays', evidence: [e('ignored', 30)], current: 'retired' },
    ], AT);
    expect(transitions.map(item => [item.id, item.current, item.after])).toEqual([
      ['a-active-fades', 'active', 'unconfirmed'], ['c-faded-usable', 'faded', 'usable'], ['d-retired-back', 'retired', 'usable'],
    ]);
  });
});
