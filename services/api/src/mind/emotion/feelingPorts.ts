/**
 * The window of her feeling events, the feeling turn and the one face (Syzygy ADR-0013 stage 1; rule `mind-via-ports`): what the
 * reply paths (text, voice, a touch), the body's presence and the voice router may hold of them. Everything here is behind
 * `SHANNON_FEELING_EVENTS` (and `SHANNON_FEELING_TURN`, `SHANNON_SINGLE_FACE`): a path without a port builds every prompt and every
 * face exactly as before. Core: emotion.
 */
import {
  FEELING_FACTS_USE_LINE, FEELING_TURN_HEADER, drawersIn, faceFor, faceForMood, feelingActor, feelingTurnBlock, neutralFeelingTurn, presentShannonFeeling,
  checkBeforeSending, checkReply, feelingSentenceBlock,
  fastLayerWords, advanceCoreAffect, registerOfLevel,
  type TextRegisterDirective, continuedAfterRefusal, foldFeelingDynamics, replyFacts, strongReplyReason, utteranceTags,
  type ReplyCheckContext,
  presentFor, presentationIdOf, utteranceKind, type CompanionStateSnapshot, type Presentation, type ShannonExpressiveEmotion,
  type ShannonMessageEmotion, type FeelingAudience, type FeelingChannel, type FeelingEvent, type FeelingFace, type FeelingFaceState,
  type FeelingRegister, type FeelingTurnDecision, type ReplyEmotion, type ShannonEmotionKind, type ShannonFace,
} from '@shannon/cognition';
import { randomUUID } from 'node:crypto';
import { switchOn } from '@shannon/switches';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { observeSync } from '../../infra/observer/observerContext.js';
import type { JevChooser } from '../../infra/models/jev/jevChoice.js';
import type { FeelingTurnJevInput } from '../../contracts/feelingEventContract.js';
import { emotionTiming } from './emotionTiming.js';
import type { FeelingEvents, FeelingKey, FeelingLines } from './feelingEvents.js';
import type { FeelingDays } from './feelingDays.js';
import { chooseFeelingTurn, feelingTurnState, feelingTurnWithin } from './feelingTurn.js';
import { feelingSentenceWithin, startFeelingSentence } from './feelingSentence.js';
import { textRegisterBefore, textRegisterLines, textRegisterOf, textRegisterReply } from './textRegisterTurn.js';
import type { ChatTextRegister } from '../../contracts/contracts.js';
import type { FeelingSentenceWriter } from '../../infra/models/feelingSentenceModel.js';

export type { FeelingKey, FeelingLines } from './feelingEvents.js';

type Environment = Readonly<Record<string, string | undefined>>;
export const feelingEventsEnabled = (environment: Environment = serverEnvironment()) => switchOn(environment, 'SHANNON_FEELING_EVENTS');
export const singleFaceEnabled = (environment: Environment = serverEnvironment()) =>
  feelingEventsEnabled(environment) && switchOn(environment, 'SHANNON_SINGLE_FACE');
export const feelingTurnEnabled = (environment: Environment = serverEnvironment()) =>
  feelingEventsEnabled(environment) && switchOn(environment, 'SHANNON_FEELING_TURN');

