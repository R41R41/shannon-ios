import { describe, expect, it } from 'vitest';
import {
  SHANNON_EMOTION_KINDS,
  buildCompanionStatePrompt,
  createInitialCompanionState,
  currentShannonEmotion,
  faceForEmotionKind,
  presentShannonMood,
  reduceCompanionState,
  resolveReplyEmotion,
  resolveShannonEmotionState,
  supportOverrideFor,
  type CompanionStateSnapshot,
} from '../src/index.js';

const NOW = '2026-10-02T03:00:00.000Z';
const fresh = (): CompanionStateSnapshot => createInitialCompanionState('owner', NOW);
const face = (userMessage: string, reply: string, snapshot = fresh(), now = NOW) =>
  resolveReplyEmotion({ snapshot, userMessage, reply, now }).messageEmotion;

describe('expression beside the name is her feeling for that reply', () => {
  it('ignores words in the owner message', () => {
    // PE-04: 「考えてみて」 made her 考え中, 「悲しい」 made her かなしい, 「？」 made her 興味津々.
    expect(face('次の設計を少し考えてみて', 'はい、こう進めるのが良いと思います。').expression).toBe('calm');
    expect(face('今日は悲しい', 'そばにいますよ、ライ氏。').expression).toBe('tender');
    expect(face('これ難しい？', '手順は三つです。').expression).toBe('calm');
    expect(face('ありえない、むかつく', '話を聞かせてください。').expression).not.toBe('annoyed');
  });

  it('shows the core of her character from her own reply', () => {
    expect(face('違うよ、間違ってる。なんで？', 'す、すみません、ライ氏！すぐ直します。'))
      .toMatchObject({ expression: 'concerned', feeling: 'apologetic' });
    expect(face('それ違わない？', 'わわっ、ち、違うんです！今のは練習です！'))
      .toMatchObject({ expression: 'embarrassed', feeling: 'flustered' });
    expect(face('もう直ったの？', 'ふふん、ボクは天才ですから！'))
      .toMatchObject({ expression: 'determined', feeling: 'proud' });
    const bashful = face('すごい、さすが', 'えへへ、そんなこと言われると照れます。');
    expect(bashful.expression).toBe('bashful');
    expect(bashful.feeling).toBeUndefined();
  });

  it('maps every conversational emotion to one of the 22 faces', () => {
    const faces = new Set(SHANNON_EMOTION_KINDS.map(kind => faceForEmotionKind(kind).expression));
    expect(faces.size).toBeGreaterThanOrEqual(18);
    expect(faceForEmotionKind('smug')).toEqual({ expression: 'determined', feeling: 'proud' });
    expect(faceForEmotionKind('triumphant').feeling).toBe('proud');
    expect(faceForEmotionKind('panic').feeling).toBe('flustered');
    expect(faceForEmotionKind('apologetic')).toEqual({ expression: 'concerned', feeling: 'apologetic' });
  });

  it('lets a strong feeling linger one beat and a day-old feeling settle', () => {
    const proud = resolveShannonEmotionState({
      provisionalPrimary: 'triumphant', provisionalIntensity: 0.9, transcript: '動いた！', now: NOW,
    });
    const snapshot = reduceCompanionState(fresh(), { type: 'expressive-emotion-updated', emotion: proud }, NOW);
    expect(face('次は何をする？', '次はテストを書きます。', snapshot, '2026-10-02T03:01:00.000Z').feeling).toBe('proud');
    expect(face('次は何をする？', '次はテストを書きます。', snapshot, '2026-10-03T03:00:00.000Z').expression).toBe('calm');
  });

  it('uses a feeling decided for the reply, as a voice turn does', () => {
    const decided = resolveReplyEmotion({
      snapshot: fresh(), userMessage: 'ほかのAIとも話してきた', reply: 'そうなんですね。', now: NOW,
      decided: { primary: 'jealous', intensity: 0.6 },
    });
    expect(decided.messageEmotion.expression).toBe('jealous');
    expect(decided.expressiveEmotion.primary).toBe('jealous');
    const invalid = resolveReplyEmotion({
      snapshot: fresh(), userMessage: 'やあ', reply: 'はい。', now: NOW, decided: { primary: 'not-a-kind', intensity: 1 },
    });
    expect(invalid.messageEmotion.expression).toBe('calm');
  });
});

