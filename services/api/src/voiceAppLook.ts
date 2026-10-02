import { voiceLookCamera, type AppLookAsk } from './appLookContract.js';
import {
  LOOK_NOT_SEEN_GUARD, VOICE_APP_LOOK_OFFER_PROMPT, announcesCameraLook, appLookUnavailablePrompt, voiceAppLookPrompt,
} from './appLookLines.js';
import type { BodyLookVoiceTurn } from './bodyLook.js';
import type { VoiceLooks } from './conversationLooks.js';
import { VOICE_ROOM_LOOK_READY_PROMPT, voiceRoomLookPrompt, voiceRoomLookTurn, type VoiceRoomLookTurn } from './voiceRoomLook.js';

export type { VoiceLooks } from './conversationLooks.js';

/**
 * One look from a voice turn, through her body or through the app the turn came from (`conversationLooks.ts` says which).
 *
 * For a turn from an app that can look, two things open a look:
 * - before the reply, exactly as for her body (`voiceRoomLookTurn` run against the app's camera): his words ask for it or
 *   the decision gateway judges that a look is wanted, and the reply is told that she looks;
 * - or, when nothing decided it beforehand, she herself: the reply is told that she may look and that the words
 *   「カメラで見てみますね」 are what opens it. A look she announces is then taken, never left as a promise. This is what
 *   makes the look work when the gateway gave no answer, or did not trust a spoken transcript (production, 2026-10-02:
 *   six turns in which she said she would look and nothing was opened).
 *
 * In every other turn she is told as a fact that this reply sees nothing and that she has seen nothing unless the Talk
 * says so, and a look announced anyway gets her one honest fixed line.
 *
 * - The ask is returned in the response of the turn (`appLook`), not read from `presence`.
 * - Other people listening beside the owner do not stop it (he aims the camera himself): she looks when asked and when
 *   curious, as when alone, but only with a model tier's agreement, never on words alone or on her own announcement.
 *   A 「友人も一緒」 turn never opens one.
 * - The camera is the router's judgement (`lookSelfProbability`), or a narrow rule on his words when it gave none.
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
const PLAIN_APP_ASK = /^(?:ねえ|ねぇ|シャノン|ちょっと)*(?:これ|ここ|こっち|これって|ここって)(?:を)?(?:見れる|見える|見えてる|見られる|見て|見てみて|見てよ|見てくれる)(?:かな|か|の)?$/u;
/** With someone beside the owner, how sure a model tier must be that a look is wanted before anything opens. */
const GUARDED_AGREEMENT_FROM = 0.5;
const NO_ASK = () => ({});

/** Her body's turn; a turn in which it offers nothing still tells her that nothing is seen (not a guest, who is told of no camera). */
const viaBody = (turn: VoiceRoomLookTurn, guest: boolean): VoiceLookTurn =>
  ({ prompt: turn.prompt || (guest ? '' : LOOK_NOT_SEEN_GUARD), open: turn.open, cutOff: turn.cutOff, ask: NO_ASK });

export function voiceLookTurn(looks: VoiceLooks | undefined, turn: Turn, environment: Readonly<Record<string, string | undefined>> = process.env): VoiceLookTurn {
  // Her body first, always: its bookkeeping runs on every voice turn, whoever looks.
  const body = voiceRoomLookTurn(looks?.body, turn, environment);
  const client = looks?.client;
  if (!looks || !client) return viaBody(body, turn.guest);
  try {
    const camera = voiceLookCamera(turn.transcript, turn.decision.lookSelfProbability);
    const app = looks.app.turn(turn.scopeKey, turn.at, client, { guest: turn.guest, guarded: turn.audience !== 'owner' });
    let ask: AppLookAsk | null = null;
    /** No look in this turn: the fact, and her one honest line if she says she looks anyway. */
    const unseen = (prompt: string): VoiceLookTurn => ({
      prompt, ask: NO_ASK, cutOff: () => undefined,
      open: (threadId, reply) => { if (announcesCameraLook(reply)) app.announcedWithoutLook(threadId, turn.transcript, turn.turnId); return false; },
    });
    if (app.unavailable) {
      if (turn.guest) return viaBody(body, true);
      // The app cannot look now. Her body may, under its own rules; when neither can, the app's reason is the true one for this turn.
      // Not when the router was asked the app's wider question (the app only just looked): that score is not her body's.
      if (body.prompt && !body.unavailable && !looks.routing.appLook) return viaBody(body, false);
      return unseen(appLookUnavailablePrompt(app.unavailable, client.platform));
    }
    const guarded = turn.audience !== 'owner';
    const score = turn.decision.roomLookProbability;
    // With other people there, whose words they were is uncertain: words alone open nothing, a model tier has to agree
    // (at least as likely a look as not). With its agreement she looks when asked, and (owner decision 2026-10-03)
    // also when she is curious herself.
    if (guarded && (score === undefined || score < GUARDED_AGREEMENT_FROM)) return unseen(LOOK_NOT_SEEN_GUARD);
    // The app as the camera of `voiceRoomLookTurn`.
    const state: BodyLookVoiceTurn = {
      unavailable: null,
      open: (threadId, _choice, spoken, turnId) => (ask = app.open(threadId, camera, spoken ?? [], turnId)) !== null,
      cutOff: (threadId, said, turnId) => app.cutOff(threadId, said, turnId),
    };
    // Alone with her, 「これ見れる？」 said as the whole utterance is a request even when no model tier answered.
    // A statement of what he sees (「これは見える。」) is not one: the particle は／が is not accepted, and a full stop only with 見て.
    const plain = !guarded && score === undefined && PLAIN_APP_ASK.test(turn.transcript.normalize('NFKC').replace(/[\s、，,!！?？…]/gu, '').replace(/(見て(?:みて|よ|くれる)?)[。.]$/u, '$1'));
    // The app's camera is aimed by the owner himself: for it, a turn other people hear is judged like one of his alone.
    const chosen = voiceRoomLookTurn({ voiceTurn: () => state },
      { ...turn, audience: 'owner', ...(plain ? { decision: { ...turn.decision, roomLookProbability: 1 } } : {}) },
      { ...environment, SHANNON_VOICE_ROOM_LOOK: 'on' });
    const withAsk = () => (ask ? { appLook: ask } : {});
    if (chosen.prompt && chosen.prompt !== VOICE_ROOM_LOOK_READY_PROMPT) {
      // Decided before the reply: she is told that she looks, and the look follows whatever her words are.
      return { prompt: voiceAppLookPrompt(chosen.prompt === voiceRoomLookPrompt(true), camera), open: chosen.open, cutOff: chosen.cutOff, ask: withAsk };
    }
    if (!turn.decision.shouldRespond) return unseen('');
    // Nothing decided it: the choice is hers, made by saying so. Only the announced look is opened.
    let settled = false;
    return {
      prompt: VOICE_APP_LOOK_OFFER_PROMPT, ask: withAsk,
      open: (threadId, reply) => {
        if (settled || !announcesCameraLook(reply)) return false;
        settled = true;
        return state.open(threadId, 'asked', [{ role: 'user', content: turn.transcript }, { role: 'assistant', content: reply.trim() }], turn.turnId);
      },
      cutOff: (threadId, said) => {
        if (settled || !announcesCameraLook(said)) return;
        settled = true;
        state.cutOff(threadId, turn.transcript, turn.turnId);
      },
    };
  } catch { return viaBody(body, turn.guest); }
}
