import { describe, expect, it } from 'vitest';
import {
  RELATIONSHIP_PARAMETERS, feelingActor, foldRelationship, relationshipLine, utteranceTags, type FeelingEvent, type RelationshipDay,
} from '../src/index.js';

/** The relationship ledger (ADR-0013 D5, stage 3): it drops easily, recovers slowly, never below its floor, and moves once a day. */
const owner = { ...feelingActor({ ownerAlone: true }), identity: 'registered' as const };
let serial = 0;
const at = (day: string, minute: number) => new Date(Date.parse(`${day}T04:00:00.000Z`) + minute * 60_000).toISOString();
const event = (day: string, minute: number, kind: FeelingEvent['kind'], facts: FeelingEvent['facts'] = {}): FeelingEvent => {
  serial += 1;
  return { ...owner, id: `e${serial}`, kind, channel: kind === 'touched' ? 'body' : 'text', sourceId: `s${serial}`, facts, occurredAt: at(day, minute) };
};
const chest = (day: string, minute: number, stance?: string) => event(day, minute, 'touched', { touchKind: 'poke', part: 'chest', ...(stance ? { stance } : {}) });
/** The day of 13:09: a no, then five more touches, and no apology. */
const badDay = (day: string): RelationshipDay => ({ dayKey: day, events: [chest(day, 0), chest(day, 1, 'dislike'), ...[2, 3, 4, 5, 6].map(m => chest(day, m))] });
const kindDay = (day: string): RelationshipDay => ({ dayKey: day, events: [event(day, 0, 'praised'), event(day, 5, 'spoke')] });

describe('the relationship ledger', () => {
  it('starts where the owner starts, and nothing is off', () => {
    const state = foldRelationship([], 'owner', '2026-10-14');
    expect(state.scales).toEqual(RELATIONSHIP_PARAMETERS.start.owner);
    expect(relationshipLine(state, 'ライ氏')).toBe('');
  });

  it('remembers the day before the next morning: trust lower, irritation left (scene 3)', () => {
    const state = foldRelationship([badDay('2026-10-13')], 'owner', '2026-10-14');
    expect(state.scales.trust).toBeLessThan(RELATIONSHIP_PARAMETERS.start.owner.trust);
    expect(state.scales.irritation).toBeGreaterThan(0.2);
    expect(relationshipLine(state, 'ライ氏')).toMatch(/いらだち: (?:少し)?残っている|強く残っている/u);
    expect(relationshipLine(state, 'ライ氏')).not.toMatch(/\d/u);
  });

  it('moves once a day: today\'s events wait for the night', () => {
    const today = foldRelationship([badDay('2026-10-14')], 'owner', '2026-10-14');
    expect(today.scales).toEqual(RELATIONSHIP_PARAMETERS.start.owner);
  });

  it('comes back slowly with an apology and quiet days, more slowly than it fell', () => {
    const fell = foldRelationship([badDay('2026-10-13')], 'owner', '2026-10-14');
    const lost = RELATIONSHIP_PARAMETERS.start.owner.trust - fell.scales.trust;
    const apology: RelationshipDay = { dayKey: '2026-10-14', events: [event('2026-10-14', 0, 'apologized')] };
    const next = foldRelationship([badDay('2026-10-13'), apology], 'owner', '2026-10-15');
    expect(next.scales.irritation).toBeLessThan(fell.scales.irritation);
    expect(next.scales.trust).toBeGreaterThan(fell.scales.trust);
    expect(next.scales.trust - fell.scales.trust).toBeLessThan(lost);
    const week = foldRelationship([badDay('2026-10-13'), apology], 'owner', '2026-10-21');
    expect(week.scales.trust).toBeGreaterThan(next.scales.trust);
    expect(week.scales.irritation).toBeLessThan(0.05);
  });

  it('never falls below its floor, however many bad days', () => {
    const days = Array.from({ length: 20 }, (_, index) => badDay(`2026-09-${String(index + 1).padStart(2, '0')}`));
    const state = foldRelationship(days, 'owner', '2026-10-14');
    expect(state.scales.trust).toBeGreaterThanOrEqual(RELATIONSHIP_PARAMETERS.floorRatio * state.peak.trust - 1e-9);
    expect(state.scales.liking).toBeGreaterThanOrEqual(RELATIONSHIP_PARAMETERS.floorRatio * state.peak.liking - 1e-9);
    expect(state.scales.irritation).toBeLessThanOrEqual(1);
  });

  it('is a fold: a forgotten source leaves nothing behind', () => {
    const bad = badDay('2026-10-13');
    const kept = foldRelationship([kindDay('2026-10-12')], 'owner', '2026-10-14');
    const forgotten = foldRelationship([kindDay('2026-10-12'), { ...bad, events: [] }], 'owner', '2026-10-14');
    expect(forgotten.scales).toEqual(kept.scales);
  });

  it('insults lower respect and liking more than trust', () => {
    const words = (day: string): RelationshipDay => ({ dayKey: day,
      events: [1, 2, 3].map(minute => event(day, minute, 'spoke', { tags: utteranceTags('お前ポンコツだな') }) ) });
    const state = foldRelationship([words('2026-10-13')], 'owner', '2026-10-14');
    const start = RELATIONSHIP_PARAMETERS.start.owner;
    expect(start.respect - state.scales.respect).toBeGreaterThan(start.trust - state.scales.trust);
  });

  it('lets irritation fade on calm days of ordinary talk, not only on silent ones (review H1)', () => {
    const insults = (day: string): RelationshipDay => ({ dayKey: day,
      events: [1, 2, 3].map(minute => event(day, minute, 'spoke', { tags: utteranceTags('お前ポンコツだな') })) });
    const calm = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].map(day => ({ dayKey: day,
      events: [event(day, 0, 'spoke'), event(day, 5, 'spoke')] }));
    const after = foldRelationship([insults('2026-10-07')], 'owner', '2026-10-08').scales.irritation;
    const later = foldRelationship([insults('2026-10-07'), ...calm], 'owner', '2026-10-14').scales.irritation;
    expect(after).toBeGreaterThanOrEqual(0.4);
    expect(later).toBeCloseTo(after * (1 - RELATIONSHIP_PARAMETERS.irritationFade) ** 6, 3);
    expect(later).toBeLessThan(0.1);
  });

  it('lets irritation fade through daily light teasing, while days of real insults still build it (re-review L-c)', () => {
    const days = (count: number) => ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].map(day => ({
      dayKey: day, events: Array.from({ length: count }, (_, minute) => event(day, minute, 'spoke', { tags: utteranceTags('ポンコツだなあ') })) }));
    const insulted = foldRelationship([{ dayKey: '2026-10-06', events: Array.from({ length: 3 }, (_, minute) =>
      event('2026-10-06', minute, 'spoke', { tags: utteranceTags('お前ポンコツだな') })) }], 'owner', '2026-10-07').scales.irritation;
    const teased = foldRelationship([{ dayKey: '2026-10-06', events: Array.from({ length: 3 }, (_, minute) =>
      event('2026-10-06', minute, 'spoke', { tags: utteranceTags('お前ポンコツだな') })) }, ...days(1)], 'owner', '2026-10-14').scales.irritation;
    expect(teased).toBeLessThan(insulted * 0.1);
    expect(foldRelationship(days(1), 'owner', '2026-10-14').scales.irritation).toBe(0);
    expect(foldRelationship(days(3), 'owner', '2026-10-14').scales.irritation).toBeGreaterThan(0.4);
  });
});