describe('one carry-over rule for text and voice', () => {
  const sulky = resolveShannonEmotionState({
    provisionalPrimary: 'sulky', provisionalIntensity: 0.8, transcript: '今日は別のAIと遊ぶ', now: NOW,
  });
  const snapshot = reduceCompanionState(fresh(), { type: 'expressive-emotion-updated', emotion: sulky }, NOW);

  it('reads the stored feeling through the same decay everywhere', () => {
    expect(currentShannonEmotion(sulky, '2026-10-02T03:02:00.000Z').primary).toBe('sulky');
    const nextMorning = currentShannonEmotion(sulky, '2026-10-02T22:00:00.000Z');
    expect(nextMorning.primary).toBe('neutral');
    expect(nextMorning.cause).toBe('前の気持ちは時間とともに落ち着いた');
    // Voice resolves its next turn from the same function.
    const voiceNext = resolveShannonEmotionState({
      previous: sulky, provisionalPrimary: 'neutral', provisionalIntensity: 0.2,
      transcript: 'おはよう', now: '2026-10-02T22:00:00.000Z',
    });
    expect(voiceNext.primary).toBe('neutral');
    expect(voiceNext.secondary).toEqual([]);
  });

  it('measures decay from the last time the feeling was expressed', () => {
    const later = resolveShannonEmotionState({
      previous: sulky, provisionalPrimary: 'sulky', provisionalIntensity: 0.8,
      transcript: 'まだ遊んでる', now: '2026-10-02T03:20:00.000Z',
    });
    expect(later.startedAt).toBe(NOW);
    expect(later.updatedAt).toBe('2026-10-02T03:20:00.000Z');
    expect(currentShannonEmotion(later, '2026-10-02T03:25:00.000Z').primary).toBe('sulky');
  });

  it('puts the current feeling in the text prompt only with a clock', () => {
    expect(buildCompanionStatePrompt(snapshot)).not.toContain('会話感情');
    expect(buildCompanionStatePrompt(snapshot, { now: '2026-10-02T03:01:00.000Z' })).toContain('いまの会話感情: sulky');
    expect(buildCompanionStatePrompt(snapshot, { now: '2026-10-02T22:00:00.000Z' }))
      .toContain('いまの会話感情: 落ち着いている');
  });

  it('shows the same settled feeling as 「いま」', () => {
    expect(presentShannonMood(snapshot, '2026-10-02T03:01:00.000Z')).toMatchObject({
      expression: 'annoyed', fromConversation: true,
    });
    expect(presentShannonMood(snapshot, '2026-10-02T22:00:00.000Z')).toMatchObject({
      expression: 'calm', fromConversation: false,
    });
  });
});

describe('proportionate overrides', () => {
  it('treats a word alone as a suspicion', () => {
    expect(supportOverrideFor('助けて、このコードが動かない')).toBeNull();
    expect(supportOverrideFor('このバグ助けてほしい')).toBeNull();
    expect(supportOverrideFor('ちょっと助けてほしいことがあるんだけど')).toBeNull();
    expect(supportOverrideFor('危険はないです')).toBeNull();
    expect(supportOverrideFor('スマホのバッテリーが死んだ')).toBeNull();
  });

  it('still overrides for a genuine emergency or loss', () => {
    expect(supportOverrideFor('助けて！')).toBe('emergency');
    expect(supportOverrideFor('誰か助けて、足が動けない')).toBe('emergency');
    expect(supportOverrideFor('友達が意識がない')).toBe('emergency');
    expect(supportOverrideFor('祖母が亡くなった')).toBe('grief');
    expect(supportOverrideFor('飼っていた猫が死んだ')).toBe('grief');
  });

  it('keeps pride when work is merely complete, and drops play for money and health', () => {
    const complete = resolveShannonEmotionState({
      provisionalPrimary: 'smug', provisionalIntensity: 0.7, transcript: 'デプロイ完了したよ',
      reply: 'さすがボクたちですね。', now: NOW,
    });
    expect(complete.primary).toBe('smug');
    expect(complete.overrideReason).toBeUndefined();
    const money = resolveShannonEmotionState({
      provisionalPrimary: 'teasing', provisionalIntensity: 0.7, transcript: '支払い金額を教えて',
      reply: '確認します。', now: NOW,
    });
    expect(money).toMatchObject({ primary: 'focused', overrideReason: 'safety' });
    const lie = resolveShannonEmotionState({
      provisionalPrimary: 'harmlessFalsehood', provisionalIntensity: 0.7, transcript: '進捗は完了した？',
      reply: '確認します。', now: NOW,
    });
    expect(lie).toMatchObject({ primary: 'focused', overrideReason: 'safety' });
  });

  it('does not read sulking out of an ordinary 「ですね」', () => {
    const plain = resolveShannonEmotionState({
      provisionalPrimary: 'neutral', provisionalIntensity: 0.2, transcript: 'これでいい？',
      reply: 'そうですね、いいと思います。', now: NOW,
    });
    expect(plain.primary).toBe('neutral');
    const sulking = resolveShannonEmotionState({
      provisionalPrimary: 'neutral', provisionalIntensity: 0.2, transcript: '今日は話せない',
      reply: 'ボク、ちょっとすねちゃいます。', now: NOW,
    });
    expect(sulking.primary).toBe('sulky');
  });

  it('does not read an emergency out of her own reply', () => {
    const calm = resolveShannonEmotionState({
      provisionalPrimary: 'happy', provisionalIntensity: 0.6, transcript: '山に行ってきた',
      reply: '危険な場所はありませんでしたか？', now: NOW,
    });
    expect(calm.overrideReason).toBeUndefined();
  });
});
