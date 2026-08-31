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
  if (emotion.valence >= 0.24 && emotion.arousal >= 0.4) return 'joyful';
  if (emotion.valence <= -0.24 && emotion.arousal >= 0.36) return 'concerned';
  if (emotion.valence <= -0.14) return 'sad';
  if (emotion.arousal <= 0.2) return 'sleepy';
  if (emotion.valence >= 0.1 && emotion.openness >= 0.37) return 'tender';
  if (temperament.curiosity >= 0.6 && emotion.arousal >= 0.36) return 'curious';
  if (temperament.calmness >= 0.55 && emotion.arousal <= 0.43) return 'calm';
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
