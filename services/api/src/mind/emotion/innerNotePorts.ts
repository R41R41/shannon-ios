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
  /** The stored turn (`experience:<id>`), so that forgetting it forgets the note it prompted. */
  sourceId?: string;
}

/** A touch she answered (or stayed quiet at): the words she is told, how she took it, what her body did, and her line. */
export interface InnerNoteTouch {
  scopeKey: string;
  audience: 'owner' | 'others';
  at: string;
  touchId: string;
  phrase: string;
  stance?: string;
  reflex?: string;
  said?: string;
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
  decided?: { primary: string; intensity: number }): ShannonExpressiveEmotion {
  if (!port) return emotion;
  return safely(() => withoutOwnApology(emotion, port.current(scopeKey, at), at, decided), emotion);
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

/** Her face on the body while her note is active: the face of what she shows, a blush when the note says, and her `until`. */
export function innerNoteMood<T extends { expression: ShannonExpression; feeling?: ShannonFeeling }>(port: InnerNotePort | null | undefined,
  scopeKey: string, at: string, mood: T): T & { tell?: 'blush'; until?: string } {
  const face = innerNoteFaceOf(port, scopeKey, at);
  if (!face) return mood;
  const shown = faceForEmotionKind(face.shown);
  const { feeling: _feeling, ...rest } = mood;
  return { ...rest, expression: shown.expression, ...(shown.feeling ? { feeling: shown.feeling } : {}),
    ...(face.tell === 'blush' ? { tell: 'blush' as const } : {}), ...(face.until ? { until: face.until } : {}) } as T & { tell?: 'blush'; until?: string };
}

/** A resolved reply's feeling with D5.2 applied; its message face is built again only when the feeling changed. */
export function innerNoteReplyEmotion(port: InnerNotePort | null | undefined, scopeKey: string, at: string, resolved: ReplyEmotion,
  snapshot: CompanionStateSnapshot, userMessage: string, decided?: { primary: string; intensity: number }): ReplyEmotion {
  const expressiveEmotion = innerNoteOwnApology(port, scopeKey, at, resolved.expressiveEmotion, decided);
  if (expressiveEmotion === resolved.expressiveEmotion) return resolved;
  return { expressiveEmotion, messageEmotion: createShannonMessageEmotion(projectEmotionReaction(snapshot, userMessage, emotionTiming()), expressiveEmotion) };
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
    completion: { replyFeeling?: ChatReplyFeeling }, alone: boolean) => innerNoteReplyEmotion(alone ? port : null, scopeKey, at, resolved, snapshot,
    message, decidedReplyFeeling(completion, alone).decided),
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
  /** D5.2 on her feeling of the turn; the owner alone only. */
  feeling: (emotion: ShannonExpressiveEmotion, port: InnerNotePort | null | undefined, scopeKey: string, at: string, alone: boolean) =>
    innerNoteOwnApology(alone ? port : null, scopeKey, at, emotion),
  ended: (port: InnerNotePort | null | undefined, scopeKey: string, alone: boolean, at: string, userMessage: string, reply: string,
    feeling: ShannonExpressiveEmotion) => port?.turnEnded({ scopeKey, surface: 'voice', alone, at, userMessage, reply,
    feeling: { kind: feeling.primary, intensity: feeling.intensity } }),
});