export interface FeelingPort {
  readonly events: FeelingEvents;
  /** Stage 3: her closed days and what is carried across them (`SHANNON_RELATIONSHIP_LEDGER`, episode and boundary memory). */
  readonly days?: FeelingDays;
  /** Jev for the text feeling turn; null without `TYPESAFE_API_KEY` (then 「ふつう」 and the facts). */
  readonly chooser: JevChooser | null;
  readonly turn: boolean;
  readonly singleFace: boolean;
  /** What Jev is handed of the turn's words (`SHANNON_FEELING_TURN_JEV_INPUT`; owner decision 2026-10-14: `utterance`). */
  readonly jevInput?: FeelingTurnJevInput;
  /** `SHANNON_FEELING_STRONG_REPLY_MODEL` with the Anthropic key: a strong turn's text reply goes to Sonnet, at most `cap` a day. */
  readonly strong?: { cap: number };
  /** `SHANNON_REPLY_CHECK`: her replies are checked (before sending on strong, order and public text turns; after, otherwise). */
  readonly check?: boolean;
  /** `SHANNON_CORE_AFFECT`: the shadow's composure step is known to the check (its register flags); nothing else reads it. */
  readonly coreAffect?: boolean;
  /**
   * `SHANNON_FEELING_MEANING` (with the fast layer and the turn; review M4): the feeling turn's Jev call also asks the meaning of his words
   * (meant, teasing). Apart from `SHANNON_CORE_AFFECT`, so the shadow changes no Jev question.
   */
  readonly meaning?: boolean;
  /** `SHANNON_TEXT_REGISTER` (with the turn): her text reply's form and pacing follow the feeling turn and her composure. */
  readonly textRegister?: boolean;
  /** `SHANNON_INNER_NARRATOR` (with the fast layer): her inner note reads the fast layer and reflects as narrator. */
  readonly narrator?: boolean;
  /** `SHANNON_FEELING_SENTENCE` (with the fast layer and the turn): Haiku writes her feeling in two or three lines in a strong scene. */
  readonly sentence?: FeelingSentenceWriter;
}

/** The facts block while the feeling turn is off (events on): the same ledger and watch lines, as facts. */
export const FEELING_FACTS_HEADER = '[今日のこと]（事実）';

const safely = <T>(work: () => T, fallback: T): T => {
  try { return work(); } catch { return fallback; }
};

/** One feeling turn in progress (text or voice): its key, the lines of that key, and its decision once known. */
export interface FeelingTurnHandle {
  port: FeelingPort;
  /** This turn's own id (its check record is handed to it alone, review L3). */
  turn: string;
  scopeKey: string;
  key: FeelingKey;
  channel: FeelingChannel;
  lines: FeelingLines | null;
  order: boolean;
  register: FeelingRegister;
  pending: Promise<FeelingTurnDecision> | null;
  decision: FeelingTurnDecision | null;
  /** When the turn began and her state then (the stronger model's choice reads a touch she refused just before). */
  at: string;
  snapshot: CompanionStateSnapshot;
  /** The reply went to the stronger model (counted against the day's cap until it is recorded). */
  strong: boolean;
  /** Her feeling sentence being written (a strong text scene, for the owner alone), or absent. */
  sentence?: Promise<readonly string[] | null> | null;
  /** Item 10: this text reply's form and pacing (`SHANNON_TEXT_REGISTER`), once the feeling turn is known. */
  textRegister?: TextRegisterDirective;
}

interface BeginInput { scopeKey: string; key: FeelingKey; channel: FeelingChannel; words: string; at: string; snapshot: CompanionStateSnapshot }

function begin(port: FeelingPort, input: BeginInput): FeelingTurnHandle {
  const lines = port.events.linesFor(input.scopeKey, input.key, input.at, input.snapshot, input.words);
  const register = lines?.ledger.register ?? 'normal';
  const order = utteranceKind(input.words) === 'feeling_order';
  return { port, turn: randomUUID(), scopeKey: input.scopeKey, key: input.key, channel: input.channel, lines, order, register, pending: null, decision: null,
    at: input.at, snapshot: input.snapshot, strong: false };
}

/** The block the reply reads last: the feeling turn's while it is on, else the facts alone ('' when there are none). */
function blockOf(handle: FeelingTurnHandle, decision: FeelingTurnDecision | null): string {
  const ledgerLine = handle.lines?.ledgerLine ?? '', repetitionLine = handle.lines?.repetitionLine ?? '';
  const carried = handle.lines?.carriedLines ?? [];
  if (decision) {
    const extra = carried.length ? { carried } : {};
    return feelingTurnBlock({ decision, ledgerLine, repetitionLine, order: handle.order, audience: handle.key.audience, ...extra });
  }
  const facts = [ledgerLine, ...carried, ledgerLine || carried.length ? FEELING_FACTS_USE_LINE : '', repetitionLine].filter(Boolean);
  return facts.length ? [FEELING_FACTS_HEADER, ...facts].join('\n') : '';
}

