import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { ROOM_LOOK_UNAVAILABLE_REASON, asksToLook, type BodyLookUnavailable, type BodyLookVoiceTurn } from './bodyLook.js';
import type { VoiceDecisionInput, VoiceTurnDecision } from './voiceDecisionContract.js';

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
const ROOM = '(?<!次の|隣の|別の)(?:部屋|机|手元)(?:の中|の様子|の上)?(?:が|を)?';
/** What may close the clause after the verb, each part once and in this order: 「見てみて」「見てくれる」「見えるかな」「見てほしいんだけど」. */
const TAIL = '(?:みて)?(?:ほしい|欲しい|くれる|くれない|くれ|もらえる|ください)?(?:んだけど|けど)?(?:かな|か|の|よね|よ|ね|な)?';
/** The object stands directly before the verb: 「僕の予定見て」「カメラの設定を見て」 are about something else. */
const ASKS = [
  new RegExp(`(?:${ME}|${ROOM})(?:${LOOK}|${CAN_SEE})${TAIL}$`, 'u'),
  // 「こっち見て」 is a request; 「こっちは見えてるよ」 is a video call.
  new RegExp(`(?:こっち|こちら)を?${LOOK}${TAIL}$`, 'u'),
  // Her camera, with leave to use it; not some other camera (「このカメラ使ってみて」「スマホのカメラで見て」).
  new RegExp(`(?<!防犯|監視|この|その|新しい|スマホの|レフ)カメラ(?:で|を|から|越しに)?(?:${LOOK}|${CAN_SEE}|使って(?:も)?(?:いい|大丈夫))${TAIL}(?:自由に|好きに|いつでも|どうぞ)?$`, 'u'),
  /(?:何|なに)が見え(?:る|てる|ます|てます)(?:かな|か|の)?$/u,
];
const REFUSES = /見ないで|見なくて|見るな|使わないで|切って|オフ|やめて|って(?:聞かれ|言われ)/u;
const CLAUSE_CHARACTERS = 40;

/**
 * The owner asks her, in so many words, to look now. Judged clause by clause, and only where a short
 * clause ends on the looking: 「私も見てみたい映画がある」 is not a request.
 */
export function asksForLookAloud(transcript: string): boolean {
  const text = transcript.normalize('NFKC');
  if (REFUSES.test(text)) return false;
  return text.split(/[、。，,.!！?？…\n]/u).map(clause => clause.replace(/\s/gu, ''))
    .some(clause => clause.length > 0 && clause.length <= CLAUSE_CHARACTERS && ASKS.some(pattern => pattern.test(clause)));
}

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

export type VoiceRoomLookUnavailable = BodyLookUnavailable | 'voice_off';
const VOICE_OFF_REASON = '声の会話で部屋を見る機能は止めてある';
/** She cannot look: the server's own reason, and nothing else, in one short sentence. */
export const voiceRoomLookUnavailablePrompt = (reason: VoiceRoomLookUnavailable) =>
  `[部屋を見る]（体のカメラで見てほしいという頼みなら、いまは見られない。本当の理由: ${reason === 'voice_off' ? VOICE_OFF_REASON : ROOM_LOOK_UNAVAILABLE_REASON[reason]}。`
  // 「体からの知らせが届いていない」 is itself about the link to her body, so that reason does not forbid the word.
  + `この理由だけを短い一文で正直に伝える。見たふりをしない。カメラの許可、${reason === 'body_away' ? '' : '接続、'}画像が届かないなど、ここに書かれていない原因を作って言わない）`;

export interface VoiceRoomLookTurn {
  /** One line for the turn's prompt, or empty. */
  prompt: string;
  /** Why the look this turn mentioned cannot be taken; absent when it can, or when nobody mentioned one. */
  unavailable?: VoiceRoomLookUnavailable;
  /** Called with her finished reply. Opens the look only when this turn chose one and the conditions still hold. */
  open(threadId: string, reply: string): boolean;
}

/** The fixed rule on his words is set aside when the gateway is this sure that no look is wanted. */
const ASKED_CONTRADICTED_BELOW = 0.2;
const NO_LOOK: VoiceRoomLookTurn =Object.freeze({ prompt: '', open: () => false });
const cannot = (reason: VoiceRoomLookUnavailable): VoiceRoomLookTurn => ({ prompt: voiceRoomLookUnavailablePrompt(reason), unavailable: reason, open: () => false });

/**
 * What one voice turn is told about looking, and the way to open the look afterwards.
 * `audience` is `owner` only for the owner alone in 本人だけ: 「友人も一緒」, an owner call with
 * someone listening, and a stream all read `others`, and end a look that is in progress.
 */
export function voiceRoomLookTurn(
  looks: { voiceTurn(scopeKey: string, at: string, audience: unknown): BodyLookVoiceTurn } | undefined,
  turn: { scopeKey: string; transcript: string; at: string; audience: 'owner' | 'others'; decision: VoiceTurnDecision; uncertain: boolean },
  environment: Environment = process.env,
): VoiceRoomLookTurn {
  if (!looks) return NO_LOOK;
  // Every voice turn passes here, as every text turn passes `BodyLooks.turn`: a turn other people hear withdraws an open look.
  const state = looks.voiceTurn(turn.scopeKey, turn.at, turn.audience);
  if (!turn.decision.shouldRespond) return NO_LOOK;
  // His words ask for it, and a model tier that also judged the turn did not say plainly that no look is wanted.
  // Nor on words a model tier scored as unreliable; with no model's score (the local tier) his words are taken as heard.
  const distrusted = turn.uncertain && turn.decision.transcriptReliabilityProbability !== undefined;
  const asked = !distrusted && asksForLookAloud(turn.transcript) && (turn.decision.roomLookProbability ?? 1) >= ASKED_CONTRADICTED_BELOW;
  // Her own wish to look comes only from the gateway's judgement, and not from words it could not trust.
  const judged = !turn.uncertain && (turn.decision.roomLookProbability ?? 0) >= lookThreshold(environment);
  const mentioned = asked || judged || asksToLook(turn.transcript);
  if (!mentioned) return NO_LOOK;
  if (!voiceRoomLookEnabled(environment)) return cannot('voice_off');
  if (state.unavailable) return cannot(state.unavailable);
  if (!asked && !judged) return { ...NO_LOOK, prompt: VOICE_ROOM_LOOK_READY_PROMPT };
  return {
    prompt: voiceRoomLookPrompt(asked),
    // She says aloud that she will look, so a look that then does not happen always gets her one honest line (`asked`).
    open: (threadId, reply) => state.open(threadId, 'asked', [
      { role: 'user', content: turn.transcript }, ...(reply.trim() ? [{ role: 'assistant' as const, content: reply.trim() }] : []),
    ]),
  };
}
