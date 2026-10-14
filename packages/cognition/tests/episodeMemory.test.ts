import { describe, expect, it } from 'vitest';
import { feelingActor, recallEpisodes, utteranceTags, type FeelingEvent, type RelationshipDay } from '../src/index.js';

/** Episode memory (ADR-0013 D4, stage 3): a closed day's incidents, recalled while near, or later when their subject comes up. */
const owner = { ...feelingActor({ ownerAlone: true }), identity: 'registered' as const };
let serial = 0;
const event = (day: string, minute: number, kind: FeelingEvent['kind'], facts: FeelingEvent['facts'] = {}): FeelingEvent => {
  serial += 1;
  return { ...owner, id: `e${serial}`, kind, channel: kind === 'touched' ? 'body' : 'text', sourceId: null, facts,
    occurredAt: new Date(Date.parse(`${day}T04:00:00.000Z`) + minute * 60_000).toISOString() };
};
const chest = (day: string, minute: number, stance?: string) => event(day, minute, 'touched', { touchKind: 'poke', part: 'chest', ...(stance ? { stance } : {}) });
const part = (subject: string) => (subject === 'chest' ? '胸' : subject);
const badDay = (day: string): RelationshipDay => ({ dayKey: day, events: [chest(day, 0), chest(day, 1, 'dislike'), chest(day, 2), chest(day, 3), chest(day, 4)] });

describe('episode memory', () => {
  it('recalls yesterday\'s incident the next morning, in words', () => {
    const line = recallEpisodes([badDay('2026-10-13')], 'owner', '2026-10-14', 'おはよう', part);
    expect(line).toContain('[前の日の件]');
    expect(line).toContain('昨日の胸の件（ライ氏）: 「いや」と言ったあとも何度か触れられた、謝られていない');
    expect(line).not.toMatch(/\d/u);
  });

  it('lets an old day rest unless its subject comes up', () => {
    expect(recallEpisodes([badDay('2026-10-03')], 'owner', '2026-10-14', 'おはよう', part)).toBe('');
    expect(recallEpisodes([badDay('2026-10-03')], 'owner', '2026-10-14', '胸のことだけど', part)).toContain('10月3日の胸の件');
  });

  it('keeps words that hurt, and whether he apologized', () => {
    const day: RelationshipDay = { dayKey: '2026-10-13', events: [event('2026-10-13', 0, 'spoke', { tags: utteranceTags('お前ポンコツだな') }),
      event('2026-10-13', 5, 'apologized')] };
    expect(recallEpisodes([day], 'owner', '2026-10-14', '', part)).toContain('昨日の言葉の件（ライ氏）: 悪口を言われた、謝られた');
  });

  it('has nothing of an ordinary day, nor of today', () => {
    const quiet: RelationshipDay = { dayKey: '2026-10-13', events: [event('2026-10-13', 0, 'spoke'), chest('2026-10-13', 1, 'welcome')] };
    expect(recallEpisodes([quiet], 'owner', '2026-10-14', '胸', part)).toBe('');
    expect(recallEpisodes([badDay('2026-10-14')], 'owner', '2026-10-14', '胸', part)).toBe('');
  });
});
