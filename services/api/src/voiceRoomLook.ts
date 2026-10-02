import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { ROOM_LOOK_UNAVAILABLE_REASON, asksToLook, type BodyLookUnavailable, type BodyLookVoiceTurn } from './bodyLook.js';
import type { VoiceDecisionInput, VoiceTurnDecision, VoiceTurnFacts } from './voiceDecisionContract.js';

/**
 * One look at the room from a voice conversation with the owner (owner decision 2026-10-02:
 * 「カメラ使っていいよ、自由に」; the rules of a look are those of `bodyLook.ts` and unchanged).
 *
 * A voice reply is streamed speech and cannot carry the structured `roomLook` field of a text
 * turn, so the choice is made before the reply:
 * - the owner asks in so many words (`asksForLookAloud`, a fixed rule on his words), or
 * - the decision gateway judges that a look is wanted or welcome (`room_look`, a model's judgement;
 *   this is the only way she looks without being asked, and it is not used on a transcript the
 *   gateway could not trust).
 * Either way the look is opened only by `BodyLooks`, after its own conditions passed twice
 * (when the turn began and when the reply was written). A word never opens a look that the
 * conditions refuse; then the turn is told the real reason instead.
 *
 * `SHANNON_VOICE_ROOM_LOOK=off` removes the look from voice turns and the question from the gateway.
 */
type Environment = Readonly<Record<string, string | undefined>>;

export function voiceRoomLookEnabled(environment: Environment = process.env): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_VOICE_ROOM_LOOK?.trim().toLowerCase() ?? '');
}

/**
 * How sure the gateway must be before she looks without being asked in so many words
 * (`SHANNON_VOICE_ROOM_LOOK_THRESHOLD`). Its own value: opening a camera asks for more than choosing a capability does.
 */
function lookThreshold(environment: Environment): number {
  const value = environment.SHANNON_VOICE_ROOM_LOOK_THRESHOLD?.trim();
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.85;
}

/** A request to look, and "can you see". The plain progressive (「見てる」) is neither: 「僕もニュース見てるよ」. */
const LOOK = '(?:見て|のぞいて|写して|映して)';
const CAN_SEE = '(?:見える|見えてる|見えます|見えてます|見れる|見れます|見られる)';
/**
 * The owner himself as what is looked at (「僕のこと」「僕が」「僕を」), never as the one who sees (「私は見えるよ」「僕も見れる」),
 * or where he is. Not 「ここ」「これ」「外」「周り」: those are as often a screen, a document, the weather, a video call.
 */
const ME = '(?:僕|ぼく|ボク|俺|おれ|私|わたし)(?:(?:のこと|の顔|の姿|の様子)(?:が|を)?|が|を)';
const ROOM = '(?:部屋|机|手元)(?:の中|の様子|の上)?(?:が|を)?';
/** What may close the clause after the verb, each part once and in this order: 「見てみて」「見てくれる」「見えるかな」「見てほしいんだけど」. */
const TAIL = '(?:みて)?(?:ほしい|欲しい|くれる|くれない|くれ|もらえる|ください)?(?:んだけど|けど)?(?:かな|か|の|よね|よ|ね|な)?';
/**
 * What may stand before the object. The clause is the request from its first word: 「子供部屋を見て」「昔の僕を見て」
 * 「ビデオカメラで見て」「窓から何が見える」 are about something else.
 */
const LEAD = '^(?:もちろん|そう|うん|はい|それじゃあ?|じゃあ?|なら|ねえ|ねぇ|シャノン|今|いま|ちょっと|もう一回|もう一度)*';
/**
 * Said plainly: himself as what is looked at, or leave to use her camera. These stand without a model's judgement, so they
 * are read narrowly: the whole utterance is the request (「田中さんなら、カメラ使っていいよ」 is not), he is the object and not
 * the one who can watch (「録画、私が見れるよ」), and nothing reports someone else's doing (「僕を見てくれない」).
 */
