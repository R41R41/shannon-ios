import type { CompanionStateSnapshot, ShannonEmotion } from './types.js';

const BASELINE: Readonly<ShannonEmotion> = Object.freeze({
  valence: 0,
  arousal: 0.30,
  openness: 0.35,
});

const POSITIVE_CUES = ['嬉しい', 'うれしい', '楽しい', 'よかった', 'ありがとう', '好き', '最高', 'できた', '成功'];
const NEGATIVE_CUES = ['悲しい', 'かなしい', 'つらい', '疲れた', '不安', '怖い', '嫌', '最悪', 'できなかった', '失敗'];
const PERSONAL_CUES = ['僕は', '私は', '自分は', '実は', '本当は', '気持ち', '思ってる', '感じる'];

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
  const questionEnergy = /[?？]/u.test(text) ? 0.04 : 0;
  const exclamationEnergy = /[!！]/u.test(text) ? 0.06 : 0;
  const lengthEnergy = Math.min(0.06, text.length / 2_000);

  return {
    valence: toward(snapshot.emotion.valence, BASELINE.valence, 0.12)
      + positive * 0.10
      - negative * 0.12,
    arousal: toward(snapshot.emotion.arousal, BASELINE.arousal, 0.16)
      + questionEnergy
      + exclamationEnergy
      + lengthEnergy
      + Math.min(0.08, (positive + negative) * 0.025),
    openness: toward(snapshot.emotion.openness, BASELINE.openness, 0.08)
      + personal * 0.035
      + positive * 0.015
      - negative * 0.005,
  };
}
