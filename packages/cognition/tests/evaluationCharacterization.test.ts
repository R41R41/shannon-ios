import { describe, expect, it } from 'vitest';
import {
  buildCompanionStatePrompt,
  createInitialCompanionState,
  reduceCompanionState,
  restoreCompanionState,
  selectContextualMemories,
} from '../src/index.js';

const now = '2026-09-26T00:00:00.000Z';

describe('cognitive evaluation characterization boundaries', () => {
  it('replays the same event list to the same frozen snapshot', () => {
    const events = [
      { type: 'interest-observed' as const, interest: '分散システム' },
      { type: 'emotion-adjusted' as const, delta: { valence: 0.4, arousal: 0.2 } },
    ];
    const replay = () => events.reduce(
      (state, event) => reduceCompanionState(state, event, now),
      createInitialCompanionState('synthetic:replay', now),
    );
    expect(replay()).toEqual(replay());
    expect(Object.isFrozen(replay())).toBe(true);
  });

  it('restores malformed persisted state through safe defaults', () => {
    const restored = restoreCompanionState('synthetic:restore', {
      scopeKey: 'synthetic:restore', version: -1,
      emotion: { valence: 8, arousal: Number.NaN, openness: 'secret' },
      interests: [null, '写真', '写真'],
    }, now);
    expect(restored.version).toBe(0);
    expect(restored.emotion).toEqual({ valence: 1, arousal: 0.3, openness: 0.35 });
    expect(restored.interests).toEqual(['写真']);
  });

  it('keeps forgotten and rejected evidence out of the prompt projection', () => {
    const state = restoreCompanionState('synthetic:memory', {
      ...createInitialCompanionState('synthetic:memory', now),
      userFacts: [{ id: 'forgotten', statement: 'ユーザーは猫が好き', confidence: 1, observedAt: now }],
      activeMemories: [{ id: 'rejected', summary: '拒否された記憶', relevance: 1, observedAt: now }],
      memoryControls: [
        { memoryId: 'forgotten', kind: 'user-fact', status: 'forgotten', pinned: false, updatedAt: now, changeReason: 'test' },
        { memoryId: 'rejected', kind: 'experience', status: 'rejected', pinned: false, updatedAt: now, changeReason: 'test' },
      ],
    }, now);
    const prompt = buildCompanionStatePrompt(state);
    expect(prompt).not.toContain('猫が好き');
    expect(prompt).not.toContain('拒否された記憶');
  });

  it('keeps contextual recall stable when candidate input order changes', () => {
    const query = { text: '浜松の写真', occurredAt: now };
    const candidates = [
      { id: 'recent', summary: '浜松で写真を整理した', observedAt: '2026-09-25T00:00:00.000Z' },
      { id: 'old', summary: '昔の写真を整理した', observedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const ids = (values: typeof candidates) => selectContextualMemories(query, values).map(memory => memory.id);
    expect(ids(candidates)).toEqual(ids([...candidates].reverse()));
  });
});