const PLAIN_TAIL = '(?:みて)?(?:ほしい|欲しい|ください)?(?:かな|か|よ|ね)?';
const PLAIN_ASKS = [
  new RegExp(`${LEAD}(?:僕|ぼく|ボク|俺|おれ|私|わたし)(?:(?:のこと|の顔|の姿|の様子)(?:が|を)?(?:${LOOK}|${CAN_SEE})|を${LOOK}|が(?:見える|見えてる|見えます|見えてます))${PLAIN_TAIL}$`, 'u'),
  // A statement of leave, not his own question (「カメラ使っていいかな」).
  new RegExp(`${LEAD}(?:体の)?カメラ(?:を|は)?使って(?:も)?(?:いい|大丈夫)(?:だよ|です|よ|ね)?(?:自由に|好きに|いつでも|どうぞ)?$`, 'u'),
];
/** The same forms as one clause among others, or with a looser ending: a model tier has to agree. */
const CLAUSE_ASKS = [
  new RegExp(`${LEAD}${ME}(?:${LOOK}|${CAN_SEE})${TAIL}$`, 'u'),
  new RegExp(`${LEAD}(?:体の)?カメラ(?:を|は)?使って(?:も)?(?:いい|大丈夫)(?:だよ|です|から|よ|ね)?(?:自由に|好きに|いつでも|どうぞ)?$`, 'u'),
];
/** A request to look that the words alone do not settle: a room (whose?), 「こっち」, a camera (which?), "what can be seen" (by whom?). */
const AMBIGUOUS_ASKS = [
  new RegExp(`${LEAD}(?:この)?${ROOM}(?:${LOOK}|${CAN_SEE})${TAIL}$`, 'u'),
  new RegExp(`${LEAD}(?:こっち|こちら)を?${LOOK}${TAIL}$`, 'u'),
  new RegExp(`${LEAD}(?:体の)?カメラ(?:で|を|から|越しに)?(?:${LOOK}|${CAN_SEE})${TAIL}$`, 'u'),
  new RegExp(`${LEAD}(?:そこから)?(?:何|なに)が見え(?:る|てる|ます|てます)(?:かな|か|の)?$`, 'u'),
];
/** 「見てみて」「じゃあ見て」「見てよ」: a request only as the answer to her own offer to look. */
const BARE_ASK = new RegExp(`${LEAD}${LOOK}${TAIL}$`, 'u');
/** Her own line offers a look at the room or at him: 「見てみましょうか？」「見てと言ってくれれば見られます」, not 「その資料、ボクが見てみましょうか？」. */
const HER_OFFER = [/^(?:ちょっと|一度|今|いま|部屋を|カメラで)*見て(?:みましょうか|もいいですか|みてもいいですか)$/u, /見てと言/u, /^(?:いつでも|カメラで|部屋を)*見られます/u];
const OFFER_OPEN_SECONDS = 60;
const REFUSES = /見ないで|見なくて|見るな|使わないで|切って|オフ|やめて|って(?:聞かれ|言われ|言っ)/u;
const CLAUSE_CHARACTERS = 40;

function clauses(transcript: string): string[] {
  const text = transcript.normalize('NFKC');
  if (REFUSES.test(text)) return [];
  return text.split(/[、。，,.!！?？…\n]/u).map(clause => clause.replace(/\s/gu, '')).filter(clause => clause.length > 0 && clause.length <= CLAUSE_CHARACTERS);
}
const matches = (transcript: string, patterns: readonly RegExp[]) => clauses(transcript).some(clause => patterns.some(pattern => pattern.test(clause)));

/**
 * How the owner's words ask her to look now, if they do. `plain`: the whole utterance, with its commas removed, is one
 * of the two plain requests, and stands by itself. `ambiguous`: one short clause is a request from its first word to its
 * last (「私も見てみたい映画がある」 is not one), and a model tier has to agree. null is no request.
 */
export function lookRequest(transcript: string): 'plain' | 'ambiguous' | null {
  const parts = clauses(transcript);
  const whole = parts.join('');
  if (whole.length > 0 && whole.length <= CLAUSE_CHARACTERS && PLAIN_ASKS.some(pattern => pattern.test(whole))) return 'plain';
  return parts.some(clause => [...CLAUSE_ASKS, ...AMBIGUOUS_ASKS].some(pattern => pattern.test(clause))) ? 'ambiguous' : null;
}
/** Either kind. */
export const asksForLookAloud = (transcript: string): boolean => lookRequest(transcript) !== null;
/** A bare 「見て」 right after she herself offered to look. */
const acceptsHerOffer = (transcript: string, offered: string | undefined) => offered !== undefined
  && clauses(offered).some(clause => HER_OFFER.some(pattern => pattern.test(clause))) && matches(transcript, [BARE_ASK]);

