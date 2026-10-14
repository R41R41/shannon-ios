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

/**
 * Syzygy ADR-0013 stage 1: the twelve faces the desktop body added (branch `codex/shannon/faces-12`), used only while
 * `SHANNON_SINGLE_FACE` is on and never among `SHANNON_EMOTION_KINDS` (the voice judge's choices and every prompt stay as they were).
 * On the wire the name goes in `feeling` and the nearest of the 22 faces in `expression`, so an older body falls back to that face.
 */
export const SINGLE_FACE_FEELINGS = Object.freeze({
  businessSmile: 'joyful', strainedSmile: 'wry', blankFace: 'calm', listless: 'sleepy', tongueClick: 'annoyed', coverUp: 'amused',
  irked: 'annoyed', banVerdict: 'annoyed', flatStare: 'exasperated', turnAway: 'annoyed', tsun: 'jealous', holdingBackTears: 'sad',
} as const satisfies Readonly<Record<string, ShannonExpression>>);
export type SingleFaceFeeling = keyof typeof SINGLE_FACE_FEELINGS;
export const isSingleFaceFeeling = (value: unknown): value is SingleFaceFeeling => typeof value === 'string' && Object.hasOwn(SINGLE_FACE_FEELINGS, value);

/** One of the twelve faces as the wire carries it: the name in `feeling`, its nearest face in `expression`. */
export function singleFace(feeling: SingleFaceFeeling): ShannonFace {
  return Object.freeze({ expression: SINGLE_FACE_FEELINGS[feeling], feeling });
}

export interface ShannonFace {
  expression: ShannonExpression;
  /** A core feeling, or (only while `SHANNON_SINGLE_FACE` is on) one of the twelve single-face names. */
  feeling?: ShannonFeeling | SingleFaceFeeling;
}

export interface ShannonMessageEmotion extends ShannonFace {
  valence: number;
  arousal: number;
  openness: number;
  /**
   * The reply's own feeling, finer than the face (owner decision 2026-10-05: a client shows its icon when it has
   * one, and the face otherwise). Present exactly when the face comes from that feeling: visible and not neutral.
   * Absent when the face comes from the quiet mood. Additive: a client that does not know it shows the face.
   */
  kind?: ShannonEmotionKind;
  /**
   * Syzygy ADR-0013 D17 (`SHANNON_SINGLE_FACE`): the presentation id a client draws beside this message (its avatar icon), from the
   * one presentation source. Present only while that switch is on. Closed vocabulary, no private content.
   */
  presentationId?: string;
}

/** Presentation ids of the owner-only layer (嫉妬, 甘え): never on a message anyone else sees (ADR-0013 D17, §4.4). */
const OWNER_ONLY_PRESENTATION_IDS: ReadonlySet<string> = new Set(['jealous', 'tender', 'tsun']);

/** A presentation id as anyone but the owner may see it: an owner-only one becomes 「calm」. */
export const publicPresentationId = (id: string): string => (OWNER_ONLY_PRESENTATION_IDS.has(id) ? 'calm' : id);

/** Expressions of the owner-only layer (嫉妬, 甘え): an older body falls back to `expression`, so a public face never names one. */
export const OWNER_ONLY_EXPRESSIONS: ReadonlySet<ShannonExpression> = new Set<ShannonExpression>(['jealous', 'tender']);

/**
 * A face as anyone but the owner may see it (ADR-0013 D17; review of 2026-10-14): its feeling only when that name is public, and never an
 * owner-only expression, also as the fallback an older body shows.
 */
export function publicFace<T extends ShannonFace>(shown: T): T {
  const feeling = shown.feeling && publicPresentationId(shown.feeling) === shown.feeling ? { feeling: shown.feeling } : {};
  const { feeling: _feeling, ...rest } = shown;
  return { ...rest, ...feeling, expression: OWNER_ONLY_EXPRESSIONS.has(shown.expression) ? 'calm' : shown.expression } as T;
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
  // No artwork of its own (owner answer 2 of 2026-10-05: the nearest face there is).
  uncomfortable: face('annoyed'),
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
  const kind = messageEmotionKind(feeling);
  return kind ? faceForEmotionKind(kind) : faceForMood(mood);
}

/**
 * The kind a message carries with its face: the feeling that decided the face, never the quiet mood's.
 * `deriveShannonFace` reads this same predicate, so "kind exactly when the face comes from the feeling" holds by construction.
 */
export function messageEmotionKind(feeling?: ShannonExpressiveEmotion): ShannonEmotionKind | undefined {
  return feeling && feeling.primary !== 'neutral' && feeling.visibility !== 'hidden' ? feeling.primary : undefined;
}

/**
 * The message emotion as it may be sent while anyone but the owner can see or hear the reply (coordinator decision
 * 2026-10-05): the face as before, without `kind`. `kind` is sent only to the owner alone; it may still be stored.
 */
export function messageEmotionForOthers(emotion: ShannonMessageEmotion): ShannonMessageEmotion {
  if (emotion.kind === undefined && emotion.presentationId === undefined) return emotion;
  const { kind: _kind, presentationId, ...face } = emotion;
  // ADR-0013 D17: the public layer's id only (absent while the switch is off, so this is as before).
  return Object.freeze(presentationId === undefined ? face : { ...face, presentationId: publicPresentationId(presentationId) });
}

export function createShannonMessageEmotion(
  mood: ShannonEmotion,
  feeling?: ShannonExpressiveEmotion,
): ShannonMessageEmotion {
  const kind = messageEmotionKind(feeling);
  return Object.freeze({ ...mood, ...deriveShannonFace(mood, feeling), ...(kind ? { kind } : {}) });
}
