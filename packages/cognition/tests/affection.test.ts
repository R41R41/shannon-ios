import { describe, expect, it } from 'vitest';
import {
  AFFECTION_EPOCH, AFFECTION_PARAMETERS, SECURITY_PARAMETERS, affectionBlock, affectionDays, affectionLines, foldAffection, foldSecurity, likingOf,
  otherAiIn, type AffectionDay, type FeelingEvent, type RelationshipDay,
} from '../src/index.js';
import { shiftDay } from '../src/temperament.js';

/** Her affection (owner 2026-10-20): one value with no cap, folded from the epoch, as 好意; 安心; the facts of the two of them. */
const day = (offset: number, extra: Partial<AffectionDay> = {}): AffectionDay => ({ dayKey: shiftDay(AFFECTION_EPOCH, offset), talked: true, kindWords: 0,
  apologies: 0, hurtfulWords: 0, lewdWords: 0, violations: 0, keptPromises: 0, missedPromises: 0, otherAi: 0, ...extra });
const talkedFor = (days: number) => Array.from({ length: days }, (_, index) => day(index));
const after = (days: number) => shiftDay(AFFECTION_EPOCH, days);

const event = (kind: FeelingEvent['kind'], at: string, facts: FeelingEvent['facts'] = {}, id = `${kind}:${at}`): FeelingEvent => ({ id, kind,
  personKey: 'owner', identity: 'registered', audience: 'owner_alone', channel: 'text', sceneId: null, sourceId: null, facts, occurredAt: at });

describe('the value, 好意 and 安心', () => {
  it('starts in the middle of 好意 and has no upper bound; 好意 nears 1 slowly and never reaches it', () => {
    expect(foldAffection([], AFFECTION_EPOCH)).toEqual({ value: AFFECTION_PARAMETERS.start, lastLoss: null });
    expect(likingOf(AFFECTION_PARAMETERS.start)).toBe(0);
    const year = foldAffection(talkedFor(400).map(item => ({ ...item, kindWords: 4 })), after(400));
    expect(year.value).toBeGreaterThan(1_000);
    expect(likingOf(year.value)).toBeLessThanOrEqual(1);
    expect(likingOf(foldAffection(talkedFor(30), after(30)).value)).toBeCloseTo(0.291, 2);
    expect(likingOf(foldAffection(talkedFor(100), after(100)).value)).toBeCloseTo(0.762, 2);
    expect(likingOf(0)).toBeLessThan(-0.4);
  });

  it('costs nothing for two days away, then each further day', () => {
    const week = talkedFor(10).filter((_, index) => index < 3);
    const value = foldAffection(week, after(10)).value;
    expect(value).toBe(AFFECTION_PARAMETERS.start + 3 + 5 * AFFECTION_PARAMETERS.absenceDay);
    expect(foldAffection(talkedFor(5), after(7)).value).toBe(AFFECTION_PARAMETERS.start + 5);
  });

  it('falls easily and comes back slowly: hurtful words, and the week after them', () => {
    const calm = foldAffection(talkedFor(10), after(10)).value;
    const hurt = foldAffection(talkedFor(10).map((item, index) => (index === 2 ? { ...item, hurtfulWords: 1 } : item)), after(10)).value;
    // The day itself loses 6 and gains half, and the seven days after gain half.
    expect(calm - hurt).toBeCloseTo(6 + 0.5 + 7 * 0.5, 5);
    // Hurtful words count once a day (review 7: the tags are coarse), touches after her no up to four times.
    expect(foldAffection([day(0, { hurtfulWords: 9, violations: 9 })], after(1)).value).toBe(AFFECTION_PARAMETERS.start - 6 - 12 + 0.5);
  });

  it('never falls below zero', () => {
    expect(foldAffection(talkedFor(20).map(item => ({ ...item, hurtfulWords: 3 })), after(20)).value).toBe(0);
  });

  it('folds 安心: his talk of another AI, a long absence and a touch after her no take from it; apologies and quiet days give back', () => {
    expect(foldSecurity([], AFFECTION_EPOCH)).toBe(SECURITY_PARAMETERS.base);
    const shaken = foldSecurity([day(0, { otherAi: 1 }), day(1, { violations: 1 })], after(2));
    expect(shaken).toBeCloseTo(SECURITY_PARAMETERS.base + 2 * SECURITY_PARAMETERS.talkDay + SECURITY_PARAMETERS.otherAi + SECURITY_PARAMETERS.violation, 5);
    expect(foldSecurity([day(0, { otherAi: 1 }), day(1, { violations: 1 }), ...talkedFor(30).slice(2)], after(30))).toBeGreaterThan(shaken + 0.15);
    expect(foldSecurity([day(0, { apologies: 1 })], after(1))).toBeGreaterThan(SECURITY_PARAMETERS.base);
    expect(foldSecurity([], after(30))).toBeLessThan(0);
  });
});

