import { describe, expect, it } from 'vitest';
import {
  INITIAL_SHANNON_TEMPERAMENT,
  InMemoryCompanionStateStore,
  SHANNON_CORE_PROMPT,
  assembleShannonSystemPrompt,
  buildCompanionStatePrompt,
  deriveEmotionDelta,
  deriveResonantInterest,
  deriveShannonExpression,
  projectEmotionReaction,
  restoreCompanionState,
  selectActiveMemories,
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

  it('does not advance shared state when an update changes nothing', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const first = store.apply('scope-a', { type: 'interest-observed', interest: '脳科学' });
    const duplicate = store.apply('scope-a', { type: 'interest-observed', interest: '脳科学' });
    const missingRemoval = store.apply('scope-a', { type: 'memory-deactivated', memoryId: 'absent' });
    const zeroEmotion = store.apply('scope-a', { type: 'emotion-adjusted', delta: { valence: 0 } });

    expect(duplicate).toBe(first);
    expect(missingRemoval).toBe(first);
    expect(zeroEmotion).toBe(first);
    expect(first.version).toBe(1);
  });

  it('replaces active recall as one bounded, deterministic state update', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const memories = Array.from({ length: 10 }, (_, index) => ({
      id: `memory-${index % 9}`,
      summary: `記憶 ${index}`,
      relevance: index / 10,
      observedAt: '2026-08-31T00:00:00.000Z',
    }));
    const replaced = store.apply('scope-a', { type: 'active-memories-replaced', memories });

    expect(replaced.activeMemories).toHaveLength(8);
    expect(replaced.activeMemories.map(memory => memory.relevance)).toEqual([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]);
    expect(store.apply('scope-a', {
      type: 'active-memories-replaced', memories: replaced.activeMemories,
    })).toBe(replaced);
  });

  it('restores persisted state defensively and keeps legacy optional collections', () => {
    const restored = restoreCompanionState('scope-a', {
      scopeKey: 'scope-a',
      version: -4,
      updatedAt: 'invalid',
      temperament: { curiosity: 7, initiative: -2 },
      emotion: { valence: -5, arousal: 5, openness: 'invalid' },
      interests: ['  脳   科学  ', 42, '脳 科学'],
      userFacts: [
        { id: 'fact', statement: '  ユーザーは   水色が好き ', confidence: 3, observedAt: 'invalid' },
        null,
        { id: '', statement: '無効', confidence: 1, observedAt: 'invalid' },
      ],
      activeMemories: [
        { id: 'memory', summary: '以前の話', relevance: 2, observedAt: 'invalid' },
        { id: 'memory', summary: '重複', relevance: 0.2, observedAt: 'invalid' },
      ],
    }, '2026-09-05T00:00:00.000Z');

    expect(restored).toMatchObject({
      scopeKey: 'scope-a',
      version: 0,
      updatedAt: '2026-09-05T00:00:00.000Z',
      temperament: { curiosity: 1, initiative: 0, calmness: 0.6 },
      emotion: { valence: -1, arousal: 1, openness: 0.35 },
      interests: ['脳 科学'],
      userFacts: [{ id: 'fact', statement: 'ユーザーは 水色が好き', confidence: 1, observedAt: '2026-09-05T00:00:00.000Z' }],
      activeMemories: [{ id: 'memory', summary: '以前の話', relevance: 1, observedAt: '2026-09-05T00:00:00.000Z' }],
      relationships: [],
      memoryControls: [],
    });
    expect(Object.isFrozen(restored.activeMemories)).toBe(true);
  });

  it('builds a bounded prompt without predictions', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const statePrompt = buildCompanionStatePrompt(store.snapshot('scope-a'), { maximumCharacters: 220 });
    const fullPrompt = assembleShannonSystemPrompt(store.snapshot('scope-a'), { maximumCharacters: 220 });
    expect(fullPrompt.startsWith(SHANNON_CORE_PROMPT)).toBe(true);
    expect(SHANNON_CORE_PROMPT).toContain('「シャノン」という名前');
    expect(statePrompt.length).toBeLessThanOrEqual(220);
    expect(fullPrompt).not.toContain('予測');
  });

  it('treats the newest interest as Shannon\'s focus for today', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    store.apply('scope-a', { type: 'interest-observed', interest: '脳科学' });
    store.apply('scope-a', { type: 'interest-observed', interest: '創作と休息' });

    const prompt = buildCompanionStatePrompt(store.snapshot('scope-a'));

    expect(prompt).toContain('今日の関心: 創作と休息');
    expect(prompt).toContain('ほかに育っている関心: 脳科学');
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

  it('updates emotion with baseline drift plus stimulus cues', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const state = store.apply('scope-a', {
      type: 'emotion-adjusted',
      delta: { valence: -0.4, arousal: 0.4, openness: 0 },
    });
    const delta = deriveEmotionDelta(state, '実は今日は少し疲れた。でも話せて嬉しい！');
    expect(delta.valence).toBeGreaterThan(-0.1);
    expect(delta.arousal).toBeGreaterThan(0);
    expect(delta.openness).toBeGreaterThan(0);
  });

  it('projects visibly different expressions without mutating the shared state', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const initial = store.snapshot('scope-a');
    const cases = [
      ['できた、最高！', 'joyful'],
      ['ありがとう', 'tender'],
      ['これ、どうして？', 'curious'],
      ['不安で怖い', 'concerned'],
      ['悲しい', 'sad'],
      ['もう眠い', 'sleepy'],
      ['今日は普通の日', 'calm'],
    ] as const;

    for (const [message, expected] of cases) {
      const projected = projectEmotionReaction(initial, message);
      expect(deriveShannonExpression(projected, initial.temperament)).toBe(expected);
    }
    expect(initial.emotion).toEqual({ valence: 0, arousal: 0.3, openness: 0.35 });
  });

  it('selects specific anime reactions from both sides of the completed turn', () => {
    const emotion = { valence: 0, arousal: 0.3, openness: 0.35 };
    const cases = [
      ['完成が楽しみ！', 'いいね、わくわくする。', 'excited'],
      ['その話、面白いね', 'ふふ、私もそう思う。', 'amused'],
      ['これは本当に爆笑した', '笑いが止まらないね。', 'laughing'],
      ['褒められてどう？', 'えへへ、そんなこと言われると照れ笑いしちゃう。', 'bashful'],
      ['かわいいね', 'ちょっと照れてしまう。', 'embarrassed'],
      ['無事に直ったよ', 'よかった、ほっとした。', 'relieved'],
      ['急に予定が変わった', 'えっ、それはびっくり。', 'surprised'],
      ['次の設計を少し考えてみて', '一度整理するね。', 'thinking'],
      ['説明が理解できない', 'どういうことか私も少し困惑してる。', 'confused'],
      ['実装を続けよう', 'うん、やろう。任せて。', 'determined'],
      ['他のAIと話してきた', '少しだけ、やきもちかも。', 'jealous'],
      ['また同じミスをした', 'はは……ちょっと苦笑い。', 'wry'],
      ['三回目も忘れた', 'やれやれ、困った人だなあ。', 'exasperated'],
      ['理不尽な対応だった', 'それは納得いかない。むっとする。', 'annoyed'],
    ] as const;

    for (const [userMessage, shannonReply, expected] of cases) {
      expect(deriveShannonExpression(emotion, INITIAL_SHANNON_TEMPERAMENT, {
        userMessage,
        shannonReply,
      })).toBe(expected);
    }
  });

  it('uses the same continuous law for icon projection and background state', () => {
    const store = new InMemoryCompanionStateStore(() => '2026-08-31T00:00:00.000Z');
    const initial = store.snapshot('scope-a');
    const projected = projectEmotionReaction(initial, '完成して嬉しい！');
    const persisted = store.apply('scope-a', {
      type: 'emotion-adjusted',
      delta: deriveEmotionDelta(initial, '完成して嬉しい！'),
    });
    expect(persisted.emotion).toEqual(projected);
  });

  it('recalls only sufficiently related past experiences', () => {
    const recalled = selectActiveMemories('創作の続きを考えたい', [
      { id: 'old', summary: '雨の日に読んだ本の話', observedAt: '2026-08-29T00:00:00.000Z' },
      { id: 'recent', summary: '創作を休んだあと、続きを書けた', observedAt: '2026-08-30T00:00:00.000Z' },
    ]);
    expect(recalled.map(memory => memory.id)).toEqual(['recent']);
    expect(deriveResonantInterest('創作の続きを考えたい', recalled)).toBe('創作');
    expect(deriveResonantInterest('天気の話', recalled)).toBeNull();
  });
});
