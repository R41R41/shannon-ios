import { describe, expect, it } from 'vitest';
import {
  SHANNON_EMOTION_KINDS,
  SHANNON_EMOTION_TIME,
  createInitialCompanionState,
  createShannonMessageEmotion,
  deriveShannonFace,
  faceForEmotionKind,
  messageEmotionKind,
  resolveReplyEmotion,
  type ShannonExpressiveEmotion,
} from '../src/index.js';

const NOW = '2026-10-05T03:00:00.000Z';
const MOOD = { valence: 0.1, arousal: 0.4, openness: 0.4 };
const feeling = (primary: ShannonExpressiveEmotion['primary'], visibility: ShannonExpressiveEmotion['visibility'] = 'expressed'): ShannonExpressiveEmotion => ({
  primary, secondary: [], intensity: 0.6, target: 'ライ氏', cause: 'テスト', arousal: 0.5, valence: 0.2,
  visibility, startedAt: NOW, decay: 0.5, carryover: 0.5,
});
const reply = (text: string, userMessage = 'もうできたの？') => resolveReplyEmotion({
  snapshot: createInitialCompanionState('owner', NOW), userMessage, reply: text, now: NOW, timing: SHANNON_EMOTION_TIME,
}).messageEmotion;

describe('the kind beside the face (owner decision 2026-10-05)', () => {
  it('names the feeling that decided the face, for every kind but neutral, and leaves the face as it was', () => {
    for (const kind of SHANNON_EMOTION_KINDS.filter(value => value !== 'neutral')) {
      const emotion = createShannonMessageEmotion(MOOD, feeling(kind));
      expect(emotion.kind).toBe(kind);
      const { kind: _kind, valence: _v, arousal: _a, openness: _o, ...face } = emotion;
      expect(face).toEqual(faceForEmotionKind(kind));
      expect(face).toEqual(deriveShannonFace(MOOD, feeling(kind)));
    }
  });

  it('is absent when the face comes from the quiet mood: no feeling, a neutral one, or a hidden one', () => {
    for (const quiet of [undefined, feeling('neutral'), feeling('jealous', 'hidden')]) {
      const emotion = createShannonMessageEmotion(MOOD, quiet);
      expect(emotion).not.toHaveProperty('kind');
      expect(messageEmotionKind(quiet)).toBeUndefined();
      expect(emotion.expression).toBe(deriveShannonFace(MOOD).expression);
    }
    expect(messageEmotionKind(feeling('jealous', 'subtle'))).toBe('jealous');
  });

  it('comes with a resolved reply: a cue in her words gives the kind, a plain reply gives none', () => {
    expect(reply('ふふん、ボクは天才ですから！')).toMatchObject({ expression: 'determined', feeling: 'proud', kind: 'smug' });
    const plain = reply('はい、こう進めるのが良いと思います。', '次の設計を少し考えてみて');
    expect(plain.expression).toBe('calm');
    expect(plain).not.toHaveProperty('kind');
  });
});
