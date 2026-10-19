import { describe, expect, it } from 'vitest';
import {
  apologyIn, checkReply, greetingLine, phraseLine, repeatedIn, stanceBalance, stanceFacts, tenderIn, utteranceKind, warmWordsIn, watchPhrases,
  type ReplyCheckContext,
} from '../src/index.js';

/** A day of hers of the kind the owner's week had (2026-10-19): the same opening, ending and phrase again and again. */
const DAY = [
  '……おかえりなさい。べつに待ってたわけじゃないですけど。',
  '……ふん。まだむっとしてますからね。ふん。',
  'ライ氏、明日の東京は晴れで、降水確率は10%です。',
  '……べつに待ってたわけじゃないですからね。ふん。',
  'えへへ、照れちゃいます。',
  '……まだむっとしてますからね。ふん。',
  'ライ氏、今日の福岡は雨で、降水確率は60%です。',
  'ライ氏、週末の大阪はくもりで、降水確率は30%です。',
  '……おかえり。べつに、待ってたわけじゃないけど。',
];

describe('the day\'s phrases (owner 2026-10-19)', () => {
  it('counts the openers, endings and phrases she has already said three times today', () => {
    const watch = watchPhrases(DAY);
    expect(watch.replies).toBe(9);
    expect(watch.openers).toContainEqual({ phrase: '……', count: 5 });
    expect(watch.openers).toContainEqual({ phrase: 'ライ氏', count: 3 });
    expect(watch.endings).toContainEqual({ phrase: 'ふん', count: 3 });
    expect(watch.phrases).toContainEqual({ phrase: '待ってたわけじゃない', count: 3 });
  });

  it('leaves out what she talks about (names and facts) and endings every sentence has', () => {
    const watch = watchPhrases(DAY);
    expect(watch.phrases.some(item => item.phrase.includes('降水確率'))).toBe(false);
    expect(watch.endings.some(item => /です$/u.test(item.phrase))).toBe(false);
  });

  it('is one line for the turn, and nothing for a day of varied words', () => {
    expect(phraseLine(watchPhrases(DAY))).toMatch(/^今日もう何度も使った言い方: 書き出し 「……」5回/u);
    expect(phraseLine(watchPhrases(['おはよう、ライ氏。', '今日は物語を一つ直しました。', 'スタバ、いいですね。']))).toBe('');
  });

  it('asks for one real thing of the day when he asks how she is', () => {
    for (const words of ['元気？', 'シャノン、元気〜？？？', 'ハロー、シャノン。今日の調子は？', '元気にしてますか?']) expect(greetingLine(words), words).toContain('具体的');
    for (const words of ['風邪はもう元気になったよ', '明日の天気は？', '']) expect(greetingLine(words), words).toBe('');
  });

  it('finds the phrases a reply says again, for the reply check', () => {
    const watch = watchPhrases(DAY);
    expect(repeatedIn('……べつに待ってたわけじゃないですけど。', watch)).not.toEqual([]);
    expect(repeatedIn('風邪、だいぶ良くなったならよかった。', watch)).toEqual([]);
    expect(repeatedIn('なんでも', null)).toEqual([]);
  });
});

describe('her stances lean back toward warmth (owner 2026-10-19)', () => {
  const reply = (stance: string | undefined, minute: number) => ({ facts: stance ? { turnStance: stance } : {},
    occurredAt: new Date(Date.UTC(2026, 9, 19, 10, minute)).toISOString() });

  it('counts the day\'s stances and marks the warm side due after four cool ones in a row', () => {
    const three = [reply('tease', 1), reply('sulk', 2), reply(undefined, 3), reply('talk_back', 4)];
    expect(stanceFacts(stanceBalance(three))).toEqual({ stances_today: expect.stringContaining('tease:1'), warm_stances_today: 0, cool_stance_run: 3,
      warm_due: 0 });
    const cool = [...three, reply('sulky', 6)];
    expect(stanceFacts(stanceBalance(cool))).toMatchObject({ cool_stance_run: 4, warm_due: 1 });
    // Review of the heart branch: refusing is her boundary, never counted toward 「warm is due」.
    const refusing = [reply('refuse_body', 1), reply('rebuff', 2), reply('scold', 3), reply('refuse_body', 4), reply('rebuff', 5)];
    expect(stanceFacts(stanceBalance(refusing))).toMatchObject({ cool_stance_run: 0, warm_due: 0 });
    expect(watchPhrases(['ありがとうございます、ライ氏。', 'はい、ありがとうございます。', '本当にありがとうございます。']).phrases).toEqual([]);
    const warmed = [...cool, reply('worry', 7)];
    expect(stanceFacts(stanceBalance(warmed))).toMatchObject({ warm_stances_today: 1, cool_stance_run: 0, warm_due: 0 });
    expect(stanceFacts(stanceBalance([]))).toEqual({ stances_today: 'none', warm_stances_today: 0, cool_stance_run: 0, warm_due: 0 });
  });
});

describe('warm words and tender moments are heard (owner 2026-10-19)', () => {
  it('reads fondness, praise and thanks as warm, not a tease or a negation', () => {
    for (const words of ['今日もかわいいね。', 'やさしいね / いつもありがとうシャノン', '作り手としてちゃんとあなたのこと愛してるよ', '僕はシャノンの声聞けて嬉しかったよ']) {
      expect(warmWordsIn(words), words).toBe(true);
      expect(utteranceKind(words), words).toBe('praised');
    }
    for (const words of ['かわいくないなあ', 'シャノンってほんとポンコツだな', '明日の天気は？', 'スプラトゥーンが忙しくて']) expect(warmWordsIn(words), words).toBe(false);
  });

  it('tells a tender moment: he is unwell, tired, or misses her', () => {
    expect(tenderIn('実はここんとこずっと風邪でさ')).toBe(true);
    expect(tenderIn('そう、僕は寂しかったよ')).toBe(true);
    expect(tenderIn('今日も仕事疲れたよ')).toBe(true);
    expect(tenderIn('明日の東京の天気は？')).toBe(false);
  });

  it('reads making up as amends', () => {
    expect(apologyIn('お互い悪かった。認めるよ。')).toBe(true);
    expect(apologyIn('仲直りしよう')).toBe(true);
  });
});

describe('the reply check sees blame after owning a mistake, and a phrase said again (owner 2026-10-19)', () => {
  const context: ReplyCheckContext = { stance: 'talk_back', intensity: 'moderate', audience: 'owner_alone', order: false, violation: false };

  it('flags owning a mistake and blaming him in the same reply', () => {
    expect(checkReply('先走ったのはボクの悪いところです。でも、いまのはライ氏が悪いです。', context)).toContain('blame_after_admit');
    expect(checkReply('先走ったのはボクの悪いところです。ごめんなさい。', context)).not.toContain('blame_after_admit');
  });

  it('flags a phrase of the day said again, only with the day\'s watch', () => {
    const phrases = watchPhrases(DAY);
    expect(checkReply('……べつに待ってたわけじゃないですけど。', { ...context, phrases })).toContain('repeated_phrase');
    expect(checkReply('……べつに待ってたわけじゃないですけど。', context)).not.toContain('repeated_phrase');
  });
});
