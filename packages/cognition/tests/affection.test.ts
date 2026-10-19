import { describe, expect, it } from 'vitest';
import {
  AFFECTION_EPOCH, AFFECTION_PARAMETERS, AFFECTION_STAGES, affectionBlock, affectionDays, affectionLines, affectionStage, affectionStageOf, foldAffection,
  otherAiIn, parsedAffectionSetting, type AffectionDay, type FeelingEvent, type RelationshipDay,
} from '../src/index.js';
import { shiftDay } from '../src/temperament.js';

/** Her affection (owner 2026-10-20): one value with no cap, folded from the epoch; the stage it reaches; the facts of the two of them. */
const day = (offset: number, extra: Partial<AffectionDay> = {}): AffectionDay => ({ dayKey: shiftDay(AFFECTION_EPOCH, offset), talked: true, kindWords: 0,
  apologies: 0, hurtfulWords: 0, lewdWords: 0, violations: 0, keptPromises: 0, missedPromises: 0, ...extra });
const talkedFor = (days: number) => Array.from({ length: days }, (_, index) => day(index));
const after = (days: number) => shiftDay(AFFECTION_EPOCH, days);

const event = (kind: FeelingEvent['kind'], at: string, facts: FeelingEvent['facts'] = {}, id = `${kind}:${at}`): FeelingEvent => ({ id, kind,
  personKey: 'owner', identity: 'registered', audience: 'owner_alone', channel: 'text', sceneId: null, sourceId: null, facts, occurredAt: at });

describe('the value and its stage', () => {
  it('starts at the approved v2 core\'s ツンデレ and has no upper bound', () => {
    expect(foldAffection([], AFFECTION_EPOCH)).toEqual({ value: AFFECTION_PARAMETERS.start, stage: 'tsundere', lastLoss: null });
    const year = foldAffection(talkedFor(400).map(item => ({ ...item, kindWords: 4 })), after(400));
    expect(year.value).toBeGreaterThan(1_000);
    expect(year.stage).toBe('deredere');
  });

  it('takes a month of daily talk to デレ and about three months to デレデレ; 本気 is never reached by the value', () => {
    expect(foldAffection(talkedFor(30), after(30)).stage).toBe('dere');
    expect(foldAffection(talkedFor(60), after(60)).stage).toBe('dere');
    expect(foldAffection(talkedFor(100), after(100)).stage).toBe('deredere');
    expect(AFFECTION_STAGES.map(stage => affectionStageOf(stage === 'devoted' ? 1e9 : 0))).not.toContain('devoted');
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
    expect(foldAffection([day(0, { hurtfulWords: 9, violations: 9 })], after(1)).value).toBe(AFFECTION_PARAMETERS.start - 18 - 12 + 0.5);
  });

  it('never falls below zero', () => {
    expect(foldAffection(talkedFor(20).map(item => ({ ...item, hurtfulWords: 3 })), after(20)).value).toBe(0);
    expect(foldAffection([], after(200)).stage).toBe('tsun');
  });

  it('is held at a stage by the owner\'s setting, 本気 included', () => {
    const state = foldAffection([], AFFECTION_EPOCH);
    expect(affectionStage(state, 'auto')).toBe('tsundere');
    expect(affectionStage(state, 'devoted')).toBe('devoted');
    expect(parsedAffectionSetting(' Devoted ')).toBe('devoted');
    expect(parsedAffectionSetting('max')).toBe('auto');
    expect(parsedAffectionSetting(undefined)).toBe('auto');
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
    for (const words of ['ChatGPTにも相談してた', '昨日、別のAIと話してたんだ', 'Geminiってどう思う？', 'ほかの AI に聞いたら']) expect(otherAiIn(words)).toBe(true);
    for (const words of ['Claude Codeで直した', 'Codexに頼んだ', 'AIってすごいね', 'シャノンはAGIだよね']) expect(otherAiIn(words)).toBe(false);
  });
});