/** The events after a turn: his words (what kind of thing they were) and her reply (its closed facts, and the stance it was given). */
function turnEnded(handle: FeelingTurnHandle, input: { at: string; words: string; reply: string; turnId: string; sourceId: string | null }): void {
  const base = { ...handle.key, identity: handle.key.personKey === 'owner' ? 'registered' as const : 'unknown' as const, channel: handle.channel,
    sourceId: input.sourceId, occurredAt: input.at };
  const stance = handle.decision && handle.decision.stance !== 'neutral' ? { turnStance: handle.decision.stance } : {};
  const strong = handle.strong ? { replyModel: 'strong' as const } : {};
  const check = checkFacts(handle, input.reply);
  const register = handle.register !== 'normal' ? { register: handle.register } : {};
  const facts = { ...replyFacts(input.reply, drawersIn), ...stance, ...register, ...strong, ...check };
  const record = (event: FeelingEvent) => handle.port.events.record(handle.scopeKey, event);
  // His words' closed tags only while something reads them (the fast layer; review Low).
  const tags = handle.port.coreAffect ? utteranceTags(input.words) : [];
  const meaning = handle.decision?.meaning ? { meaning: handle.decision.meaning } : {};
  const said = { id: `turn:${handle.channel}:${input.turnId}`, kind: utteranceKind(input.words),
    facts: { ...(tags.length ? { tags } : {}), ...meaning } };
  if (input.words.trim()) record({ ...base, ...said });
  if (input.reply.trim()) record({ ...base, id: `reply:${handle.channel}:${input.turnId}`, kind: 'own_reply', facts });
  if (handle.strong) handle.port.events.releaseStrong(handle.scopeKey, handle.at);
}

/** The reply check's context of a turn, or null without the check or a decision. */
function checkContext(handle: FeelingTurnHandle): ReplyCheckContext | null {
  if (!handle.port.check || !handle.decision) return null;
  const violation = continuedAfterRefusal(handle.lines?.ledger, handle.at);
  const level = handle.port.coreAffect ? composureLevel(handle) : undefined;
  const form = handle.textRegister ? { form: { maxCharacters: handle.textRegister.maxCharacters, emoji: handle.textRegister.emoji,
    lineBreaks: handle.textRegister.lineBreaks } } : {};
  const ledger = handle.lines?.ledger;
  const counted = Boolean(ledger && (ledger.touches > 0 || ledger.apologies > 0 || ledger.orders > 0));
  return { stance: handle.decision.stance, intensity: handle.decision.intensity, audience: handle.key.audience, order: handle.order, violation,
    turn: handle.turn, counted, ...(level !== undefined ? { level } : {}), ...form };
}

/** The register her composure holds now: the fast layer's step when it is known, else the turn's (item 10). */
function registerNow(handle: FeelingTurnHandle): FeelingRegister {
  const level = handle.port.coreAffect ? composureLevel(handle) : undefined;
  return level !== undefined ? registerOfLevel(level) : handle.register;
}

/** The shadow's composure step for this key now (for the check's register flags only). */
function composureLevel(handle: FeelingTurnHandle): number | undefined {
  return safely(() => foldFeelingDynamics(handle.port.events.today(handle.scopeKey, handle.at, handle.snapshot), handle.key).composure.level, undefined);
}

/** A reply's check: the one made before sending when there was one, else checked now (voice, and text turns not checked before). */
function checkFacts(handle: FeelingTurnHandle, reply: string): { checkFlags?: readonly string[]; rewritten?: true } {
  const context = checkContext(handle);
  if (!context) return {};
  const before = handle.channel === 'text' ? handle.port.events.takeCheck(handle.scopeKey, handle.turn) : null;
  const flags = before ? before.flags : checkReply(reply, context);
  observeSync('emotion', { phase: 'feeling.reply_check', audience: handle.key.audience, before: Boolean(before) }, () => null,
    () => ({ flags: [...flags], rewritten: before?.rewritten === true }));
  return { ...(flags.length ? { checkFlags: flags } : {}), ...(before?.rewritten ? { rewritten: true as const } : {}) };
}