const ROUTER_INSTRUCTIONS = 'Would one look through the camera of her desktop body be right now? True when the speaker asks her to look at him, at the room, or at something he is showing, or asks what she can see; also when he is clearly showing her something, so that one look is what he would welcome. False for talk about cameras, photos, screens, notes or seeing in general, for past or hypothetical looking, and when he asks her not to look.';
const ROUTER_QUESTION = Object.freeze({
  type: 'noul', instructions: ROUTER_INSTRUCTIONS,
  criteria: { true: 'One look through her body\'s camera now is asked for or clearly welcome.', false: 'No look is wanted now.' },
});

/** The question is asked only in a call with the owner alone: nowhere else can a look be taken. */
const routed = (input: VoiceDecisionInput) => voiceRoomLookEnabled()
  && input.participantMode === 'owner' && input.turn !== undefined && !input.turn.othersPresent;

/** Jev: one more Noul beside the capabilities. */
export function roomLookRouterQuestions(input: VoiceDecisionInput): Array<[string, typeof ROUTER_QUESTION]> {
  return routed(input) ? [['room_look', ROUTER_QUESTION]] : [];
}

/** The OpenAI fallback: one more probability in the strict schema, and its instruction line. */
export function roomLookRouterSchema(input: VoiceDecisionInput): {
  instructions: string[]; properties: Record<string, { type: 'number'; minimum: 0; maximum: 1 }>; required: string[];
} {
  if (!routed(input)) return { instructions: [], properties: {}, required: [] };
  return {
    instructions: [`roomLookProbability: ${ROUTER_INSTRUCTIONS}`],
    properties: { roomLookProbability: { type: 'number', minimum: 0, maximum: 1 } }, required: ['roomLookProbability'],
  };
}

/** The router's answer, when it gave one. A malformed value is no answer; it never fails the decision. */
export function roomLookAnswer(value: unknown): { roomLookProbability?: number } {
  const probability = value !== null && typeof value === 'object' ? (value as { noul?: unknown }).noul : value;
  return typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1
    ? { roomLookProbability: probability } : {};
}

const AFTERWARDS = '見えたものはこの返事のあとで別の発言として届く。この返事では「見てみますね」のように短く伝えるだけにして、まだ見ていないものを語らない。カメラの許可や接続の不具合など、起きていないことを言わない';
/** The reply of a turn in which the look is taken. */
export const voiceRoomLookPrompt = (asked: boolean) => `[部屋を見る]（${asked
  ? `${SHANNON_OWNER_NAME}に見てと言われたので、この返事のあと体のカメラで部屋を一度だけ見る。`
  : 'いまの話から自分で見たくなったので、この返事のあと体のカメラで部屋を一度だけ見る。'}${AFTERWARDS}）`;
/** The camera was mentioned, nobody chose a look, and she could take one. */
export const VOICE_ROOM_LOOK_READY_PROMPT = `[部屋を見る]（いまは体のカメラで部屋を一度見られる状態。この返事では見ない。${SHANNON_OWNER_NAME}に見てと言われたら見られる、と伝えてよい。見えたものや、カメラの許可・接続の不具合を作って言わない）`;

export type VoiceRoomLookUnavailable = BodyLookUnavailable;
/** She cannot look: the server's own reason, and nothing else, in one short sentence. */
export const voiceRoomLookUnavailablePrompt = (reason: VoiceRoomLookUnavailable) =>
  `[部屋を見る]（体のカメラで見てほしいという頼みなら、いまは見られない。本当の理由: ${ROOM_LOOK_UNAVAILABLE_REASON[reason]}。`
  // 「体からの知らせが届いていない」 is itself about the link to her body, so that reason does not forbid the word.
  + `この理由だけを短い一文で正直に伝える。見たふりをしない。カメラの許可、${reason === 'body_away' ? '' : '接続、'}画像が届かないなど、ここに書かれていない原因を作って言わない）`;

export interface VoiceRoomLookTurn {
  /** One line for the turn's prompt, or empty. */
  prompt: string;
  /** Why the look this turn mentioned cannot be taken; absent when it can, or when nobody mentioned one. */
  unavailable?: VoiceRoomLookUnavailable;
  /** Called with her finished reply. Opens the look only when this turn chose one and the conditions still hold. */
  open(threadId: string, reply: string): boolean;
  /**
   * The call was cut off after she had begun to say that she would look (`said` is what was spoken so far):
   * no look is opened, and one honest line is left. Nothing happens once `open` ran, or when she had said nothing.
   */
  cutOff(threadId: string, said: string): void;
}

