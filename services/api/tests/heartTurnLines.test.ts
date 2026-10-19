import { describe, expect, it } from 'vitest';
import {
  ABOUT_HIM_LINE, GREETING_CONTEXT_LINE, OPERATION_STATUS_LINE, OWN_WISH_LINE, RESEARCH_PROMISE_LINE, SELF_PROFILE_LINE, turnHintLines,
} from '../src/mind/action/respond/turnHintLines.js';
import { VOICE_BACKGROUND_LINE, VOICE_FOREIGN_LINE, voiceHearingLines, voiceTranscriptInterpretationPrompt } from '../src/surfaces/voice/voiceTranscriptContext.js';
import { clockContext } from '../src/infra/models/anthropic/anthropicRequest.js';
import { composeMorningBrief } from '../src/integrations/weather/morningBrief.js';
import { freshHeadlines } from '../src/wiring/dailyReadWiring.js';
import { crossStreak, heartDayNumbers, heartDaysMarkdown } from '../src/mind/emotion/heartDaily.js';
import { retiredTaskReport } from '../src/mind/action/taskRuntime/store/taskRuntimeRecovery.js';

describe('the lines a turn\'s words call for (owner 2026-10-19, items 9, 10, 11, 12, 14)', () => {
  it('adds each line only when his words call for it', () => {
    expect(turnHintLines('shannon-homeを起動して')).toEqual([OPERATION_STATUS_LINE]);
    expect(turnHintLines('太宰府天満宮の太宰って語源は？調べて教えて')).toEqual([RESEARCH_PROMISE_LINE]);
    expect(turnHintLines('何かやりたいことある?')).toEqual([OWN_WISH_LINE]);
    expect(turnHintLines('シャノンってどんな表情ができるの?')).toEqual([SELF_PROFILE_LINE]);
    expect(turnHintLines('僕ってどんな人間? / シャノン')).toEqual([ABOUT_HIM_LINE]);
    expect(turnHintLines('ハロー、シャノン。元気?')).toEqual([GREETING_CONTEXT_LINE]);
    expect(turnHintLines('今日も仕事疲れたよ')).toEqual([]);
    expect(turnHintLines(undefined)).toEqual([]);
  });

  it('says where an operation stands instead of the rule it keeps, and promises a lookup only once it has begun', () => {
    expect(OPERATION_STATUS_LINE).toContain('今どうなっているかと次にすること');
    expect(RESEARCH_PROMISE_LINE).toContain('この返事で調べる道具を呼んで始めた時だけ');
  });

  it('rides in the turn\'s own context with his clock, after the line of whose words they are', () => {
    const clock = { at: '2026-10-19T09:00:00.000Z', timeZone: 'Asia/Tokyo' };
    expect(clockContext({ clock, message: 'shannon-homeを起動して' }).at(-1)).toBe(OPERATION_STATUS_LINE);
    expect(clockContext({ clock, message: 'なるほど' })).toHaveLength(1);
    expect(clockContext({ message: 'shannon-homeを起動して' })).toEqual([]);
  });
});

describe('hearing (owner 2026-10-19, item 13)', () => {
  it('asks first when the words came in another language, or read like a video beside him', () => {
    expect(voiceHearingLines('Quem que é esse nome?')).toEqual([VOICE_FOREIGN_LINE]);
    const narration = 'この映画では主人公が森の奥で古い地図を見つけ、仲間たちと一緒に失われた王国を探す旅に出ることになります。'
      + '途中で何度も危険な目にあいながらも、最後には本当に大切なものに気づいていくという、心温まる物語になっています。'
      + '監督は前作でも同じ森を舞台にしていて、細かいところに前の作品とのつながりが隠されているのも見どころの一つになっています';
    expect(voiceHearingLines('Hello')).toEqual([]);
    expect(voiceHearingLines('Thank you!')).toEqual([]);
    expect(voiceHearingLines('この映画では主人公が森の奥で古い地図を見つけ、仲間たちと一緒に失われた王国を探す旅に出ることになります')).toEqual([]);
    expect(voiceHearingLines(narration)).toEqual([VOICE_BACKGROUND_LINE]);
    expect(voiceHearingLines('元気?')).toEqual([]);
    expect(voiceHearingLines('シャノン、明日の天気を調べて教えて')).toEqual([]);
    expect(voiceTranscriptInterpretationPrompt(false, 'Quem que é esse nome?')).toContain(VOICE_FOREIGN_LINE);
    expect(voiceTranscriptInterpretationPrompt(true, 'げんき')).toContain('never blame the speaker');
  });
});