/**
 * Which model writes this text reply (owner decision 2026-10-14: 「気持ちが強い時だけSonnet」): the stronger one for a strong turn while
 * the day's cap allows, else the ordinary one. The Observer is told which and why, never the words.
 */
function routeReply(handle: FeelingTurnHandle): { feelingStrong?: true; feelingCheck?: ReplyCheckContext } {
  const strong = handle.port.strong ?? { cap: 0 };
  if (!handle.port.turn) return {};
  const fresh = handle.port.events.freshStance(handle.scopeKey, handle.key, handle.at, handle.snapshot);
  const continued = continuedAfterRefusal(handle.lines?.ledger, handle.at);
  const reason = strongReplyReason(handle.decision, handle.key.audience, fresh?.kind === 'touch' ? fresh.stance : null, continued);
  handle.strong = reason !== null && Boolean(handle.port.strong) && handle.port.events.reserveStrong(handle.scopeKey, handle.at, strong.cap);
  const capped = reason !== null && Boolean(handle.port.strong) && !handle.strong;
  observeSync('emotion', { phase: 'feeling.reply_model', audience: handle.key.audience }, () => null,
    () => ({ model: handle.strong ? 'sonnet' : 'haiku', reason: reason ?? 'none', capped }));
  if (capped) console.warn('Shannon feeling reply model: the day\'s cap of strong replies is reached; this reply stays on Haiku');
  const check = checkContext(handle);
  const before = check && checkBeforeSending(check) ? { feelingCheck: check } : {};
  return { ...(handle.strong ? { feelingStrong: true as const } : {}), ...before };
}

/** The one face of a state for an audience, with its span (closed values only). */
export function feelingFace(state: FeelingFaceState, audience: FeelingAudience): FeelingFace {
  return observeSync('emotion', { phase: 'feeling.face', audience, stance: state.stance?.stance ?? null, overridden: state.overridden === true },
    () => faceFor(state, audience), face => ({ source: face.source, expression: face.expression, feeling: face.feeling ?? null }));
}

/**
 * A reply's message face from the one face, keeping its numbers; `kind` exactly when the face shows a feeling; and (D17) the presentation
 * id a client draws beside the bubble, from the same source.
 */
function replyWithFace(resolved: ReplyEmotion, face: FeelingFace, presentation: Presentation): ReplyEmotion {
  const { kind: _kind, feeling: _feeling, ...rest } = resolved.messageEmotion;
  const kind = face.kind && face.source !== 'mood' ? { kind: face.kind } : {};
  const shown = { ...rest, expression: face.expression, ...(face.feeling ? { feeling: face.feeling } : {}), ...kind, presentationId: presentation.id };
  return { expressiveEmotion: resolved.expressiveEmotion, messageEmotion: Object.freeze(shown) };
}

/** The feeling turn's drawer and register, for the twelve single faces (none for 「ふつう」 or the register of before). */
function turnHints(handle: FeelingTurnHandle): Pick<FeelingFaceState, 'drawer' | 'register'> {
  const decision = handle.decision;
  const drawer = decision && decision.drawer !== 'none' ? { drawer: decision.drawer } : {};
  return { ...drawer, ...(handle.register !== 'normal' ? { register: handle.register } : {}) };
}

function faceState(port: FeelingPort, scopeKey: string, key: FeelingKey, at: string, snapshot: CompanionStateSnapshot,
  extra: Partial<FeelingFaceState> & { mood: ShannonFace }): FeelingFaceState {
  const stance = extra.stance ?? port.events.freshStance(scopeKey, key, at, snapshot) ?? undefined;
  const overridden = safely(() => presentShannonFeeling(snapshot, at, emotionTiming()).overrideReason !== undefined, false);
  return { ...extra, ...(stance ? { stance: stance as FeelingFaceState['stance'] } : {}), overridden };
}

