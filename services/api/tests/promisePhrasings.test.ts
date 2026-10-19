import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { commitmentDeadline } from '../src/mind/action/respond/commitmentTime.js';
import {
  EXACT_TIME_NOTE,
  exactTimeNote,
  extractPromiseCaptures,
  extractProspectiveMemories,
  requestsExactTimeAlert,
} from '../src/mind/memory/prospectiveMemory.js';
import { captureImmediateExplicitMemory } from '../src/mind/sleep/sleepConsolidation.js';

// Thursday 2026-09-24 10:00 in Tokyo.
const at = '2026-09-24T01:00:00.000Z';
const promise = (text: string) => extractPromiseCaptures(text, at)[0];

describe('ordinary promise phrasings (TM-03)', () => {
  it.each([
    // [utterance, due date, short topic]
    ['明日の朝、プレゼンの練習しよう', '2026-09-25', 'プレゼンの練習'],
    ['明日の朝、プレゼンの練習します', '2026-09-25', 'プレゼンの練習'],
    ['明日の朝、プレゼンの練習しましょう', '2026-09-25', 'プレゼンの練習'],
    ['明日は早起きする', '2026-09-25', '早起き'],
    ['明日病院に行く', '2026-09-25', '病院に行く'],
    ['明日病院に行きます', '2026-09-25', '病院に行きます'],
    ['明日やります', '2026-09-25', 'やります'],
    ['今夜やろう', '2026-09-24', 'やろう'],
    ['じゃあ明日プレゼンの練習しよう', '2026-09-25', 'プレゼンの練習'],
    ['プレゼンの練習を明日しよう', '2026-09-25', 'プレゼンの練習'],
    ['明日までにレポートを書く', '2026-09-25', 'レポートを書く'],
    ['明日、田中さんの資料をレビューする', '2026-09-25', '田中さんの資料をレビュー'],
    ['3日後に歯医者に行く', '2026-09-27', '歯医者に行く'],
    ['月末に家賃を払う', '2026-09-30', '家賃を払う'],
    ['今日は疲れたから明日やる', '2026-09-25', 'やる'],
    ['明日は実家に帰るつもりです', '2026-09-25', '実家に帰るつもりです'],
    ['明日は早く寝る', '2026-09-25', '早く寝る'],
    ['明日映画を見よう', '2026-09-25', '映画を見よう'],
  ])('captures %s', (text, dueDate, topic) => {
    const captured = promise(text);
    expect(captured?.memory).toMatchObject({ summary: text, status: 'pending', dueDate });
    expect(captured?.topic).toBe(topic);
  });

  it.each([
    ['あとで部屋の掃除したい', 'あとで', '部屋の掃除'],
    ['あとで買い物リスト作りたい', 'あとで', '買い物リスト作りたい'],
    ['来月旅行の計画を立てる', '来月', '旅行の計画を立てる'],
    ['再来週また話そう', '再来週', 'また'],
  ])('keeps an undated promise as a hint: %s', (text, dueHint, topic) => {
    const captured = promise(text);
    expect(captured?.memory).toMatchObject({ dueHint });
    expect(captured?.memory.dueDate).toBeUndefined();
    expect(captured?.topic).toBe(topic);
  });

  it.each([
    ['牛乳を買うのを忘れないで', '牛乳を買う'],
    ['薬を飲むの覚えといて', '薬を飲む'],
    ['傘を忘れないで', '傘'],
    ['田中さんの誕生日プレゼントを買うのを忘れないで', '田中さんの誕生日プレゼントを買う'],
  ])('captures an explicit reminder: %s', (text, topic) => {
    expect(promise(text)?.topic).toBe(topic);
  });

  it.each([
    // negations and cancellations
    '明日は病院に行かない', '明日はやりません', '明日の練習はやめる', '明日の予約をキャンセルする', '明日は行かないことにする',
    // questions and tentative suggestions
    '明日病院に行く？', '明日の朝、プレゼンの練習しようか', '明日行こうかな', '明日図書館に行くの',
    // hypotheticals, guesses, hearsay
    'もし晴れたら明日散歩する', '明日晴れたら散歩する', '明日はたぶん行く', '明日は行くと思う', '明日は雨が降るらしい',
    // other people's plans and things that merely happen
    '母は明日病院に行く', '田中さんが明日来る', '明日友達が遊びに来る', '明日は雨が降る', '明日荷物が届く', '明日は会議がある',
    '明日は雨になる', '明日は晴れる', '明日には治る', '明日は家にいる', '明日は仕事している',
    // information requests about a day, greetings, wishes that are not actions
    '明日の天気を教えて', '明日の予定を確認して', '明日もよろしくお願いします', '明日は寿司が食べたい', '明日は雨みたい', '明日は冷たい',
    // quoted or past
    '「明日やる」と友人が言った', '昨日病院に行った', '明日は休みです',
    // no day and no object
    'あとでやる', '後でやります', '今度やる', '病院に行く',
  ])('does not capture %s', text => {
    expect(extractProspectiveMemories(text, at)).toEqual([]);
  });

  it('resolves the widened time words against the utterance', () => {
    expect(commitmentDeadline('今夜やろう', at)).toMatchObject({ dueDate: '2026-09-24', dueHint: '今夜' });
    expect(commitmentDeadline('明日の夜に電話する', at)).toMatchObject({ dueDate: '2026-09-25', dueHint: '明日の夜' });
    expect(commitmentDeadline('今月中に申請する', at)).toMatchObject({ dueDate: '2026-09-30' });
    expect(commitmentDeadline('2週間後に点検する', at)).toMatchObject({ dueDate: '2026-10-08' });
    expect(commitmentDeadline('来月末に引っ越す', at)).toEqual({ timeZone: 'Asia/Tokyo', dueHint: '来月' });
    expect(commitmentDeadline('30分後に出かける', at)).toMatchObject({ dueAt: '2026-09-24T01:30:00.000Z', dueDate: '2026-09-24' });
  });
});

