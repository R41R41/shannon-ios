import { SHANNON_EMOTION_TIME, type ShannonEmotionTiming } from './emotionTime.js';
import type { CompanionStateSnapshot, ShannonEmotion } from './types.js';

/** Where the continuous mood rests when nothing moves it. */
export const SHANNON_MOOD_BASELINE: Readonly<ShannonEmotion> = Object.freeze({
  valence: 0,
  arousal: 0.30,
  openness: 0.35,
});
const BASELINE = SHANNON_MOOD_BASELINE;

const POSITIVE_CUES = ['嬉しい', 'うれしい', '楽しい', 'よかった', 'ありがとう', '好き', '最高', 'できた', '成功'];
const NEGATIVE_CUES = [
  '悲しい', 'かなしい', 'つらい', '疲れた', '不安', '怖い', '嫌', '最悪', 'できなかった', 'できない',
  '失敗', '寂しい', 'さびしい', 'しんどい', '落ち込', '心配', '泣', '😢', '😭',
];
const PERSONAL_CUES = ['僕は', '私は', '自分は', '実は', '本当は', '気持ち', '思ってる', '感じる'];
const CURIOUS_CUES = ['気になる', '知りたい', 'なぜ', 'どうして', '面白い', 'おもしろい', '考えたい'];
const SLEEPY_CUES = ['眠い', '眠たい', 'ねむい', '寝る', 'おやすみ'];
const CALM_CUES = ['安心', '落ち着いた', 'ほっとした', 'ゆっくり'];
// Only words said to her. Easing a hurt on a word that was about someone else would be worse than missing an apology, so
// the whole utterance has to be one of a few forms: an apology or a thanks, optionally with her name, a when, and what for.
// Anything with more in it (another person, a quotation, a request that follows) does not match, and nothing is eased.
const TAIL = '[？?ー〜。！!…\\s]*';
// An apology does not end in a question mark: 「ごめん？」 asks, it does not apologise.
const END = '[ー〜。！!…\\s]*';
const OH = `(?:(?:あ|ああ|うん|えっと)${'[、,\\s]*'})?`;
const SEP = '[、,\\s]*';
const NAME = `(?:シャノン${SEP})?`;
const WHEN = '(?:(?:さっき|昨日|昨夜|この前|今朝|今日|いつも|あの(?:時|とき))は?)?';
const TRULY = '(?:本当に|ほんとに|ほんとうに|本当|ほんと)?';
const SORRY = '(?:(?:ごめん(?:なさい|ね|よ)?ね?|すみません(?:でした)?|すまない|すまん)[、,\\s]*){1,2}';
const PARDON = '許して(?:ほしい|くれ|ください|ね)?';
const DEED = '(?:(?:(?:ひどい|あんな|きつい)ことを?言って|言い(?:すぎ|過ぎ)て|傷つけて|怒って|八つ当たりして|(?:怒って|傷ついて)いたら)(?:しまって)?)?';
const REGRET = '(?:言い(?:すぎ|過ぎ)た|(?:ボク|ぼく|僕|俺|おれ|私)が悪かった|悪かった|申し訳な(?:い|かった)(?:です)?|傷つけた|ひどいことを?言った)(?:ね|よ)?';
const APOLOGY = [
  new RegExp(`^${OH}${NAME}${WHEN}${TRULY}${DEED}${SORRY}${END}(?:${SEP}シャノン)?${END}(?:${SEP}${REGRET})?${END}(?:${SEP}シャノン)?${END}$`, 'u'),
  new RegExp(`^${OH}${NAME}${WHEN}${TRULY}(?:${REGRET}|${PARDON})${END}(?:${SEP}(?:${SORRY}|${PARDON}))?${END}$`, 'u'),
  new RegExp(`^(?:あなた|きみ|シャノン)に(?:ひどいことを?言った|言い(?:すぎ|過ぎ)た)${SEP}${SORRY}${END}$`, 'u'),
  new RegExp(`^(?:ちゃんと)?謝りたい${SEP}${SORRY}${END}$`, 'u'),
];
const THANKS = '(?:ありがとう(?:ね|な|ございます)?|大好き(?:だよ)?|助かった(?:よ)?|助かる(?:よ)?|頼りにしてる(?:よ)?)';
const FOR = '(?:(?:手伝って|助けて|聞いて|待っていて|待ってて|そばにいて|教えて|付き合って|いて)くれて)?';
const KINDNESS = [
  new RegExp(`^${NAME}${WHEN}${TRULY}${FOR}${THANKS}${TAIL}(?:${SEP}(?:助かった(?:よ)?|大好き(?:だよ)?|シャノン))?${TAIL}$`, 'u'),
  new RegExp(`^(?:シャノン|あなた|きみ)のおかげ(?:だよ|です)?${SEP}ありがとう(?:ね)?${TAIL}$`, 'u'),
];
const SOOTHING_LENGTH = 40;

/**
 * Whether the owner's words are an apology or a kind word said to her. This reads his words as
 * something that happens to her, like the mood cues above; it never decides the label of her feeling.
 * Unsure means no.
 */
export function soothingIn(userMessage: string): 'apology' | 'kindness' | null {
  if (userMessage.length > SOOTHING_LENGTH * 4) return null;
  const text = userMessage.trim();
  if (!text || Array.from(text).length > SOOTHING_LENGTH) return null;
  if (APOLOGY.some(pattern => pattern.test(text))) return 'apology';
  return KINDNESS.some(pattern => pattern.test(text)) ? 'kindness' : null;
}

function occurrences(text: string, cues: readonly string[]): number {
  return cues.reduce((total, cue) => total + (text.includes(cue) ? 1 : 0), 0);
}

function toward(current: number, target: number, rate: number): number {
  return (target - current) * rate;
}

/**
 * One small continuous law, deterministic, cheap, and independent of the response lane.
 *
 * On the awake clock the mood returns to its baseline with awake time (the reducer does that),
 * so the delta here is the reaction to the new stimulus alone, scaled by the room left toward
 * the bound it moves to: the mood is drawn, never pushed past a bound, and at the baseline the
 * reaction is the full step. Under `clock: 'wall'` it is the law as it was: drift toward the
 * baseline by a share per turn, then the stimulus.
 */
export function deriveEmotionDelta(
  snapshot: CompanionStateSnapshot,
  userMessage: string,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
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

  if (timing.clock === 'awake') {
    const room = (current: number, base: number, minimum: number, maximum: number, step: number) =>
      step * Math.min(1, Math.max(0, step > 0 ? (maximum - current) / (maximum - base) : (current - minimum) / (base - minimum)));
    return {
      valence: room(snapshot.emotion.valence, BASELINE.valence, -1, 1, positive * 0.14 - negative * 0.16),
      arousal: room(snapshot.emotion.arousal, BASELINE.arousal, 0, 1, questionEnergy + exclamationEnergy + lengthEnergy
        + Math.min(0.12, (positive + negative + curious) * 0.035) - sleepy * 0.14 - calm * 0.07),
      openness: room(snapshot.emotion.openness, BASELINE.openness, 0, 1, personal * 0.05 + positive * 0.025 + curious * 0.015 - negative * 0.01),
    };
  }

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
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): ShannonEmotion {
  const delta = deriveEmotionDelta(snapshot, userMessage, timing);
  return Object.freeze({
    valence: clamp(snapshot.emotion.valence + (delta.valence ?? 0), -1, 1),
    arousal: clamp(snapshot.emotion.arousal + (delta.arousal ?? 0), 0, 1),
    openness: clamp(snapshot.emotion.openness + (delta.openness ?? 0), 0, 1),
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