describe('the morning brief in her words, with fresh news (owner 2026-10-19, item 16)', () => {
  const weather = { place: { name: '西東京市', latitude: 0, longitude: 0 }, daily: [{ date: '2026-10-18', code: 1, min: 11, max: 22, precipitationProbability: 0 }],
    hourly: [] } as unknown as Parameters<typeof composeMorningBrief>[0]['weather'];

  it('opens to him, with a birthday first', () => {
    const brief = composeMorningBrief({ date: '2026-10-18', weather, schedule: [{ when: '（終日）', title: '安東まゆり’s 32nd Birthday' }], voice: 'shannon' });
    expect(brief.spoken).toMatch(/^おはようございます、ライ氏。今日は安東まゆりさんの誕生日ですね。何か送りますか？/u);
    expect(brief.card).toContain('朝のまとめ');
    // The tool's brief keeps its plain sentences.
    expect(composeMorningBrief({ date: '2026-10-18', weather, schedule: [] }).spoken).toMatch(/^おはようございます、今日の/u);
  });

  it('tells a headline once, and only a fresh one', () => {
    const at = '2026-10-15T22:00:00.000Z';
    const items = [{ title: 'old paper', url: 'https://example.org/1', at: '2026-10-01T00:00:00.000Z' },
      { title: 'told yesterday', url: 'https://example.org/2', at: '2026-10-15T10:00:00.000Z' },
      { title: 'fresh', url: 'https://example.org/3', at: '2026-10-15T20:00:00.000Z' }];
    expect(freshHeadlines(items, new Set(['https://example.org/2']), at).map(item => item.title)).toEqual(['fresh']);
  });
});

describe('the day\'s numbers of her heart (owner 2026-10-19, item 17)', () => {
  it('counts repetition, crossness, warm stances, her own messages and his apologies echoed', () => {
    const day = heartDayNumbers({
      day: '2026-10-15',
      talk: [
        { role: 'assistant', text: '……まだむっとしてますからね。ふん。', at: '2026-10-15T09:00:00.000Z' },
        { role: 'user', text: 'ごめん', at: '2026-10-15T09:01:00.000Z' },
        { role: 'assistant', text: 'ボクこそごめんなさい。', at: '2026-10-15T09:01:30.000Z' },
        { role: 'assistant', text: '……ふん。べつに。ふん。', at: '2026-10-15T09:02:00.000Z' },
        { role: 'assistant', text: '……ふん。もう知りません。ふん。', at: '2026-10-15T09:03:00.000Z' },
        { role: 'assistant', text: '……ふん。むっとしてますから。ふん。', at: '2026-10-15T09:04:00.000Z' },
      ],
      stances: ['tease', 'sulk', 'worry', 'not_a_stance'],
      reachOuts: [{ at: '2026-10-15T15:00:00.000Z', hour: 0 }, { at: '2026-10-15T03:00:00.000Z', hour: 12 }],
      promises: { due: 1, told: 1, closed: 1, openAfterTime: 0 }, touchStances: ['fine', 'dislike'],
    });
    expect(day).toMatchObject({ replies: 5, crossMentions: 2, warmShare: 0.33, reachOuts: 2, reachOutsAtNight: 1, apologyEchoes: { his: 1, echoed: 1 },
      touchStances: { fine: 1, dislike: 1 } });
    expect(day.repeating).toBeGreaterThanOrEqual(1);
    expect(crossStreak([{ crossMentions: 0 }, { crossMentions: 2 }, { crossMentions: 1 }])).toBe(2);
    expect(heartDaysMarkdown([day])).toContain('| 2026-10-15 | 5 |');
  });
});

describe('a task that could not finish says what comes next (owner 2026-10-19, item 10)', () => {
  it('ends with the next step', () => {
    expect(retiredTaskReport('明日の天気')).toMatch(/もう一度頼んでもらえたら、最初からやり直します。$/u);
  });
});