describe('exact-time requests (AB-06)', () => {
  it('stores a time-bound request with a plain limit instead of pretending to be an alarm', () => {
    const wake = promise('明日8時に起こして');
    expect(wake?.memory).toMatchObject({ dueDate: '2026-09-25', dueAt: '2026-09-24T23:00:00.000Z' });
    expect(wake).toMatchObject({ topic: '起こして', note: exactTimeNote() });
    expect(promise('明日の10時に写真整理をリマインドして')).toMatchObject({ note: exactTimeNote() });
    expect(exactTimeNote(false)).toBe(EXACT_TIME_NOTE);
    expect(exactTimeNote(true)).toContain('スマホの目覚まし');
    expect(promise('明日の朝起こして')?.note).toBeUndefined();
    expect(promise('明日プレゼンの練習しよう')?.note).toBeUndefined();
  });

  it.each(['30分後に教えて', '2時間後に起こして', '10分たったら教えて', 'タイマーかけて', '3分のタイマーをセットして', 'アラームをかけてください'])(
    'declines %s without storing a promise', text => {
      expect(requestsExactTimeAlert(text)).toBe(true);
      expect(extractProspectiveMemories(text, at)).toEqual([]);
    });

  it.each(['30分後に出かける', 'タイマーって便利だよね', '30分後に教えてくれる？', 'もし30分後に教えてと言ったら', '明日8時に起こして'])(
    'does not treat %s as a declined alarm', text => {
      expect(requestsExactTimeAlert(text)).toBe(false);
    });
});

describe('remember requests about facts and preferences (TM-06)', () => {
  const state = () => new InMemoryCompanionStateStore(() => at).snapshot('owner');

  it.each([
    ['僕は寿司が好き。特に光り物、覚えておいて', ['ユーザーは寿司が好き', 'ユーザーは寿司の中でも特に光り物が好き']],
    ['寿司は光り物が好き、覚えておいて', ['ユーザーは寿司は光り物が好き']],
    ['僕は辛いものが苦手、覚えておいてね', ['ユーザーは辛いものが苦手']],
    ['コーヒーはブラック派、覚えといて', ['ユーザーはコーヒーはブラック派']],
    ['誕生日は3月5日、覚えておいて', ['ユーザーの誕生日は3月5日']],
    ['合言葉はひまわり、覚えておいて', ['合言葉はひまわり']],
    ['僕は甘いものが苦手、忘れないで', ['ユーザーは甘いものが苦手']],
  ])('keeps %s as knowledge, not as an undated promise', (text, statements) => {
    expect(captureImmediateExplicitMemory(text, state(), at).facts.map(fact => fact.statement)).toEqual(statements);
    expect(extractProspectiveMemories(text, at)).toEqual([]);
  });

  it.each([
    '特に光り物、覚えておいて',           // a fragment with nothing to attach to
    '鍵の場所を覚えておいて',             // a bare noun is neither a fact nor a promise
    '田中さんは寿司が好き、覚えておいて', // another person's preference is not owner knowledge
    '「僕は寿司が好き」を覚えておいて',   // a quotation
    'もし寿司が好きなら覚えておいて',     // a hypothetical
  ])('captures nothing for %s', text => {
    expect(captureImmediateExplicitMemory(text, state(), at).facts).toEqual([]);
    expect(extractProspectiveMemories(text, at)).toEqual([]);
  });
});
