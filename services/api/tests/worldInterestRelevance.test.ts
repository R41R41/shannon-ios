import { describe, expect, it } from 'vitest';
import { groundedWorldOpening, topicMatchesSource } from '../src/worldInterestRelevance.js';
import { firstInterest } from '../src/initiativeSelection.js';

describe('world source grounding', () => {
  it('filters old conversation noise before selecting a focus', () => {
    expect(firstInterest(['うん', '聞こえますか', 'えっ', '写真'])).toBe('写真');
  });
  it('requires a real topical link, with bounded bilingual aliases', () => {
    expect(topicMatchesSource('写真', 'Biome noReactObject lint rule')).toBe(false);
    expect(topicMatchesSource('写真', 'A new approach to photography')).toBe(true);
    expect(topicMatchesSource('AIエージェントの記憶', 'AI agent memory architecture')).toBe(true);
    expect(topicMatchesSource('AIエージェントの記憶', 'AI raises the price of GPUs')).toBe(false);
    expect(topicMatchesSource('うん', 'うん')).toBe(false);
    expect(topicMatchesSource('AI', 'A comfortable chair for reading')).toBe(false);
    expect(topicMatchesSource('AI', 'AI: new research')).toBe(true);
  });
  it('retains grounded personality wording but never fabricates a shared conversation', () => {
    expect(groundedWorldOpening('写真の光の捉え方、ちょっと気になる。', '写真の撮り方', '写真'))
      .toBe('写真の光の捉え方、ちょっと気になる。');
    expect(groundedWorldOpening('昨日の写真の話とつながっていた。', '写真の撮り方', '写真'))
      .toBe('これ、少し気になりました。');
    expect(groundedWorldOpening('最近、どんな写真を撮ってる？', 'Biome lint rule', null))
      .toBe('これ、少し気になりました。');
  });
});
