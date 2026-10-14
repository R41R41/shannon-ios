/**
 * The window of her inner note (Syzygy ADR-0012 stage 1; rule `mind-via-ports`): what the reply paths (text, voice, a touch), the
 * body's presence and the voice router may hold of it. Everything here is behind `SHANNON_INNER_NOTE`: a path without a port (the
 * switch off) builds every prompt and every face exactly as before. Core: emotion.
 */
import {
  CHARACTER_CORE, SHANNON_CORE_PROMPT, characterCoreBlock, createShannonMessageEmotion, faceForEmotionKind, innerNoteFace, innerNoteRouteSummary,
  innerNoteTouchBlock, innerNoteTurnBlock, projectEmotionReaction, shannonIdentityPrompt, withoutOwnApology, buildExpressiveEmotionPrompt,
  innerNoteExpressiveEmotionPrompt,
  type CompanionStateSnapshot, type InnerNote, type InnerNoteEvent, type ReplyEmotion, type ShannonEmotionKind, type ShannonExpressiveEmotion,
  type ShannonExpression, type ShannonFeeling,
} from '@shannon/cognition';
import { emotionTiming } from './emotionTiming.js';
import { decidedReplyFeeling, type ChatReplyFeeling } from './chatReplyFeeling.js';
import { switchOn } from '@shannon/switches';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/** The switch (`packages/switches`). Unset is off. */
export function innerNoteEnabled(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): boolean {
  return switchOn(environment, 'SHANNON_INNER_NOTE');
}

/** A text or voice turn that has been answered: what the note's writer may react to (owner alone only; it decides). */
export interface InnerNoteTurn {
  scopeKey: string;
  surface: 'text' | 'voice';
  alone: boolean;
  at: string;
  userMessage: string;
  reply: string;
  feeling: { kind: ShannonEmotionKind; intensity: number } | null;
  /** The stored turn (`experience:<id>`), or a voice utterance (`utterance:<id>`) bound to its turn once stored. */
  sourceId?: string;
}

/** A touch she answered (or stayed quiet at): the words she is told, how she took it, what her body did, and her line. */
export interface InnerNoteTouch {
  scopeKey: string;
  audience: 'owner' | 'others';
  at: string;
  touchId: string;
  /** The touch as she remembers it (`experience:<burst id>`): forgetting it, or its retention, takes the notes it prompted. */
  sourceId?: string;
  phrase: string;
  /** The kind of touch (`poke`, `pet`, ...): a session of the same kind, part and stance is one reflection. */
  kind?: string;
  /** The part touched, in her words (胸); another part than the session's makes her reflect at once (owner decision 2026-10-14). */
  part?: string;
  stance?: string;
  reflex?: string;
  said?: string;
  /** What she said lately because of touches, oldest first (owner alone). */
  lines?: readonly string[];
}

/** What her body tells her note when it reflects: how often each part was touched by the owner alone since an instant, in her words. */
export interface InnerNoteBodyReader {
  partCounts(scopeKey: string, since: string, at: string): readonly { part: string; count: number }[];
}

export interface InnerNotePort {
  readonly timeZone: string;
  /** Her newest note while it still belongs to the present (not closed, her day not over), else null. */
  current(scopeKey: string, at: string): InnerNote | null;
  /** What happened since that note and is not reflected yet (owner alone only). */
  pending(scopeKey: string): readonly InnerNoteEvent[];
  /** After a reply: never waits, never throws. */
  turnEnded(turn: InnerNoteTurn): void;
  /** After a touch: never waits, never throws. */
  touched(touch: InnerNoteTouch): void;
  /** A source known later by its stored id (a voice turn's utterance once the app stored the turn). */
  bind(scopeKey: string, from: string, to: string): void;
  /** Her body, handed once at composition (`BodyReactions.useInnerNote`); its counts are read at reflection, after any forgetting. */
  useBody?(reader: InnerNoteBodyReader): void;
}

const safely = <T>(work: () => T, fallback: T): T => { try { return work(); } catch { return fallback; } };

/** The block a reply's turn context ends with: the owner alone the note, others what she shows, a guest nothing. */
export function innerNoteTurnContext(port: InnerNotePort | null | undefined, scopeKey: string, audience: 'owner' | 'others' | 'guest', at: string): string {
  if (!port) return '';
  return safely(() => innerNoteTurnBlock(port.current(scopeKey, at), audience, at, audience === 'owner' ? port.pending(scopeKey) : [], port.timeZone), '');
}

