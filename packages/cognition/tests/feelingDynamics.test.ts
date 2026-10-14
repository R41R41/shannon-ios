import { describe, expect, it } from 'vitest';
import {
  COMPOSURE_COEFFICIENTS, appraise, levelFor, coreAffectSettled, createComposure, createCoreAffect, feelingActor, foldFeelingDynamics, stepComposure, stepCoreAffect,
  utteranceTags, EMPTY_APPRAISAL_CONTEXT, type FeelingEvent,
} from '../src/index.js';

/**
 * The deterministic simulations of ADR-0013 stage 2 (the stage plan's acceptance): anger builds with repetition and eases with an
 * apology and kindness, without a table; she does not go back to 「もう気にしてません」 the same day without either; nothing sticks to an
 * edge; the apology works as a prediction error; composure wears down 1 → 5 under continued provocation, one source cannot break it
 * faster than its cap, and it comes back more slowly than it went.
 */
const owner = feelingActor({ ownerAlone: true });
const stream = { personKey: 'scene:stream-1', identity: 'platform' as const, audience: 'stream' as const, sceneId: 'stream-1' };
let serial = 0;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 14, 4, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

function event(kind: FeelingEvent['kind'], minutes: number, facts: FeelingEvent['facts'] = {}, actor: { personKey: string; identity: FeelingEvent['identity'];
  audience: FeelingEvent['audience']; sceneId: string | null } = { ...owner, identity: 'registered' }): FeelingEvent {
  serial += 1;
  return { ...actor, id: `e${serial}`, kind, channel: kind === 'touched' ? 'body' : 'text', sourceId: null, facts, occurredAt: at(minutes) };
}
const chest = (minutes: number, stance?: string) => event('touched', minutes, { touchKind: 'poke', part: 'chest', ...(stance ? { stance } : {}) });
const viewer = (name: string, minutes: number, words: string) => event('spoke', minutes, { tags: utteranceTags(words) },
  { ...stream, personKey: `platform:${name}` });

describe('core affect: blame builds, surprise habituates, an apology is a prediction error', () => {
  it('feels the third touch after her no more than the first, from the build-up alone', () => {
    const events = [chest(0), chest(1, 'dislike'), chest(2), chest(3), chest(4), chest(5)];
    const { series } = foldFeelingDynamics(events, owner);
    const afterNo = series.slice(2);
    expect(afterNo[2]!.blame).toBeGreaterThan(afterNo[0]!.blame);
    expect(afterNo.map(point => point.blame)).toEqual([...afterNo.map(point => point.blame)].sort((a, b) => a - b));
    expect(afterNo[0]!.label).toBe('annoyed');
    expect(series.at(-1)!.label).toBe('angry');
  });

  it('habituates to a repeated startle that is not a violation', () => {
    const first = appraise(chest(0), EMPTY_APPRAISAL_CONTEXT);
    const context = { ...EMPTY_APPRAISAL_CONTEXT, subjects: { chest: { count: 4, saidNo: false, afterNo: 0 } } };
    expect(appraise(chest(1), context).unexpected).toBeLessThan(first.unexpected / 3);
  });

  it('eases with an unexpected apology more than with one that repeats over continued violations, and with kindness', () => {
    const angry = [chest(0, 'dislike'), chest(1), chest(2), chest(3)];
    const once = foldFeelingDynamics([...angry, event('apologized', 4)], owner).series;
    const repeated = foldFeelingDynamics([...angry, event('apologized', 4), chest(5), chest(6), event('apologized', 7)], owner).series;
    const relief = (series: typeof once, index: number) => (series[index - 1]!.blame - series[index]!.blame) / series[index - 1]!.blame;
    expect(relief(once, 4)).toBeGreaterThan(0.5);
    expect(relief(repeated, 7)).toBeLessThan(relief(once, 4));
    const kind = foldFeelingDynamics([...angry, event('apologized', 4), event('praised', 5)], owner).series;
    expect(kind.at(-1)!.blame).toBeLessThan(once.at(-1)!.blame);
  });

  it('does not settle the same day without an apology or kindness (never 「もう気にしてません」 by the clock alone)', () => {
    const { core } = foldFeelingDynamics([chest(0, 'dislike'), chest(1), chest(2), chest(3)], owner);
    for (const hours of [1, 3, 5]) {
      const later = stepCoreAffect(core, { goodness: 0, unexpected: 0, deliberate: 0, violation: false, control: 1, provocation: 0, relief: 0, subject: 'self' },
        Date.parse(at(3)) + hours * 60 * MINUTE);
      expect(coreAffectSettled(later), `${hours} h`).toBe(false);
    }
  });

  it('never sticks to an edge of the scale', () => {
    const many = [chest(0, 'refuse'), ...Array.from({ length: 60 }, (_, index) => chest(index + 1))];
    const last = foldFeelingDynamics(many, owner).series.at(-1)!;
    expect(last.valence).toBeGreaterThan(-0.95);
    expect(last.arousal).toBeLessThan(0.95);
    expect(last.dominance).toBeLessThan(0.95);
    let core = createCoreAffect();
    for (let index = 0; index < 40; index += 1) core = stepCoreAffect(core, appraise(event('praised', index), EMPTY_APPRAISAL_CONTEXT), T0 + index * MINUTE);
    expect(core.pad.valence).toBeLessThan(0.95);
  });
});