/** The text turn's hooks (`apiKernel.ts`), each the turn of before without a port. */
export const feelingText = Object.freeze({
  attach: (body: { useFeeling(port: FeelingPort | null): void }, port: FeelingPort | undefined): FeelingPort | null => {
    if (port) body.useFeeling(port);
    return port ?? null;
  },
  /** Started right after the turn begins, beside recall and context: the Jev call runs while they do. */
  start: (port: FeelingPort | null, input: { scopeKey: string; alone: boolean; surface: boolean; message: string;
    begun: { occurredAt: string; captured: CompanionStateSnapshot } }) => {
    if (!port) return null;
    return safely(() => {
      const key = feelingActor({ ownerAlone: input.alone && !input.surface, group: input.surface });
      const { occurredAt: at, captured: snapshot } = input.begun;
      const handle = begin(port, { scopeKey: input.scopeKey, key, channel: 'text', words: input.message, at, snapshot });
      handle.pending = port.turn ? chooseFeelingTurn(port.chooser, { scopeKey: input.scopeKey, surface: 'text', audience: key.audience,
        utterance: input.message, lines: handle.lines, register: handle.register, mood: snapshot.emotion,
        ...(port.jevInput ? { jevInput: port.jevInput } : {}), ...(port.meaning ? { reading: true } : {}) }) : null;
      handle.sentence = port.sentence && port.coreAffect && port.turn
        ? safely(() => startFeelingSentence(port.events, port.sentence!, { ...handle, words: input.message }), null) : null;
      return handle;
    }, null);
  },
  /**
   * The last block of the prompt, awaited at most `FEELING_TURN_LIMITS.extraWaitMilliseconds` beyond the moment it is asked for; her
   * feeling sentence, when one is being written, at most `FEELING_SENTENCE_LIMITS.waitMilliseconds` (the two waits overlap).
   */
  block: async (handle: FeelingTurnHandle | null): Promise<string> => {
    if (!handle) return '';
    const sentence = handle.sentence ? feelingSentenceWithin(handle.sentence) : null;
    handle.decision = handle.pending ? await feelingTurnWithin(handle.pending, handle.register) : null;
    const lines = sentence ? await sentence : null;
    const decided = handle.port.textRegister ? handle.decision : null;
    if (decided) handle.textRegister = safely(() => textRegisterOf(decided, registerNow(handle), handle.key.audience), undefined);
    const form = handle.textRegister ? textRegisterLines(handle.textRegister) : '';
    return safely(() => [blockOf(handle, handle.decision), lines ? feelingSentenceBlock(lines) : '', form].filter(Boolean).join('\n\n'), '');
  },
  /**
   * Item 10: the directive the sentence stream is handed before the model writes, with what bypasses it that is known already (review
   * M3: urgency or safety in his words; such a turn is never held by a pause or the typing display). A paced turn is not streamed early.
   */
  paced: (handle: FeelingTurnHandle | null, message: string): { textRegister?: ChatTextRegister } => {
    if (!handle?.textRegister) return {};
    return safely<{ textRegister?: ChatTextRegister }>(() => ({ textRegister: textRegisterBefore(handle.textRegister!, message) }), {});
  },
  /** Item 10: the reply's form and pacing for the device, with what bypasses it; nothing without the switch. */
  register: (handle: FeelingTurnHandle | null, message: string, reply: string, completion: { outOfTime?: true },
    results: readonly { ok: boolean; effect: 'read' | 'write' }[]): { textRegister?: ChatTextRegister } => {
    const directive = handle?.textRegister;
    if (!directive) return {};
    // Review M2: a promise is any write her tools did this turn: her own places, and the owner's device (a reminder, a timer, the calendar).
    const wrote = results.some(call => call.ok && call.effect === 'write');
    return safely<{ textRegister?: ChatTextRegister }>(() => ({ textRegister: textRegisterReply(directive, { message, reply,
      outOfTime: completion.outOfTime === true, wrote }) }), {});
  },
  /** The text reply's model (after `block`): `{ feelingStrong: true }` for a strong turn within the day's cap, else nothing. */
  route: (handle: FeelingTurnHandle | null): { feelingStrong?: true; feelingCheck?: ReplyCheckContext } => (handle ? safely(() => routeReply(handle), {}) : {}),
  /** The message face under `SHANNON_SINGLE_FACE`: the turn's stance, else the reply's feeling (never her own apology), else the mood. */
  face: (handle: FeelingTurnHandle | null, resolved: ReplyEmotion, snapshot: CompanionStateSnapshot, at: string): ReplyEmotion => {
    if (!handle?.port.singleFace) return resolved;
    return safely(() => {
      const visible = resolved.messageEmotion.kind;
      const stance = handle.decision && handle.decision.stance !== 'neutral' ? { kind: 'turn' as const, stance: handle.decision.stance } : undefined;
      const state = faceState(handle.port, handle.scopeKey, handle.key, at, snapshot, { mood: faceForMood(snapshot.emotion),
        ...(visible ? { feeling: visible } : {}), ...(stance ? { stance } : {}), ...turnHints(handle) });
      return replyWithFace(resolved, feelingFace(state, handle.key.audience), presentFor(state, handle.key.audience, 'icon'));
    }, resolved);
  },
  ended: (handle: FeelingTurnHandle | null, input: { at: string; message: string; reply: string; experienceId?: string }) => {
    if (handle) safely(() => turnEnded(handle, { at: input.at, words: input.message, reply: input.reply, turnId: input.experienceId ?? input.at,
      sourceId: input.experienceId ?? null }), undefined);
  },
  /** The voice turns' binder: her note's, and her feeling events' (a voice turn's events take the stored turn's id). */
  binder: <T extends { bind(scopeKey: string, from: string, to: string): void }>(note: T | null, port: FeelingPort | null): T | { bind: T['bind'] } | null => {
    if (!port) return note;
    return { bind: (scopeKey, from, to) => {
      note?.bind(scopeKey, from, to);
      port.events.bind(scopeKey, from, to.replace(/^experience:/u, ''));
    } };
  },
});