/** The short form a touch prompt carries. */
export function innerNoteTouchContext(port: InnerNotePort | null | undefined, scopeKey: string, audience: 'owner' | 'others', at: string): string {
  if (!port) return '';
  return safely(() => innerNoteTouchBlock(port.current(scopeKey, at), audience, at, port.timeZone), '');
}

/** The voice router's view of her (`voice_route.v3`): only with the owner alone, and only the English line. */
export function innerNoteRouteInput(port: InnerNotePort | null | undefined, scopeKey: string, alone: boolean, at: string): { shannonInner?: string } {
  if (!port || !alone) return {};
  const summary = safely(() => innerNoteRouteSummary(port.current(scopeKey, at), at), undefined);
  return summary ? { shannonInner: summary } : {};
}

/** The face hooks while her note is active (Live2D: face, blush, until). */
export function innerNoteFaceOf(port: InnerNotePort | null | undefined, scopeKey: string, at: string) {
  if (!port) return null;
  return safely(() => innerNoteFace(port.current(scopeKey, at), at), null);
}

/** D5.2: her own 「ごめん」 does not take her face while her note is active; without a port, the feeling as it was. */
export function innerNoteOwnApology(port: InnerNotePort | null | undefined, scopeKey: string, at: string, emotion: ShannonExpressiveEmotion,
  decided?: { primary: string; intensity: number }, failed = false): ShannonExpressiveEmotion {
  if (!port) return emotion;
  return safely(() => withoutOwnApology(emotion, port.current(scopeKey, at), at, decided, failed), emotion);
}

const CORE_BLOCK = characterCoreBlock(CHARACTER_CORE);
/** The three identities of a reply (the owner alone, the owner with others, a guest) and each one with her character core. */
const CORE_IDENTITIES: ReadonlyMap<string, string> = new Map([
  [SHANNON_CORE_PROMPT, shannonIdentityPrompt('owner', { characterCore: CORE_BLOCK })],
  [shannonIdentityPrompt('owner', { othersPresent: true }), shannonIdentityPrompt('owner', { othersPresent: true, characterCore: CORE_BLOCK })],
  [shannonIdentityPrompt('guest'), shannonIdentityPrompt('guest', { characterCore: CORE_BLOCK })],
]);

/**
 * D6 and D5.1: a reply's identity with her character core in place of the persona's identity and character lines (an AGI, not a
 * maid; the owner made her, he is not her 持ち主). Only these three exact identities are replaced; anything else, and everything
 * without a port (the switch off), is returned as it was, so the cached prefix of the switched-off path keeps its bytes.
 */
export function withCharacterCore<T extends { identity: string }>(parts: T, port: InnerNotePort | null | undefined): T {
  const identity = port ? CORE_IDENTITIES.get(parts.identity) : undefined;
  return identity ? { ...parts, identity } : parts;
}

/**
 * Her face on the body while her note is active: the face of what she shows, a blush when the note says, and her `until`. An
 * override of her present feeling (safety, grief, an emergency: 「胸が痛い、救急車」) keeps the face it gave: no sulk shows then.
 */
export function innerNoteMood<T extends { expression: ShannonExpression; feeling?: ShannonFeeling }>(port: InnerNotePort | null | undefined,
  scopeKey: string, at: string, mood: T, overridden = false): T & { tell?: 'blush'; until?: string } {
  const face = overridden ? null : innerNoteFaceOf(port, scopeKey, at);
  if (!face) return mood;
  const shown = faceForEmotionKind(face.shown);
  const { feeling: _feeling, ...rest } = mood;
  return { ...rest, expression: shown.expression, ...(shown.feeling ? { feeling: shown.feeling } : {}),
    ...(face.tell === 'blush' ? { tell: 'blush' as const } : {}), ...(face.until ? { until: face.until } : {}) } as T & { tell?: 'blush'; until?: string };
}

/**
 * A resolved reply with D5.2 applied to its face only: the message face shows what her note shows, and the feeling stored for the
 * reply stays the one it was (her note must not read its own face back as her feeling). Built again only when the face changed.
 */
export function innerNoteReplyEmotion(port: InnerNotePort | null | undefined, scopeKey: string, at: string, resolved: ReplyEmotion,
  snapshot: CompanionStateSnapshot, userMessage: string, decided?: { primary: string; intensity: number }, failed = false): ReplyEmotion {
  const shown = innerNoteOwnApology(port, scopeKey, at, resolved.expressiveEmotion, decided, failed);
  if (shown === resolved.expressiveEmotion) return resolved;
  return { expressiveEmotion: resolved.expressiveEmotion,
    messageEmotion: createShannonMessageEmotion(projectEmotionReaction(snapshot, userMessage, emotionTiming()), shown) };
}



