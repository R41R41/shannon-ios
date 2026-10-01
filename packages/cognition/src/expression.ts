import type { ShannonEmotion, ShannonEmotionKind, ShannonExpressiveEmotion } from './types.js';

/** The 22 faces that have artwork and an Eye shape. */
export type ShannonExpression =
  | 'joyful'
  | 'excited'
  | 'amused'
  | 'laughing'
  | 'bashful'
  | 'embarrassed'
  | 'relieved'
  | 'surprised'
  | 'curious'
  | 'thinking'
  | 'confused'
  | 'determined'
  | 'tender'
  | 'calm'
  | 'jealous'
  | 'wry'
  | 'exasperated'
  | 'annoyed'
  | 'concerned'
  | 'sad'
  | 'sleepy'
  | 'neutral';

/**
 * Core character feelings that have no artwork of their own. Each borrows the
 * closest existing face and carries its own name, so a client that knows the
 * feeling shows 「得意げ」 and an older client still shows a valid face.
 */
export type ShannonFeeling = 'proud' | 'flustered' | 'apologetic';

export interface ShannonFace {
  expression: ShannonExpression;
  feeling?: ShannonFeeling;
}

export interface ShannonMessageEmotion extends ShannonFace {
  valence: number;
  arousal: number;
  openness: number;
}

const face = (expression: ShannonExpression, feeling?: ShannonFeeling): ShannonFace =>
  Object.freeze(feeling ? { expression, feeling } : { expression });

/** Borrowed faces: 得意げ → determined, 慌てている → embarrassed, 申し訳なさそう → concerned. */
const PROUD = face('determined', 'proud');
const FLUSTERED = face('embarrassed', 'flustered');
const APOLOGETIC = face('concerned', 'apologetic');

/**
 * The single table from the conversational emotion (the one the voice acts
 * with) to the face the owner sees. Text, voice history and the call Eye all
 * read it, so the three cannot disagree.
 */
const FACE_BY_EMOTION: Readonly<Record<ShannonEmotionKind, ShannonFace>> = Object.freeze({
  neutral: face('neutral'), bright: face('joyful'), playful: face('amused'), serious: face('thinking'),
  happy: face('joyful'), fun: face('laughing'), excited: face('excited'), ecstatic: face('excited'),
  relief: face('relieved'), pride: PROUD, gratitude: face('tender'), hope: face('joyful'),
  curiosity: face('curious'), affectionate: face('tender'),
  giggle: face('amused'), teasing: face('amused'), mischievous: face('amused'), plotting: face('amused'),
  smug: PROUD, deadpan: face('exasperated'), harmlessFalsehood: face('amused'), selfDeprecating: face('wry'),
  dramaticLament: face('wry'),
  shy: face('embarrassed'), blushing: face('embarrassed'), bashful: face('bashful'), flustered: FLUSTERED,
  hidingHappiness: face('bashful'),
  cuteAngry: face('annoyed'), seriousAnger: face('annoyed'), annoyed: face('annoyed'), indignant: face('annoyed'),
  frustrated: face('annoyed'), competitive: PROUD, protectiveAnger: face('annoyed'),
  jealous: face('jealous'), sulky: face('annoyed'), leftOut: face('sad'), lonely: face('sad'),
  attentionSeeking: face('jealous'), lightPossessive: face('jealous'), reassurance: face('tender'),
  sad: face('sad'), disappointed: face('sad'), hurt: face('sad'), anxious: face('concerned'),
  regret: APOLOGETIC, helpless: face('concerned'), lamenting: face('sad'), caring: face('tender'),
  protective: face('concerned'),
  surprised: face('surprised'), shocked: face('surprised'), stunned: face('surprised'),
  speechless: face('surprised'), confused: face('confused'), panic: FLUSTERED, scream: face('surprised'),
  focused: face('thinking'), determined: face('determined'), cautious: face('thinking'),
  urgent: face('concerned'), blocked: face('confused'), retrying: face('determined'), triumphant: PROUD,
  tired: face('sleepy'), sleepy: face('sleepy'),
  gentle: face('tender'), relaxed: face('calm'), content: face('calm'), quietCompanion: face('calm'),
  tender: face('tender'), apologetic: APOLOGETIC,
});

export function faceForEmotionKind(kind: ShannonEmotionKind): ShannonFace {
  return FACE_BY_EMOTION[kind];
}

/**
 * The quiet face used when no conversational feeling is visible. It reads only
 * the continuous mood. A low mood shows as concern for the owner, never as
 * Shannon's own sadness: that mood falls when the owner reports bad news.
 */
export function faceForMood(mood: ShannonEmotion): ShannonFace {
  if (mood.valence >= 0.24 && mood.arousal >= 0.4) return face('joyful');
  if (mood.valence <= -0.24) return face('concerned');
  if (mood.arousal <= 0.2) return face('sleepy');
  if (mood.valence >= 0.1 && mood.openness >= 0.37) return face('tender');
  if (mood.arousal <= 0.43) return face('calm');
  return face('neutral');
}

/**
 * A visible conversational feeling decides the face. A hidden or neutral one
 * leaves the face to the continuous mood.
 */
export function deriveShannonFace(
  mood: ShannonEmotion,
  feeling?: ShannonExpressiveEmotion,
): ShannonFace {
  if (feeling && feeling.primary !== 'neutral' && feeling.visibility !== 'hidden') {
    return faceForEmotionKind(feeling.primary);
  }
  return faceForMood(mood);
}

export function createShannonMessageEmotion(
  mood: ShannonEmotion,
  feeling?: ShannonExpressiveEmotion,
): ShannonMessageEmotion {
  return Object.freeze({ ...mood, ...deriveShannonFace(mood, feeling) });
}
