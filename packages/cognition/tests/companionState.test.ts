import { describe, expect, it } from 'vitest';
import {
  INITIAL_SHANNON_TEMPERAMENT,
  InMemoryCompanionStateStore,
  SHANNON_CORE_PROMPT,
  assembleShannonSystemPrompt,
  buildCompanionStatePrompt,
  deriveShannonExpression,
} from '../src/index.js';

describe('Shannon companion shared state', () => {
  it('starts with the adopted temperament', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const state = store.snapshot('owner:conversation');
    expect(state.temperament).toEqual(INITIAL_SHANNON_TEMPERAMENT);
    expect(state.temperament).toEqual({
      curiosity: 0.65, initiative: 0.25, closeness: 0.15, calmness: 0.60,
      needForContinuity: 0.70, confidenceAboutUser: 0.05,
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('updates sequentially without mutating captured FCA snapshots', () => {
    let tick = 0;
    const store = new InMemoryCompanionStateStore(() => `2026-08-31T00:00:0${tick++}.000Z`);
    const captured = store.snapshot('scope-a');
    const afterEmotion = store.apply('scope-a', { type: 'emotion-adjusted', delta: { valence: 0.4, arousal: 0.8 } });
    const afterMemory = store.apply('scope-a', {
      type: 'memory-activated',
      memory: { id: 'm1', summary: 'ユーザーは静かな朝が好き', relevance: 0.9, observedAt: '2026-08-31T00:00:00.000Z' },
    });
    expect(captured.version).toBe(0);
    expect(captured.activeMemories).toEqual([]);
    expect(afterEmotion.emotion).toEqual({ valence: 0.4, arousal: 1, openness: 0.35 });
    expect(afterMemory.version).toBe(2);
  });

  it('isolates state with adapter-owned scope keys', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    store.apply('user-a', { type: 'interest-observed', interest: '脳科学' });
    expect(store.snapshot('user-a').interests).toEqual(['脳科学']);
    expect(store.snapshot('user-b').interests).toEqual([]);
  });

  it('builds a bounded prompt without predictions', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const statePrompt = buildCompanionStatePrompt(store.snapshot('scope-a'), { maximumCharacters: 220 });
    const fullPrompt = assembleShannonSystemPrompt(store.snapshot('scope-a'), { maximumCharacters: 220 });
    expect(fullPrompt.startsWith(SHANNON_CORE_PROMPT)).toBe(true);
    expect(statePrompt.length).toBeLessThanOrEqual(220);
    expect(fullPrompt).not.toContain('予測');
  });

  it('derives stable message expressions from the captured emotion', () => {
    expect(deriveShannonExpression(
      { valence: 0.7, arousal: 0.8, openness: 0.5 },
      INITIAL_SHANNON_TEMPERAMENT,
    )).toBe('joyful');
    expect(deriveShannonExpression(
      { valence: -0.5, arousal: 0.7, openness: 0.2 },
      INITIAL_SHANNON_TEMPERAMENT,
    )).toBe('concerned');
    expect(deriveShannonExpression(
      { valence: 0, arousal: 0.3, openness: 0.35 },
      INITIAL_SHANNON_TEMPERAMENT,
    )).toBe('calm');
  });
});