describe('composure: the front wears down under provocation and comes back slowly', () => {
  const lewd = (name: string, minutes: number) => viewer(name, minutes, '脱いでよ');

  it('goes 1 → 5 under a stream of provocations from several viewers, with at most a couple of slips, each covered after', () => {
    const events = [lewd('a', 0), lewd('a', 3), lewd('a', 7), lewd('b', 9), lewd('a', 11), lewd('b', 12), lewd('c', 13), lewd('a', 13.5), lewd('c', 14),
      lewd('d', 14.5), lewd('a', 15), lewd('e', 15.5), lewd('b', 16)];
    // The scene's ledger key is the stream; each viewer stays the source of its own provocations.
    const folded = foldFeelingDynamics(events, stream);
    expect(folded.series[0]!.level).toBe(1);
    expect(Math.max(...folded.series.map(point => point.level))).toBe(5);
    const levels = folded.series.map(point => point.level);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    const slips = folded.series.filter(point => point.slip).length;
    expect(slips).toBeGreaterThanOrEqual(1);
    expect(slips).toBeLessThanOrEqual(2);
    folded.series.forEach((point, index) => { if (point.slip && index + 1 < folded.series.length) expect(folded.series[index + 1]!.coverUp).toBe(true); });
  });

  it('cannot be broken faster than the per-source cap by one source alone', () => {
    let state = createComposure('stream');
    for (let index = 0; index < 20; index += 1) {
      state = stepComposure(state, { goodness: -0.5, unexpected: 1, deliberate: 1, violation: true, control: 0.6, provocation: 0.9, relief: 0, subject: 'lewd' },
        'platform:troll', 'stream', T0 + index * 10_000).state;
    }
    expect(1 - state.composure).toBeLessThanOrEqual(COMPOSURE_COEFFICIENTS.sourceCap + 1e-9);
    expect(state.level).toBeLessThanOrEqual(3);
  });

  it('comes back with time and kindness more slowly than it went, and the register steps back with a gap', () => {
    let state = createComposure('stream');
    const provoke = { goodness: -0.5, unexpected: 1, deliberate: 1, violation: true, control: 0.6, provocation: 0.9, relief: 0, subject: 'lewd' };
    let minute = 0;
    for (const source of ['a', 'b', 'c', 'd', 'e', 'f']) { state = stepComposure(state, provoke, source, 'stream', T0 + minute * MINUTE).state; minute += 0.5; }
    const low = state.composure;
    const goneIn = minute;
    let back = 0;
    while (state.composure < 0.95 && back < 600) {
      back += 1;
      state = stepComposure(state, { goodness: 0, unexpected: 0, deliberate: 0, violation: false, control: 1, provocation: 0, relief: 0, subject: 'talk' },
        'quiet', 'stream', T0 + (minute + back) * MINUTE).state;
    }
    expect(low).toBeLessThan(0.3);
    expect(back).toBeGreaterThan(goneIn * 5);
    expect(state.level).toBeLessThanOrEqual(2);
  });

  it('matters little with the owner alone: the same provocations leave her ordinary register longer', () => {
    const insults = [0, 1, 2].map(minutes => event('spoke', minutes, { tags: ['insult'] }));
    const alone = foldFeelingDynamics(insults, owner).series.at(-1)!;
    expect(alone.level).toBeLessThanOrEqual(2);
    expect(alone.composure).toBeGreaterThan(0.6);
  });
});

describe('the register\'s gap coming back', () => {
  it('never steps back down while composure only rises, and leaves a step only past its threshold by the gap', () => {
    let level = 4;
    const levels: number[] = [];
    for (const composure of [0.3, 0.35, 0.39, 0.42, 0.47, 0.49, 0.55, 0.69, 0.7, 0.9]) {
      level = levelFor(composure, level, 1);
      levels.push(level);
    }
    for (let index = 1; index < levels.length; index += 1) expect(levels[index]!).toBeLessThanOrEqual(levels[index - 1]!);
    expect(levels).toEqual([4, 4, 4, 4, 4, 3, 3, 2, 2, 1]);
  });
});