type Audience = 'owner' | 'others' | 'guest';
const audienceOf = (alone: boolean, guest: boolean): Audience => (alone ? 'owner' : guest ? 'guest' : 'others');
const PRESENCE_LINE = 'Prioritize emotional presence or natural companionship; do not force a problem-solving frame or checklist.';
/** D5.1: being with him without taking his feeling on as hers (the line above made her mirror what he felt). */
export const INNER_NOTE_PRESENCE_LINE = 'Be present with what was said without taking the speaker\'s feeling on as your own: your own feeling is in your '
  + 'inner note. Do not force a problem-solving frame or checklist.';

/**
 * The text turn's hooks (`apiKernel.ts`), each the turn of before without a port: the context's last block, the reply's feeling
 * with D5.2, the note told of the turn after it, and the body handed the port.
 */
export const innerNoteText = Object.freeze({
  context: (port: InnerNotePort | null, scopeKey: string, alone: boolean, platform: boolean, at: string) =>
    innerNoteTurnContext(port, scopeKey, audienceOf(alone, platform), at),
  /** D5.2 on a text reply's feeling; an apology she decided herself (the decided feeling, owner alone only) stays. */
  reply: (port: InnerNotePort | null, scopeKey: string, at: string, resolved: ReplyEmotion, snapshot: CompanionStateSnapshot, message: string,
    /** `failed`: a tool of the turn failed (her apology may be for that: an alarm she could not set), and it stays. */
    completion: { replyFeeling?: ChatReplyFeeling }, alone: boolean, failed = false) => innerNoteReplyEmotion(alone ? port : null,
    scopeKey, at, resolved, snapshot, message, decidedReplyFeeling(completion, alone).decided, failed),
  ended: (port: InnerNotePort | null, scopeKey: string, alone: boolean, at: string, userMessage: string, reply: string, feeling: ShannonExpressiveEmotion,
    experienceId?: string) => port?.turnEnded({ scopeKey, surface: 'text', alone, at, userMessage, reply,
    feeling: { kind: feeling.primary, intensity: feeling.intensity }, ...(experienceId ? { sourceId: `experience:${experienceId}` } : {}) }),
  attach: (body: { useInnerNote(port: InnerNotePort | null): void }, port: InnerNotePort | undefined): InnerNotePort | null => {
    if (port) body.useInnerNote(port);
    return port ?? null;
  },
});

/** The voice turn's hooks (`apiLiveVoice.ts`), each the turn of before without a port. */
export const innerNoteVoice = Object.freeze({
  identity: withCharacterCore,
  context: (port: InnerNotePort | null | undefined, scopeKey: string, alone: boolean, guest: boolean, at: string) =>
    innerNoteTurnContext(port, scopeKey, audienceOf(alone && !guest, guest), at),
  route: (port: InnerNotePort | null | undefined, scopeKey: string, alone: boolean, at: string) => innerNoteRouteInput(port, scopeKey, alone, at),
  presence: (port: InnerNotePort | null | undefined) => (port ? INNER_NOTE_PRESENCE_LINE : PRESENCE_LINE),
  expressive: (port: InnerNotePort | null | undefined) => (port ? innerNoteExpressiveEmotionPrompt : buildExpressiveEmotionPrompt),
  /**
   * D5.2 on the voice plan only (the face and the performance): the feeling stored for the turn stays the true one. The owner alone
   * only; a tool of the turn that failed keeps her apology.
   */
  planner: <P>(plan: (emotion: ShannonExpressiveEmotion) => P, port: InnerNotePort | null | undefined, scopeKey: string, at: string, alone: boolean) =>
    (emotion: ShannonExpressiveEmotion, failed = false) => plan(innerNoteOwnApology(alone ? port : null, scopeKey, at, emotion, undefined, failed)),
  /** After the turn: her note may reflect. Its utterance is bound to the stored turn when the app stores it (`apiVoiceTurns.ts`). */
  ended: (port: InnerNotePort | null | undefined, scopeKey: string, alone: boolean, at: string, userMessage: string, reply: string,
    feeling: ShannonExpressiveEmotion, utteranceId?: string) => port?.turnEnded({ scopeKey, surface: 'voice', alone, at, userMessage, reply,
    feeling: { kind: feeling.primary, intensity: feeling.intensity }, ...(utteranceId ? { sourceId: `utterance:${utteranceId}` } : {}) }),
});
