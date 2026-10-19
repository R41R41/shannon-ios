import { describe, expect, it } from 'vitest';
import {
  createInitialCompanionState, deriveEmotionDelta, deriveResonantInterest, followUpLine, followUpTopics, isTopicNoun, reduceCompanionState, topicsOf,
} from '../src/index.js';
import { feelingMoodStep } from '../src/feelingMood.js';
import type { ShannonExpressiveEmotion } from '../src/types.js';

describe('what he talked about, to come back to (owner 2026-10-19, item 11)', () => {
  it('reads topics as nouns: a place, a game, his health', () => {
    expect(topicsOf('土曜日から福岡に行ってたんだ。')).toEqual(['福岡']);
    expect(topicsOf('ごめん、今ちょっとスプラトゥーンが忙しくて。')).toEqual(['スプラトゥーン']);
    expect(topicsOf('実はここんとこずっと風邪でさ')).toEqual(['風邪']);
    expect(topicsOf('今はスタバにいる〜')).toEqual(['スタバ']);
    expect(topicsOf('今日もかわいいね')).toEqual([]);
  });

  it('is never 「よかった」「すごい」「かわいい」', () => {
    for (const word of ['よかった', 'すごい', 'かわいい', 'ちゃん', '嬉しい', '今日']) expect(isTopicNoun(word), word).toBe(false);
    for (const word of ['福岡', 'スプラトゥーン', '風邪', 'typescript']) expect(isTopicNoun(word), word).toBe(true);
    expect(deriveResonantInterest('すごい', [{ summary: 'すごい' }])).toBeNull();
    // Review of the heart branch: a word all in hiragana may still be a topic of hers.
    expect(deriveResonantInterest('うどんが食べたい', [{ summary: 'うどんが好き' }])).toBe('うどん');
    expect(topicsOf('来週福岡に行く')).toEqual(['福岡']);
    expect(topicsOf('ずっと心配してたんだ')).toEqual([]);
    expect(deriveResonantInterest('福岡の天気', [{ summary: '福岡に行った' }])).toBe('福岡');
  });

  it('offers what he talked about before today and not again today, newest first', () => {
    const messages = [
      { text: '土曜日から福岡に行ってたんだ。', at: '2026-10-13T09:09:00.000Z' },
      { text: 'ごめん、今ちょっとスプラトゥーンが忙しくて。', at: '2026-10-14T14:42:00.000Z' },
      { text: 'スプラトゥーンやってる', at: '2026-10-15T10:00:00.000Z' },
    ];
    expect(followUpTopics(messages, '2026-10-14T18:00:00.000Z')).toEqual([
      { topic: '福岡', at: '2026-10-13T09:09:00.000Z' },
    ]);
    expect(followUpLine([{ topic: '福岡', at: '2026-10-13T09:09:00.000Z' }])).toContain('福岡（10/13）');
    expect(followUpLine([])).toBe('');
  });
});

describe('her numeric mood (owner 2026-10-19, item 15)', () => {
  const at = '2026-10-19T10:00:00.000Z';

  it('is not raised by a question mark on the awake clock', () => {
    const state = createInitialCompanionState('owner', at);
    expect(deriveEmotionDelta(state, '明日の天気は？').arousal ?? 0).toBeCloseTo(deriveEmotionDelta(state, '明日の天気は').arousal ?? 0);
  });

  it('is drawn toward a shown feeling of her own, never by a tone or a hidden one', () => {
    const feeling = (primary: ShannonExpressiveEmotion['primary'], extra: Partial<ShannonExpressiveEmotion> = {}): ShannonExpressiveEmotion => ({
      primary, secondary: [], intensity: 0.8, target: 'owner', cause: 'test', arousal: 0.7, valence: -0.5, visibility: 'expressed',
      startedAt: at, decay: 0.5, carryover: 0.5, ...extra });
    const mood = { valence: 0, arousal: 0.3 };
    const step = feelingMoodStep(mood, feeling('indignant'))!;
    expect(step.valence).toBeLessThan(0);
    expect(step.arousal).toBeGreaterThan(0);
    expect(feelingMoodStep(mood, feeling('bright'))).toBeNull();
    expect(feelingMoodStep(mood, feeling('annoyed', { visibility: 'hidden' }))).toBeNull();
    expect(feelingMoodStep(mood, feeling('apologetic'))).toBeNull();
    const state = createInitialCompanionState('owner', at);
    const next = reduceCompanionState(state, { type: 'expressive-emotion-updated', emotion: feeling('annoyed') }, at);
    expect(next.emotion.valence).toBeLessThan(state.emotion.valence);
  });
});
