import { voiceLookCamera, type AppLookAsk } from './appLookContract.js';
import { VOICE_APP_LOOK_READY_PROMPT, appLookUnavailablePrompt, voiceAppLookPrompt } from './appLookLines.js';
import type { BodyLookVoiceTurn } from './bodyLook.js';
import type { VoiceLooks } from './conversationLooks.js';
import { VOICE_ROOM_LOOK_READY_PROMPT, voiceRoomLookPrompt, voiceRoomLookTurn, type VoiceRoomLookTurn } from './voiceRoomLook.js';

export type { VoiceLooks } from './conversationLooks.js';

/**
 * One look from a voice turn, through her body or through the app the turn came from (`conversationLooks.ts` says which).
 *
 * Whether to look is decided exactly as for her body, by `voiceRoomLookTurn`: his words ask for it, or the decision
 * gateway judges that a look is wanted or welcome, and never on words it could not trust or a turn she does not answer.
 * For a turn from an app the same function is run against the app's camera instead of her body's; only the wording of
 * the prompt, the camera, and the way the ask travels differ:
 * - the ask is returned in the response of the turn (`appLook`), not read from `presence`;
 * - other people listening beside the owner do not stop it (he aims the camera himself), but then she looks only when
 *   asked: with several people talking, whose remark it was is too uncertain for a look of her own choosing. A 「友人も一緒」
 *   turn never opens one;
 * - the camera is the router's judgement (`lookSelfProbability`), or a narrow rule on his words when it gave none.
 *
 * `SHANNON_VOICE_ROOM_LOOK=off` is about her body and does not switch the app off; `SHANNON_APP_LOOK=off` does.
 */
export interface VoiceLookTurn extends Omit<VoiceRoomLookTurn, 'unavailable'> {
  /** Spread into the response of the turn once `open` ran: the ask the app answers, when a look through it was opened. */
  ask(): { appLook?: AppLookAsk };
}

type Turn = Parameters<typeof voiceRoomLookTurn>[1] & {
  /** 「友人も一緒」: the words may not be the owner's. */
  guest: boolean;
};

/** The owner's plain request through the app, as the whole utterance: 「これ見れる？」「ねえ、これ見える？」「ここ見て」. */
const PLAIN_APP_ASK = /^(?:ねえ|ねぇ|シャノン|ちょっと)*(?:これ|ここ|こっち|これって|ここって)(?:が|は|を)?(?:見れる|見れます|見える|見えます|見えてる|見られる|見て|見てみて|見てよ|見てくれる)(?:かな|か|の)?$/u;

const viaBody = (turn: VoiceRoomLookTurn): VoiceLookTurn => ({ prompt: turn.prompt, open: turn.open, cutOff: turn.cutOff, ask: () => ({}) });

export function voiceLookTurn(looks: VoiceLooks | undefined, turn: Turn, environment: Readonly<Record<string, string | undefined>> = process.env): VoiceLookTurn {
  // Her body first, always: its bookkeeping runs on every voice turn, whoever looks.
  const body = voiceRoomLookTurn(looks?.body, turn, environment);
  const client = looks?.client;
  if (!looks || !client) return viaBody(body);
  try {
    const camera = voiceLookCamera(turn.transcript, turn.decision.lookSelfProbability);
    const app = looks.app.turn(turn.scopeKey, turn.at, client, { guest: turn.guest, guarded: turn.audience !== 'owner' });
    let ask: AppLookAsk | null = null;
    // The app as the camera of `voiceRoomLookTurn`. Its reason for not looking is worded below, so any value stands in here.
    const state: BodyLookVoiceTurn = {
      unavailable: app.unavailable ? 'switched_off' : null,
      open: (threadId, _choice, spoken, turnId) => (ask = app.open(threadId, camera, spoken ?? [], turnId)) !== null,
      cutOff: (threadId, said, turnId) => app.cutOff(threadId, said, turnId),
    };
    const guarded = turn.audience !== 'owner';
    const score = turn.decision.roomLookProbability;
    // With other people there, whose words they were is uncertain: a model tier has to agree that a look is asked for
    // (words alone open nothing), and its judgement never opens a look by itself.
    if (guarded && score === undefined && !app.unavailable) return { prompt: '', open: () => false, cutOff: () => undefined, ask: () => ({}) };
    // Alone with her, 「これ見れる？」 said as the whole utterance is a request even when no model tier answered.
    const plain = !guarded && score === undefined && PLAIN_APP_ASK.test(turn.transcript.normalize('NFKC').replace(/[\s、。，,.!！?？…]/gu, ''));
    const decided = plain ? { ...turn, decision: { ...turn.decision, roomLookProbability: 1 } }
      : guarded && score !== undefined ? { ...turn, decision: { ...turn.decision, roomLookProbability: Math.min(score, 0.99) } } : turn;
    // The app's camera is aimed by the owner himself: for it, a turn other people hear is judged like one of his alone.
    const chosen = voiceRoomLookTurn({ voiceTurn: () => state }, { ...decided, audience: 'owner' },
      { ...environment, SHANNON_VOICE_ROOM_LOOK: 'on', ...(guarded ? { SHANNON_VOICE_ROOM_LOOK_THRESHOLD: '1' } : {}) });
    if (app.unavailable) {
      // The app cannot look now. Her body may, under its own rules; when neither can, the app's reason is the true one for this turn.
      if (body.prompt && !body.unavailable) return viaBody(body);
      return { prompt: chosen.prompt ? appLookUnavailablePrompt(app.unavailable, client.platform) : '', open: () => false, cutOff: () => undefined, ask: () => ({}) };
    }
    if (!chosen.prompt) return viaBody(chosen);
    if (chosen.prompt === VOICE_ROOM_LOOK_READY_PROMPT) return { ...viaBody(chosen), prompt: VOICE_APP_LOOK_READY_PROMPT };
    return {
      prompt: voiceAppLookPrompt(chosen.prompt === voiceRoomLookPrompt(true), camera),
      open: chosen.open, cutOff: chosen.cutOff, ask: () => (ask ? { appLook: ask } : {}),
    };
  } catch { return viaBody(body); }
}
