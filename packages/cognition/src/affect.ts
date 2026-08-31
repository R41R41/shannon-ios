import type { CompanionStateSnapshot, ShannonEmotion } from './types.js';

const BASELINE: Readonly<ShannonEmotion> = Object.freeze({
  valence: 0,
  arousal: 0.30,
  openness: 0.35,
});

const POSITIVE_CUES = ['嬉しい', 'うれしい', '楽しい', 'よかった', 'ありがとう', '好き', '最高', 'できた', '成功'];
const NEGATIVE_CUES = [
  '悲しい', 'かなしい', 'つらい', '疲れた', '不安', '怖い', '嫌', '最悪', 'できなかった', 'できない',
  '失敗', '寂しい', 'さびしい', 'しんどい', '落ち込', '心配', '泣', '😢', '😭',
];
const PERSONAL_CUES = ['僕は', '私は', '自分は', '実は', '本当は', '気持ち', '思ってる', '感じる'];
const CURIOUS_CUES = ['気になる', '知りたい', 'なぜ', 'どうして', '面白い', 'おもしろい', '考えたい'];
const SLEEPY_CUES = ['眠い', '眠たい', 'ねむい', '寝る', 'おやすみ'];
const CALM_CUES = ['安心', '落ち着いた', 'ほっとした', 'ゆっくり'];

function occurrences(text: string, cues: readonly string[]): number {
  return cues.reduce((total, cue) => total + (text.includes(cue) ? 1 : 0), 0);
}

function toward(current: number, target: number, rate: number): number {
  return (target - current) * rate;
}

/**
 * One small continuous law: drift toward a baseline, then react to the new
 * stimulus. This is intentionally deterministic, cheap, and independent of
 * the response lane.
 */
export function deriveEmotionDelta(
  snapshot: CompanionStateSnapshot,
  userMessage: string,
): Partial<ShannonEmotion> {
  const text = userMessage.replace(/\s+/g, ' ').trim().slice(0, 8_000);
  const positive = Math.min(3, occurrences(text, POSITIVE_CUES));
  const negative = Math.min(3, occurrences(text, NEGATIVE_CUES));
  const personal = Math.min(3, occurrences(text, PERSONAL_CUES));
  const curious = Math.min(3, occurrences(text, CURIOUS_CUES));
  const sleepy = Math.min(2, occurrences(text, SLEEPY_CUES));
  const calm = Math.min(2, occurrences(text, CALM_CUES));
  const questionEnergy = /[?？]/u.test(text) ? 0.08 : 0;
  const exclamationEnergy = /[!！]/u.test(text) ? 0.08 : 0;
  const lengthEnergy = Math.min(0.05, text.length / 1_600);

  return {
    valence: toward(snapshot.emotion.valence, BASELINE.valence, 0.12)
      + positive * 0.14
      - negative * 0.16,
    arousal: toward(snapshot.emotion.arousal, BASELINE.arousal, 0.14)
      + questionEnergy
      + exclamationEnergy
      + lengthEnergy
      + Math.min(0.12, (positive + negative + curious) * 0.035)
      - sleepy * 0.14
      - calm * 0.07,
    openness: toward(snapshot.emotion.openness, BASELINE.openness, 0.07)
      + personal * 0.05
      + positive * 0.025
      + curious * 0.015
      - negative * 0.01,
  };
}

/**
 * A zero-I/O projection used for the current message icon. The durable shared
 * state is still updated later by the background lane with the same delta.
 */
export function projectEmotionReaction(
  snapshot: CompanionStateSnapshot,
  userMessage: string,
): ShannonEmotion {
  const delta = deriveEmotionDelta(snapshot, userMessage);
  return Object.freeze({
    valence: clamp(snapshot.emotion.valence + (delta.valence ?? 0), -1, 1),
    arousal: clamp(snapshot.emotion.arousal + (delta.arousal ?? 0), 0, 1),
    openness: clamp(snapshot.emotion.openness + (delta.openness ?? 0), 0, 1),
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