/** The voice turn's hooks (`apiLiveVoice.ts`). The feeling questions ride on the router's Jev call (`voice_route.v4`). */
export const feelingVoice = Object.freeze({
  start: (port: FeelingPort | null | undefined, input: { scopeKey: string; alone: boolean; guest: boolean; threadId: string; transcript: string; at: string;
    snapshot: CompanionStateSnapshot }): FeelingTurnHandle | null => {
    if (!port) return null;
    // A 「友人も一緒」 call, or the owner's call with someone beside him: the call is the scene; nothing is the owner's.
    const key = feelingActor({ ownerAlone: input.alone && !input.guest, sceneId: input.alone && !input.guest ? null : `call:${input.threadId}` });
    const { scopeKey, transcript: words, at, snapshot } = input;
    return safely(() => begin(port, { scopeKey, key, channel: 'voice', words, at, snapshot }), null);
  },
  /** What the router is handed: the feeling turn's state, only while the turn is on. */
  route: (handle: FeelingTurnHandle | null, transcript: string, snapshot: CompanionStateSnapshot | null): { shannonFeeling?: Record<string, unknown> } => {
    if (!handle?.port.turn) return {};
    return { shannonFeeling: feelingTurnState({ scopeKey: handle.scopeKey, surface: 'voice', audience: handle.key.audience, utterance: transcript,
      lines: handle.lines, register: handle.register, mood: snapshot?.emotion ?? { valence: 0, arousal: 0 },
      ...(handle.port.meaning ? { reading: true } : {}) }) };
  },
  /** The block after the router answered (its feeling, or 「ふつう」 when the router fell back). */
  block: (handle: FeelingTurnHandle | null, decided: FeelingTurnDecision | undefined): string => {
    if (!handle) return '';
    handle.decision = handle.port.turn ? decided ?? neutralFeelingTurn(handle.register) : null;
    if (handle.decision) observeSync('emotion', { phase: 'feeling.turn', surface: 'voice', audience: handle.key.audience }, () => handle.decision,
      value => ({ stance: value?.stance ?? null, intensity: value?.intensity ?? null, drawer: value?.drawer ?? null, register: value?.register ?? null,
        source: value?.source ?? null, composure: handle.lines?.ledger.composure ?? 1 }));
    return safely(() => blockOf(handle, handle.decision), '');
  },
  /** D17 on the delegation's answer: the presentation id of the spoken reply (her stance, else its feeling, else her mood). */
  presented: (handle: FeelingTurnHandle | null, feeling: ShannonExpressiveEmotion, snapshot: CompanionStateSnapshot | null, at: string,
    utteranceId?: string) : { presentationId?: string } => {
    if (!handle?.port.singleFace || !snapshot) return {};
    return safely<{ presentationId?: string }>(() => {
      const stance = handle.decision && handle.decision.stance !== 'neutral' ? { kind: 'turn' as const, stance: handle.decision.stance } : undefined;
      const visible = feeling.visibility !== 'hidden' && feeling.primary !== 'neutral' ? { feeling: feeling.primary } : {};
      const extra = { mood: faceForMood(snapshot.emotion), ...visible, ...(stance ? { stance } : {}), ...turnHints(handle) };
      const state = faceState(handle.port, handle.scopeKey, handle.key, at, snapshot, extra);
      const id = presentFor(state, handle.key.audience, 'icon').id;
      handle.port.events.notePresented(handle.scopeKey, id, utteranceId ?? null, at);
      return { presentationId: id };
    }, {});
  },
  /**
   * D17 on the stored voice turn: the id its answer was presented with (review P2-3: stance included), else its face's. The same in front
   * of anyone (owner, 2026-10-14: 「嫉妬も甘えも出す」).
   */
  stored: (port: FeelingPort | null, emotion: ShannonMessageEmotion, turn: { scopeKey: string; utteranceId?: string; at: string }): ShannonMessageEmotion => {
    if (!port?.singleFace) return emotion;
    const id = safely(() => port.events.takePresented(turn.scopeKey, turn.utteranceId ?? null, turn.at), null) ?? presentationIdOf(emotion);
    return Object.freeze({ ...emotion, presentationId: id });
  },
  ended: (handle: FeelingTurnHandle | null, input: { at: string; transcript: string; reply: string; utteranceId?: string }) => {
    if (handle) safely(() => turnEnded(handle, { at: input.at, words: input.transcript, reply: input.reply, turnId: input.utteranceId ?? input.at,
      sourceId: input.utteranceId ? `utterance:${input.utteranceId}` : null }), undefined);
  },
});

