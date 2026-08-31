import type { ShannonEmotion, ShannonTemperament } from './types.js';

export type ShannonExpression =
  | 'joyful'
  | 'curious'
  | 'tender'
  | 'calm'
  | 'concerned'
  | 'sad'
  | 'sleepy'
  | 'neutral';

export interface ShannonMessageEmotion {
  valence: number;
  arousal: number;
  openness: number;
  expression: ShannonExpression;
}

export function deriveShannonExpression(
  emotion: ShannonEmotion,
  temperament: ShannonTemperament,
): ShannonExpression {
  if (emotion.valence >= 0.45 && emotion.arousal >= 0.5) return 'joyful';
  if (emotion.valence <= -0.35 && emotion.arousal >= 0.5) return 'concerned';
  if (emotion.valence <= -0.3) return 'sad';
  if (emotion.arousal <= 0.18) return 'sleepy';
  if (emotion.valence >= 0.22 && emotion.openness >= 0.5) return 'tender';
  if (temperament.curiosity >= 0.7 && emotion.arousal >= 0.38) return 'curious';
  if (temperament.calmness >= 0.55 && emotion.arousal <= 0.42) return 'calm';
  return 'neutral';
}

export function createShannonMessageEmotion(
  emotion: ShannonEmotion,
  temperament: ShannonTemperament,
): ShannonMessageEmotion {
  return {
    ...emotion,
    expression: deriveShannonExpression(emotion, temperament),
  };
}
