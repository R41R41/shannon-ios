import { describe, expect, it } from 'vitest';
import { extractExplicitUserIntent } from '../src/mind/action/respond/cognitiveIntent.js';

const at = '2026-09-24T01:00:00.000Z';
const goal = (text: string) => extractExplicitUserIntent(text, 'thread', at);

describe('ordinary goal phrasings (TM-04)', () => {
  it.each([
    'Shannon Deskを今月中に配信したい',
    'この画面を完成させたい',
    '記憶の同期を実装したいです',
    'シャノンの音声機能を作りたい',
    '毎日30分走りたい',
    '今年中に英語の本を一冊読み切りたい',
    '年内にTestFlightへ公開したいと思っています',
    'いつか自分のアプリをリリースしたい',
    '将来はエンジニアになりたい',
    '週に3回ジムに通いたいんだ',
    'こんにちは。Shannon Deskを今月中に配信したい。',
    '目標は今月中にShannon Deskを配信すること',
    'シャノンの人格表現を改善したい',
  ])('captures %s as an explicit owner goal', text => {
    expect(goal(text)).toMatchObject({ status: 'active', source: 'explicit-user-goal', threadId: 'thread' });
  });

  it('keeps the goal sentence, not the greeting around it, as the title', () => {
    expect(goal('こんにちは。Shannon Deskを今月中に配信したい。')?.title).toBe('Shannon Deskを今月中に配信したい');
  });

  it.each([
    // negations and stopping
    'Shannon Deskを配信したくない', 'もう開発をやめたい', '配信するつもりはない',
    // questions and tentative thoughts
    'Shannon Deskを配信したい？', '今月中に配信したいかな', '配信したいかも',
    // hypotheticals and hearsay
    'もし時間があれば実装したい', '時間ができたら完成させたい', '「実装したい」と友人が言った',
    // other people's goals
    '彼はアプリを配信したい', '田中さんは今月中に公開したいらしい',
    // passing wishes and near-term plans (the promise rules own these)
    'ラーメン食べたい', '早く帰りたい', 'カレーを作りたい', '日本料理を作りたい', 'いつか寿司を食べたい',
    '毎日ラーメン食べたい', '明日プレゼンの練習をしたい', '今日中に資料を完成させたい', 'あとで部屋を整理したい',
    // vague continuation
    'お願いします', '続けてください',
  ])('does not capture %s', text => {
    expect(goal(text)).toBeNull();
  });
});