/** A touch, as the body knows it: its id, kind, part, and who could see. */
export interface FeelingTouch {
  id: string;
  type: string;
  part?: string;
  audience: 'owner' | 'others';
  occurredAt: string;
  burstId: string;
  wordless?: boolean;
}

const touchKey = (audience: 'owner' | 'others'): FeelingKey => feelingActor({ ownerAlone: audience === 'owner' });

/** Her note's face, as an opinion in the one face (ADR-0012's `innerNoteFaceOf`). */
type BodyNoteFace = { shown?: ShannonEmotionKind; tell?: string; until?: string | null };

/** Her body's hooks (`bodyReaction.ts`, `shannonBody.ts`). A touch with anyone else present is never the owner's. */
export const feelingBody = Object.freeze({
  touched: (port: FeelingPort | null, scopeKey: string, touch: FeelingTouch, outcome: { stance?: string | null; said?: string | null; at?: string } = {}) => {
    if (!port) return;
    safely(() => {
      const key = touchKey(touch.audience);
      const identity = touch.audience === 'owner' ? 'registered' as const : 'unknown' as const;
      const base = { ...key, identity, channel: 'body' as const, sourceId: touch.burstId };
      const facts = { touchKind: touch.type, ...(touch.part ? { part: touch.part } : {}), ...(outcome.stance ? { stance: outcome.stance } : {}),
        ...(touch.wordless ? { wordless: true as const } : {}) };
      const event: FeelingEvent = { ...base, id: `touch:${touch.id}`, kind: 'touched', occurredAt: touch.occurredAt, facts };
      port.events.record(scopeKey, event);
      if (outcome.said) port.events.record(scopeKey, { ...base, id: `reply:body:${touch.id}`, kind: 'own_reply', occurredAt: outcome.at ?? touch.occurredAt,
        facts: replyFacts(outcome.said, drawersIn) });
    }, undefined);
  },
  /** The facts a touch line is told (the same ledger line, and the watch), for the touch's own audience. */
  lines: (port: FeelingPort | null, scopeKey: string, audience: 'owner' | 'others', at: string, snapshot: CompanionStateSnapshot): string => {
    if (!port) return '';
    const lines = port.events.linesFor(scopeKey, touchKey(audience), at, snapshot);
    return [lines?.ledgerLine ?? '', ...(lines?.carriedLines ?? []), lines?.repetitionLine ?? ''].filter(Boolean).join('\n');
  },
  /** The owner's day as one ledger line, for her inner note's reflection ('' without a port). */
  ledgerLine: (port: FeelingPort | null, scopeKey: string, at: string, snapshot: CompanionStateSnapshot): string =>
    (port ? port.events.linesFor(scopeKey, touchKey('owner'), at, snapshot)?.ledgerLine ?? '' : ''),
  /** What her inner note reads of her feeling events (at reflection, so the port may come later): the ledger, and as narrator the fast layer. */
  noteReader: (port: () => FeelingPort | null, snapshot: (scopeKey: string) => CompanionStateSnapshot) => ({
    ledger: (scopeKey: string, at: string) => feelingBody.ledgerLine(port(), scopeKey, at, snapshot(scopeKey)),
    fastLayer: (scopeKey: string, at: string): string | null => {
      const feeling = port();
      if (!feeling?.narrator || !feeling.coreAffect) return null;
      const core = foldFeelingDynamics(feeling.events.today(scopeKey, at, snapshot(scopeKey)), touchKey('owner')).core;
      return fastLayerWords(advanceCoreAffect(core, Date.parse(at)));
    },
    relationship: (scopeKey: string, at: string): string | null => {
      const feeling = port();
      if (!feeling?.days?.features.relationship) return null;
      return feeling.days.carried(scopeKey, touchKey('owner'), at, snapshot(scopeKey)).lines.join('\n');
    },
  }),
  /** The body's face (a reaction's `mood`, presence) under `SHANNON_SINGLE_FACE`; without it, the face as it was. */
  mood: <T extends { expression: string; feeling?: string; tell?: 'blush' }>(port: FeelingPort | null, scopeKey: string,
    audience: 'owner' | 'others' | undefined, at: string, snapshot: CompanionStateSnapshot, mood: T, note: BodyNoteFace | null): T => {
    if (!port?.singleFace) return mood;
    return safely(() => {
      const key = touchKey(audience === 'owner' ? 'owner' : 'others');
      const opinion = { ...(note?.shown ? { noteShown: note.shown } : {}), ...(note?.tell === 'blush' ? { tell: 'blush' as const } : {}) };
      const face = feelingFace(faceState(port, scopeKey, key, at, snapshot, { mood: faceForMood(snapshot.emotion), ...opinion }), key.audience);
      const { feeling: _feeling, tell: _tell, until: _until, ...rest } = mood as T & { until?: string };
      // Her note's `until` rides with its blush, for the owner alone (the face's tell is only ever given to him).
      const until = face.tell && note?.until ? { until: note.until } : {};
      const tell = face.tell ? { tell: face.tell } : {};
      return { ...rest, expression: face.expression, ...(face.feeling ? { feeling: face.feeling } : {}), ...tell, ...until } as T;
    }, mood);
  },
});

export { FEELING_TURN_HEADER };