/** The fixed rule on his words is set aside when the gateway is this sure that no look is wanted. */
const ASKED_CONTRADICTED_BELOW = 0.2;
/** Looser words (「見てみて」「これ見て」) count as a request when the gateway is at least this sure. */
const LOOSE_ASK_CONFIRMED_FROM = 0.5;
const NO_LOOK: VoiceRoomLookTurn = Object.freeze({ prompt: '', open: () => false, cutOff: () => undefined });
const cannot = (reason: VoiceRoomLookUnavailable): VoiceRoomLookTurn => ({ ...NO_LOOK, prompt: voiceRoomLookUnavailablePrompt(reason), unavailable: reason });

/**
 * What one voice turn is told about looking, and the way to open the look afterwards.
 * `audience` is `owner` only for the owner alone in 本人だけ: 「友人も一緒」, an owner call with
 * someone listening, and a stream all read `others`, and end a look that is in progress.
 * `facts` are the facts of the moment: her own last line counts as an offer only when this utterance follows it within a minute.
 * With `SHANNON_VOICE_ROOM_LOOK=off` nothing here runs: a voice turn is what it was before voice could look.
 */
export function voiceRoomLookTurn(
  looks: { voiceTurn(scopeKey: string, at: string, audience: unknown): BodyLookVoiceTurn } | undefined,
  turn: { scopeKey: string; transcript: string; at: string; audience: 'owner' | 'others'; decision: VoiceTurnDecision; uncertain: boolean; facts?: VoiceTurnFacts },
  environment: Environment = process.env,
): VoiceRoomLookTurn {
  if (!looks || !voiceRoomLookEnabled(environment)) return NO_LOOK;
  // Every voice turn passes here, as every text turn passes `BodyLooks.turn`: a turn other people hear withdraws an open look.
  const state = looks.voiceTurn(turn.scopeKey, turn.at, turn.audience);
  if (!turn.decision.shouldRespond) return NO_LOOK;
  const score = turn.decision.roomLookProbability;
  // Words a model tier scored as unreliable open nothing.
  const distrusted = turn.uncertain && turn.decision.transcriptReliabilityProbability !== undefined;
  const request = lookRequest(turn.transcript);
  const loose = asksToLook(turn.transcript);
  const facts = turn.facts;
  const offered = facts?.followsShannon && facts.secondsSinceShannon !== undefined && facts.secondsSinceShannon <= OFFER_OPEN_SECONDS ? facts.shannonLastLine : undefined;
  // His words ask for it: plainly (then only a model tier that is sure of the opposite sets it aside); or in words that need
  // a model tier's judgement not to disagree, which the local tier cannot give; or loosely, when the gateway is fairly sure;
  // or with a bare 「見て」 in answer to her own offer.
  const asked = !distrusted && (
    (request === 'plain' && (score ?? 1) >= ASKED_CONTRADICTED_BELOW)
    || (request === 'ambiguous' && score !== undefined && score >= ASKED_CONTRADICTED_BELOW)
    || (loose && score !== undefined && score >= LOOSE_ASK_CONFIRMED_FROM)
    || (acceptsHerOffer(turn.transcript, offered) && (score ?? 1) >= ASKED_CONTRADICTED_BELOW));
  // Her own wish to look comes only from the gateway's judgement, and not from words it could not trust.
  const judged = !turn.uncertain && (score ?? 0) >= lookThreshold(environment);
  const mentioned = asked || judged || request !== null || loose;
  if (!mentioned) return NO_LOOK;
  if (state.unavailable) return cannot(state.unavailable);
  if (!asked && !judged) return { ...NO_LOOK, prompt: VOICE_ROOM_LOOK_READY_PROMPT };
  let settled = false;
  return {
    prompt: voiceRoomLookPrompt(asked),
    // She says aloud that she will look, so a look that then does not happen always gets her one honest line (`asked`).
    open: (threadId, reply) => {
      settled = true;
      return state.open(threadId, 'asked', [
        { role: 'user', content: turn.transcript }, ...(reply.trim() ? [{ role: 'assistant' as const, content: reply.trim() }] : []),
      ]);
    },
    cutOff: (threadId, said) => {
      // Only when what was spoken had reached the looking (「見てみますね」): 「そうなんですね、」 promised nothing.
      if (settled || !/見/u.test(said)) return;
      settled = true;
      state.cutOff(threadId);
    },
  };
}
