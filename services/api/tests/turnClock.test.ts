import { describe, expect, it } from 'vitest';
import { turnClockLine } from '../src/mind/action/respond/respondInstructions.js';
import { clockContext, textTurnConversation } from '../src/infra/models/anthropic/anthropicRequest.js';
import { RESEARCH_UNDER_WAY_LINE, TURN_OUT_OF_TIME_LINE, withResearchUnderWay } from '../src/mind/action/respond/turnDeadline.js';

describe('the owner\'s clock in a turn (owner decision 2026-10-13)', () => {
  it('says his local date and time, and in the small hours that 「明日」 may mean the day just begun', () => {
    const night = turnClockLine({ at: '2026-10-12T17:42:00.000Z', timeZone: 'Asia/Tokyo' });
    expect(night).toContain('2026年10月13日火曜日 2:42');
    expect(night).toContain('（Asia/Tokyo）');
    expect(night).toContain('今日（10月13日）');
    expect(night).toContain('確かめる');
    const day = turnClockLine({ at: '2026-10-13T04:46:00.000Z', timeZone: 'Asia/Tokyo' });
    expect(day).toContain('2026年10月13日火曜日 13:46');
    expect(day).not.toContain('深夜');
    expect(turnClockLine({ at: '2026-10-12T19:30:00.000Z', timeZone: 'Asia/Tokyo' })).not.toContain('深夜'); // 4:30
    expect(turnClockLine({ at: '2026-10-13T04:46:00.000Z', timeZone: 'Not/AZone' })).toContain('（Asia/Tokyo）');
  });

  it('puts the clock in the Claude turn context only when the turn carries it (the historical GPT profile never reads it)', () => {
    const clock = { at: '2026-10-12T17:42:00.000Z', timeZone: 'Asia/Tokyo' };
    expect(clockContext({ clock })).toEqual([turnClockLine(clock)]);
    expect(clockContext({})).toEqual([]);
    const request = { scopeKey: 'owner', systemPrompt: 'x', message: '明日の天気は？', history: [], conversationClass: 'direct' } as never;
    expect(textTurnConversation({ ...(request as object), clock } as never).context.at(-1)).toBe(turnClockLine(clock));
    expect(textTurnConversation(request).context).not.toContain(turnClockLine(clock));
  });

  it('never ends a turn whose research runs on with 「時間が足りなかった」', () => {
    expect(withResearchUnderWay(TURN_OUT_OF_TIME_LINE)).toBe(RESEARCH_UNDER_WAY_LINE);
    expect(withResearchUnderWay(`ええと。${TURN_OUT_OF_TIME_LINE}`)).toBe(`ええと。${RESEARCH_UNDER_WAY_LINE}`);
    expect(withResearchUnderWay('答えです。')).toBe('答えです。');
  });
});
