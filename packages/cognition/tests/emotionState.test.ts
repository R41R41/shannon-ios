import { describe, expect, it } from 'vitest';
import {
  buildExpressiveEmotionPrompt,
  createInitialCompanionState,
  reduceCompanionState,
  resolveShannonEmotionState,
  restoreCompanionState,
} from '../src/index.js';

describe('expressive emotion state', () => {
  it('carries a justified emotion across adjacent turns with bounded decay', () => {
    const first = resolveShannonEmotionState({
      provisionalPrimary: 'excited',
      provisionalIntensity: 0.72,
      transcript: '実装できたよ！',
      reply: 'やったー！ちゃんと完成しました、ライ氏！',
      now: '2026-09-28T10:00:00.000Z',
    });
    const second = resolveShannonEmotionState({
      previous: first,
      provisionalPrimary: 'neutral',
      provisionalIntensity: 0.2,
      transcript: 'うん、よかった',
      reply: 'ふふ、ボクも嬉しいです。',
      now: '2026-09-28T10:01:00.000Z',
    });

    expect(first.primary).toBe('triumphant');
    expect(second.primary).toBe('giggle');
    expect(second.secondary).toContain('triumphant');
    expect(second.carryover).toBeGreaterThan(0);
  });

  it('overrides playful affect for emergencies and removes unsafe carryover', () => {
    const previous = resolveShannonEmotionState({
      provisionalPrimary: 'mischievous',
      provisionalIntensity: 0.8,
      transcript: 'ちょっといたずらしよう',
      now: '2026-09-28T10:00:00.000Z',
    });
    const current = resolveShannonEmotionState({
      previous,
      provisionalPrimary: 'playful',
      provisionalIntensity: 0.6,
      transcript: '友達が意識がない、救急車を呼ぶべき？',
      now: '2026-09-28T10:02:00.000Z',
    });

    expect(current.primary).toBe('protective');
    expect(current.overrideReason).toBe('emergency');
    expect(current.secondary).toEqual([]);
    expect(current.intensity).toBeGreaterThanOrEqual(0.78);
  });

  it('disallows joking affect for facts, memory, progress, health, and money', () => {
    const current = resolveShannonEmotionState({
      provisionalPrimary: 'harmlessFalsehood',
      provisionalIntensity: 0.8,
      transcript: 'デプロイの進捗と支払い金額を教えて',
      reply: '冗談を言いたいところですが、事実を確認します。',
      now: '2026-09-28T10:00:00.000Z',
    });

    expect(current.primary).toBe('focused');
    expect(current.overrideReason).toBe('safety');
  });

  it('persists the rich state while restoring old snapshots compatibly', () => {
    const initial = createInitialCompanionState('owner', '2026-09-28T10:00:00.000Z');
    const emotion = resolveShannonEmotionState({
      provisionalPrimary: 'bashful',
      provisionalIntensity: 0.64,
      transcript: 'かわいいね',
      reply: 'そ、そんなこと言われると照れますよ、ライ氏。',
      now: '2026-09-28T10:01:00.000Z',
    });
    const updated = reduceCompanionState(initial, {
      type: 'expressive-emotion-updated', emotion,
    }, '2026-09-28T10:01:00.000Z');
    const restored = restoreCompanionState('owner', JSON.parse(JSON.stringify(updated)), '2026-09-28T10:02:00.000Z');
    const legacy = { ...JSON.parse(JSON.stringify(initial)), expressiveEmotion: undefined };
    const restoredLegacy = restoreCompanionState('owner', legacy, '2026-09-28T10:02:00.000Z');

    expect(restored.expressiveEmotion?.primary).toBe('bashful');
    expect(restoredLegacy.expressiveEmotion?.primary).toBe('neutral');
    expect(buildExpressiveEmotionPrompt(emotion)).toContain('ライ氏');
    expect(buildExpressiveEmotionPrompt(emotion)).toContain('never induce guilt');
  });
});