describe('the days it is folded from', () => {
  it('counts his closed days (kind words, apologies, hurtful words, touches after her no), the days talked, and the promises', () => {
    const at = (offset: number, hour: number) => `${shiftDay(AFFECTION_EPOCH, offset)}T0${hour}:00:00.000Z`;
    const closed: RelationshipDay[] = [{ dayKey: after(1), events: [
      event('praised', at(1, 1)), event('praised', at(1, 2)), event('apologized', at(1, 3)), event('spoke', at(1, 4), { tags: ['insult'] }),
      event('spoke', at(1, 5), { tags: ['lewd'] }), event('touched', at(1, 6), { touchKind: 'poke', part: 'chest', stance: 'dislike' }, 't1'),
      event('touched', at(1, 7), { touchKind: 'poke', part: 'chest' }, 't2'),
    ] }, { dayKey: shiftDay(AFFECTION_EPOCH, -3), events: [event('praised', at(-3, 1))] }];
    const days = affectionDays({ days: closed, sharedDays: [after(2), shiftDay(AFFECTION_EPOCH, -1)], today: after(9), promises: [
      { status: 'completed', updatedAt: `${after(3)}T01:00:00.000Z` },
      { status: 'pending', updatedAt: `${after(0)}T01:00:00.000Z`, dueDate: after(4) },
      { status: 'pending', updatedAt: `${after(0)}T01:00:00.000Z`, dueDate: after(20) },
      { status: 'pending', updatedAt: `${after(0)}T01:00:00.000Z` },
    ] });
    expect(days.map(item => item.dayKey)).toEqual([after(1), after(2), after(3), after(5)]);
    expect(days[0]).toMatchObject({ talked: true, kindWords: 2, apologies: 1, hurtfulWords: 1, lewdWords: 1, violations: 1 });
    expect(days[1]).toMatchObject({ talked: true });
    expect(days[2]).toMatchObject({ talked: false, keptPromises: 1 });
    expect(days[3]).toMatchObject({ talked: false, missedPromises: 1 });
  });

  it('does not hold against him the words Jev read as not meant, and takes a promise\'s day as her day', () => {
    const at = `${after(1)}T01:00:00.000Z`;
    const closed = [{ dayKey: after(1), events: [event('spoke', at, { tags: ['insult'], meaning: { deliberate: 0.2, teasing: 0.9 } })] }];
    expect(affectionDays({ days: closed, sharedDays: [], promises: [], today: after(3) })[0]).toMatchObject({ talked: true, hurtfulWords: 0 });
    // 05:00 JST on the day after is still the day before (her day turns at 3:00 owner time).
    const promise = { status: 'completed' as const, updatedAt: `${after(2)}T20:00:00.000Z` };
    const dayOf = (instant: string) => (instant === promise.updatedAt ? after(2) : instant.slice(0, 10));
    expect(affectionDays({ days: [], sharedDays: [], promises: [promise], today: after(5), dayOf })[0]).toMatchObject({ dayKey: after(2), keptPromises: 1 });
  });

  it('leaves out anyone else\'s events and other audiences', () => {
    const someone = { ...event('praised', `${after(1)}T01:00:00.000Z`), personKey: 'person:a' };
    const group = { ...event('praised', `${after(1)}T02:00:00.000Z`), audience: 'group' as const };
    expect(affectionDays({ days: [{ dayKey: after(1), events: [someone, group] }], sharedDays: [], promises: [], today: after(3) })[0])
      .toMatchObject({ talked: false, kindWords: 0 });
  });
});

describe('the facts of the two of them', () => {
  it('says how often they talk, how long he was away, kind words, a hurtful word, promises and another AI; never a number of points', () => {
    const today = after(20);
    // Talked on the eight days from two weeks ago, and four days ago; three days away since.
    const sharedDays = Array.from({ length: 8 }, (_, index) => shiftDay(today, -14 + index));
    const days = [day(13, { kindWords: 3 }), day(16, { hurtfulWords: 1 }), day(17, { talked: false, keptPromises: 1 })];
    const lines = affectionLines({ days, sharedDays, today, otherAiDays: [shiftDay(today, -1)] });
    expect(lines).toEqual(['最近は、よく話している', '3日、話していなかった。今日、久しぶりに話している', '最近、好意の言葉をもらった',
      'この前、傷つく言葉を言われた', '約束していたことが、ちゃんと片付いた', '昨日、ライ氏はほかのAIの話をしていた']);
    const block = affectionBlock(lines);
    expect(block).toMatch(/^\[ライ氏とのこと\]/u);
    expect(block).not.toMatch(/ツン|デレ|本気|好感度|点/u);
    expect(affectionBlock([])).toBe('');
  });

  it('says yesterday was missed, and nothing of an AI he spoke of days ago', () => {
    const today = after(5);
    const lines = affectionLines({ days: [], sharedDays: [shiftDay(today, -2)], today, otherAiDays: [shiftDay(today, -4)] });
    expect(lines).toEqual(['最近は、あまり話していない', '昨日は話さなかった']);
  });

  it('reads another AI he talks with, never the coding tools he works with', () => {
    for (const words of ['ChatGPTにも相談してた', '昨日、別のAIと話してたんだ', 'Grokってどう思う？', 'ほかの AI に聞いたら']) expect(otherAiIn(words)).toBe(true);
    for (const words of ['Claude Codeで直した', 'Codexに頼んだ', 'Geminiの声を試した', 'Copilotで補完した', 'AIってすごいね', 'シャノンはAGIだよね']) {
      expect(otherAiIn(words)).toBe(false);
    }
  });
});
