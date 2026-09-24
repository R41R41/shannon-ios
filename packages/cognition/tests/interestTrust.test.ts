import { describe, expect, it } from 'vitest';
import { deriveResonantInterest } from '../src/recall.js';

describe('interest quality', () => {
  it.each(['うん', '聞こえますか', '思ってるんだ', 'こん', 'えっ', 'ちょっ', '喋ってみて', '聞こえる', 'シャノン'])('does not promote conversational noise: %s', text => {
    expect(deriveResonantInterest(text, [{ summary: text }])).toBeNull();
  });
  it.each(['写真', 'アニメ', '分散システム', '映画', 'AI agents'])('keeps meaningful recurring topics: %s', text => {
    expect(deriveResonantInterest(text, [{ summary: text }])).toBe(text.toLowerCase());
  });
});
