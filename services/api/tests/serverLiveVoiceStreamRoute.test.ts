import { describe, expect, it } from 'vitest';
import { SpokenSentenceSegmenter } from '../src/serverLiveVoiceStreamRoute.js';

describe('live voice sentence streaming', () => {
  it('emits complete Japanese sentences across arbitrary model deltas', () => {
    const segmenter = new SpokenSentenceSegmenter();

    expect(segmenter.append('聞こえて')).toEqual([]);
    expect(segmenter.append('るよ。「ここ')).toEqual(['聞こえてるよ。']);
    expect(segmenter.append('にいる！」次')).toEqual(['「ここにいる！」']);
    expect(segmenter.flush()).toEqual(['次']);
  });

  it('treats newlines as safe speech boundaries and removes layout whitespace', () => {
    const segmenter = new SpokenSentenceSegmenter();

    expect(segmenter.append('まず答えるね。\n  続き')).toEqual(['まず答えるね。']);
    expect(segmenter.flush()).toEqual(['続き']);
  });
});
