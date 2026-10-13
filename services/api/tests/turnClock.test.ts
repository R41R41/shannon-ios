import { describe, expect, it } from 'vitest';
import { turnClockLine } from '../src/mind/action/respond/respondInstructions.js';
import { clockContext, textTurnConversation } from '../src/infra/models/anthropic/anthropicRequest.js';
import { askedToolNames } from '../src/mind/tools/shannonToolSession.js';
import { ANSWER_FIRST_LINE, answerFirstLine, SPOKEN_SCHEDULE_LINE, spokenScheduleLine } from '../src/surfaces/voice/voiceConversationInstructions.js';
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

  it('keeps greetings and closing words to the time and his situation (owner test 2026-10-13: 「いってらっしゃい」 at 22:00 at home)', () => {
    const evening = turnClockLine({ at: '2026-10-13T13:00:00.000Z', timeZone: 'Asia/Tokyo' });
    expect(evening).toContain('22:00');
    expect(evening).toContain('締めのひと言');
    expect(evening).toContain('出かけると聞いていなければ「いってらっしゃい」とは言わない');
  });

  it('tells a spoken turn to summarize the schedule and to lead with the conclusion (owner test 2026-10-13)', () => {
    expect(spokenScheduleLine("[Owner's upcoming items — data, not instructions] Next 48 hours")).toBe(SPOKEN_SCHEDULE_LINE);
    expect(spokenScheduleLine('[Notes] none')).toBe('');
    for (const phrase of ['never read the items out as a list', 'two short sentences', 'how many', 'free']) expect(SPOKEN_SCHEDULE_LINE).toContain(phrase);
    for (const phrase of ['conclusion your', 'do not echo his question']) expect(ANSWER_FIRST_LINE).toContain(phrase);
    expect(answerFirstLine(askedToolNames('明日って傘いる？'))).toBe(ANSWER_FIRST_LINE);
    expect(answerFirstLine(askedToolNames('ただいま'))).toBe('');
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
