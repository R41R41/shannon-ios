import { objectBody } from './apiValidation.js';
import type { VoiceTurnDecision } from './voiceDecisionContract.js';

/**
 * 「友人も一緒」 call context. The turns live only in the running call on the device and are
 * sent with each request; the server never writes them to conversation or experience tables.
 */
export interface GuestCallTurn {
  role: 'participant' | 'shannon';
  text: string;
}

export interface GuestCallContext {
  turns: readonly GuestCallTurn[];
  /** The device heard 「シャノン」 as an address in the current utterance. */
  addressedByName: boolean;
  /** The utterance began while Shannon was speaking or shortly after she finished. */
  followsShannonTurn: boolean;
  /** First request after the owner switched to 「友人も一緒」. */
  introductionStart: boolean;
  /** Identifies this 「友人も一緒」 period so it can be remembered. Absent from clients that predate people memory. */
  callId?: string;
}

export const GUEST_CALL_MODEL_TURNS = 24;
export const GUEST_CALL_SUMMARY_TURNS = 60;
const MAXIMUM_ACCEPTED_TURNS = 120;
const MAXIMUM_TURN_CHARACTERS = 600;
/** A statement longer than this, right after Shannon spoke, is the people explaining to each other. */
const REACTION_MAXIMUM_CHARACTERS = 28;

export function validatedGuestCallTurns(value: unknown, limit: number): GuestCallTurn[] | false {
  if (!Array.isArray(value) || value.length > MAXIMUM_ACCEPTED_TURNS) return false;
  const turns: GuestCallTurn[] = [];
  for (const item of value) {
    if (!objectBody(item) || (item.role !== 'participant' && item.role !== 'shannon')
      || typeof item.text !== 'string' || item.text.length > 8_000) return false;
    const text = Array.from(item.text.trim().replace(/\s+/gu, ' ')).slice(0, MAXIMUM_TURN_CHARACTERS).join('');
    if (text) turns.push({ role: item.role, text });
  }
  return turns.slice(-limit);
}

export function validatedGuestCallContext(value: unknown): GuestCallContext | null | false {
  if (value === undefined || value === null) return null;
  if (!objectBody(value)) return false;
  const turns = validatedGuestCallTurns(value.turns ?? [], GUEST_CALL_MODEL_TURNS);
  if (turns === false) return false;
  for (const flag of ['addressedByName', 'followsShannonTurn', 'introductionStart'] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') return false;
  }
  if (value.callId !== undefined && (typeof value.callId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/u.test(value.callId))) return false;
  return {
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
    turns,
    addressedByName: value.addressedByName === true,
    followsShannonTurn: value.followsShannonTurn === true,
    introductionStart: value.introductionStart === true,
  };
}

/** Model history for this call only: participant speech is the user side. */
export function guestCallHistory(
  context: GuestCallContext | null | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of context?.turns ?? []) {
    const role = turn.role === 'shannon' ? 'assistant' as const : 'user' as const;
    const last = history[history.length - 1];
    // Several things said while Shannon stayed quiet read as one stretch of table talk.
    if (last && last.role === role) last.content = `${last.content}\n${turn.text}`;
    else history.push({ role, content: turn.text });
  }
  return history;
}

export type GuestAddressReason =
  | 'typed' | 'introduction' | 'named' | 'question' | 'request' | 'social' | 'reaction'
  | 'table_talk' | 'explanation';

export interface GuestAddressDecision {
  respond: boolean;
  reason: GuestAddressReason;
}

const NAME = /シャノン|しゃのん|shannon/iu;
const QUESTION_WORDS = [
  '[?？]',
  '(?:何|なに)(?![かも])', 'なん(?:で|の)', 'なぜ', 'どんな', 'どっち',
  'どう(?![もかせぞ])', '(?:どこ|どれ|誰|だれ)(?![かも])', 'いつ(?![もか])', 'いく(?:つ|ら)',
];
const QUESTION = new RegExp([
  ...QUESTION_WORDS,
  '(?:か|かな|かい|っけ|でしょ|でしょう|だろ|だろう|よね|の)[。.!！…]*$',
].join('|'), 'u');
const REQUEST = /(?:ください|下さい|くれる|くれない|もらえる|ちょうだい|お願い|教えて|見せて|聞かせて|話して|歌って|言って|やってみて|してみて|してよ|答えて)[よねな]?[。.!！…]*$/u;
const SOCIAL = /^(?:はじめまして|初めまして|こんにちは|こんばんは|おはよう|よろしく|ありがとう|またね|また話そう|また後で|またあとで|じゃあね|バイバイ|おやすみ|すごい|可愛い|かわいい)/u;

/**
 * The same evidence, for the owner's own call (`voiceSilence.ts`): her name, a question mark or a question
 * word (a sentence-final particle alone is not enough there), a request, a greeting.
 */
export const ADDRESS_EVIDENCE = Object.freeze({
  name: NAME, questionWord: new RegExp(QUESTION_WORDS.join('|'), 'u'), request: REQUEST, social: SOCIAL,
});

/**
 * Whether Shannon should answer an utterance heard at a shared table. Conservative on purpose:
 * she stays quiet only for a plain statement that neither names her, nor asks or requests
 * something, nor reacts to what she just said.
 */
export function guestAddressDecision(
  transcript: string,
  context: GuestCallContext | null | undefined,
  source?: 'speech' | 'typed' | 'camera',
): GuestAddressDecision {
  if (source === 'typed' || source === 'camera') return { respond: true, reason: 'typed' };
  if (!context) return { respond: true, reason: 'typed' };
  if (context.introductionStart) return { respond: true, reason: 'introduction' };
  const text = transcript.trim();
  if (context.addressedByName || NAME.test(text)) return { respond: true, reason: 'named' };
  if (QUESTION.test(text)) return { respond: true, reason: 'question' };
  if (REQUEST.test(text)) return { respond: true, reason: 'request' };
  if (SOCIAL.test(text)) return { respond: true, reason: 'social' };
  if (!context.followsShannonTurn) return { respond: false, reason: 'table_talk' };
  const length = Array.from(text.replace(/[\s、。,.!！…「」]/gu, '')).length;
  return length <= REACTION_MAXIMUM_CHARACTERS
    ? { respond: true, reason: 'reaction' }
    : { respond: false, reason: 'explanation' };
}

/** Applies the table rule after the router. Named or first turns answer even if the router said silence. */
export function applyGuestAddressing(
  decision: VoiceTurnDecision,
  address: GuestAddressDecision,
): VoiceTurnDecision {
  if (!address.respond) {
    const { waitingDirection: _waiting, ...rest } = decision;
    return { ...rest, shouldRespond: false, conversationClass: 'no_response' };
  }
  if (!decision.shouldRespond && (address.reason === 'introduction' || address.reason === 'named')) {
    return { ...decision, shouldRespond: true, conversationClass: 'direct' };
  }
  return decision;
}

/** The last `limit` turns of a history, each one line of at most 600 characters (the voice router's and a guest call's window). */
export function boundedVoiceHistory(
  history: readonly { role: 'user' | 'assistant'; content: string }[],
  limit: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.slice(-limit).map(item => ({
    role: item.role,
    content: Array.from(item.content.trim().replace(/\s+/gu, ' ')).slice(0, 600).join(''),
  })).filter(item => item.content.length > 0);
}
