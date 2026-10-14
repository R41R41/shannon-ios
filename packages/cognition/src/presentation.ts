import { faceForEmotionKind, publicPresentationId, type ShannonFace } from './expression.js';
import type { FeelingAudience } from './feelingEvent.js';
import type { FeelingStance } from './feelingTurn.js';
import type { ShannonEmotionKind } from './types.js';

/**
 * The one presentation source (Syzygy ADR-0013 D12, D17, stage 1). Pure. The face, the per-message icon id and later the register of
 * her text all come from one state and one audience; the face case is `faceFor`.
 */
/** Feelings of the owner-only layer (甘え, 嫉妬, and their kin): shown to the owner alone (ADR-0013 §4.4, D17). */
const OWNER_ONLY_KINDS: ReadonlySet<ShannonEmotionKind> = new Set<ShannonEmotionKind>([
  'affectionate', 'jealous', 'lightPossessive', 'attentionSeeking', 'lonely', 'leftOut', 'reassurance', 'tender', 'hidingHappiness',
]);

const STANCE_FACE: Readonly<Record<Exclude<FeelingStance, 'neutral'>, ShannonEmotionKind>> = Object.freeze({
  accept: 'gentle', shy: 'flustered', sulky: 'annoyed', exasperated: 'deadpan', snipe: 'selfDeprecating', scold: 'annoyed', rebuff: 'annoyed',
  refuse_body: 'annoyed', tease: 'teasing', cover_up: 'hidingHappiness', worry: 'caring', not_play_along: 'deadpan', talk_back: 'indignant',
  sulk: 'sulky', cold: 'deadpan', affectionate: 'affectionate',
});
/** Her stance on a touch (the body's closed words). */
const TOUCH_STANCE_FACE: Readonly<Record<string, ShannonEmotionKind | undefined>> = Object.freeze({
  welcome: 'bashful', fine: 'content', unsure: 'confused', dislike: 'annoyed', refuse: 'annoyed',
});
/** Her own apology words never take her face (D12, ADR-0012 D5.2). */
const OWN_APOLOGY = new Set<ShannonEmotionKind>(['apologetic', 'regret']);

export interface FeelingFaceState {
  /** The quiet face of her mood now (`presentShannonMood`). */
  mood: ShannonFace;
  /** A visible conversational feeling (a reply's, a touch line's), when there is one. */
  feeling?: ShannonEmotionKind;
  /** The newest stance of this audience's key, while fresh: the feeling turn's or a touch's. */
  stance?: { kind: 'turn'; stance: FeelingStance } | { kind: 'touch'; stance: string };
  /** Safety, grief, an emergency: the face it gave stands. */
  overridden?: boolean;
  /** Her inner note's `shown`, an opinion only when nothing else decides (owner alone). */
  noteShown?: ShannonEmotionKind;
  tell?: 'blush';
}

export interface FeelingFace extends ShannonFace {
  tell?: 'blush';
  /** The feeling the face shows, when it is not the quiet mood's. */
  kind?: ShannonEmotionKind;
  source: 'override' | 'stance' | 'feeling' | 'note' | 'mood';
}

function stanceKind(stance: NonNullable<FeelingFaceState['stance']>): ShannonEmotionKind | undefined {
  if (stance.kind === 'turn') return stance.stance === 'neutral' ? undefined : STANCE_FACE[stance.stance];
  return TOUCH_STANCE_FACE[stance.stance];
}

/**
 * The one face (D12): one function from the state and the audience. Her words' cue (her own 「ごめん」), the touch table and the note's
 * `shown` do not override it; a stance does. The blush (her true feeling showing through) is for the owner alone, and so are the
 * feelings of the owner-only layer (甘え, 嫉妬…): in front of anyone else they are not shown (D17, §4.4).
 */
function face(state: FeelingFaceState, audience: FeelingAudience): FeelingFace {
  const owner = audience === 'owner_alone';
  const tell = owner && state.tell === 'blush' ? { tell: 'blush' as const } : {};
  const shown = (kind: ShannonEmotionKind | undefined): kind is ShannonEmotionKind => kind !== undefined && kind !== 'neutral'
    && (owner || !OWNER_ONLY_KINDS.has(kind));
  const of = (kind: ShannonEmotionKind, source: FeelingFace['source']): FeelingFace => ({ ...faceForEmotionKind(kind), ...tell, kind, source });
  if (state.overridden && shown(state.feeling)) return { ...faceForEmotionKind(state.feeling), kind: state.feeling, source: 'override' };
  if (state.overridden) return { ...state.mood, source: 'override' };
  const stance = state.stance ? stanceKind(state.stance) : undefined;
  if (shown(stance)) return of(stance, 'stance');
  if (shown(state.feeling) && !OWN_APOLOGY.has(state.feeling)) return of(state.feeling, 'feeling');
  if (owner && shown(state.noteShown)) return of(state.noteShown, 'note');
  return { ...state.mood, ...tell, source: 'mood' };
}

/** The face case of `presentFor`. */
export function faceFor(state: FeelingFaceState, audience: FeelingAudience): FeelingFace {
  return presentFor(state, audience, 'face');
}

/**
 * The id of a presentation as a client draws it (an avatar icon per message bubble, the tray, the Dock): the face's own feeling
 * name when it has one, else its expression. A closed vocabulary (`PRESENTATION_IDS`) with no private content: in front of anyone
 * else it is the public layer's only, because the face is.
 */
export const PRESENTATION_VERSION = 1;
export const PRESENTATION_IDS: readonly string[] = Object.freeze([
  'joyful', 'excited', 'amused', 'laughing', 'bashful', 'embarrassed', 'relieved', 'surprised', 'curious', 'thinking', 'confused', 'determined',
  'tender', 'calm', 'jealous', 'wry', 'exasperated', 'annoyed', 'concerned', 'sad', 'sleepy', 'neutral', 'proud', 'flustered', 'apologetic',
]);

export interface Presentation {
  v: typeof PRESENTATION_VERSION;
  id: string;
}

export const presentationIdOf = (shown: ShannonFace): string => shown.feeling ?? shown.expression;


/**
 * One presentation source (D17): every surface reads the same state and audience. `face` is the body's and the bubble's face
 * (`faceFor`); `icon` is the id a client draws. The register of the text and its pace are stage 2's surfaces.
 */
export function presentFor(state: FeelingFaceState, audience: FeelingAudience, surface: 'face'): FeelingFace;
export function presentFor(state: FeelingFaceState, audience: FeelingAudience, surface: 'icon'): Presentation;
export function presentFor(state: FeelingFaceState, audience: FeelingAudience, surface: 'face' | 'icon'): FeelingFace | Presentation {
  const shown = face(state, audience);
  if (surface === 'face') return shown;
  const id = presentationIdOf(shown);
  return { v: PRESENTATION_VERSION, id: audience === 'owner_alone' ? id : publicPresentationId(id) };
}
