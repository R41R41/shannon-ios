import { voiceLookCamera, type AppLookAsk } from '../../contracts/appLookContract.js';
import {
  LOOK_NOT_NOW_GUARD, LOOK_NOT_SEEN_GUARD, announcedLook, appLookUnavailablePrompt, voiceAppLookOfferPrompt, voiceAppLookPrompt,
} from '../body/appLookLines.js';
import { asksToLook, type BodyLookVoiceTurn } from '../body/bodyLook.js';
import type { VoiceLooks } from '../body/conversationLooks.js';
import { VOICE_ROOM_LOOK_READY_PROMPT, voiceRoomLookPrompt, voiceRoomLookTurn, type VoiceRoomLookTurn } from './voiceRoomLook.js';

export type { VoiceLooks } from '../body/conversationLooks.js';

/**
 * One look from a voice turn, through her body or through the app the turn came from (`conversationLooks.ts` says which).
 *
 * For a turn from an app that can look, two things open a look:
 * - before the reply, exactly as for her body (`voiceRoomLookTurn` run against the app's camera): his words ask for it or
 *   the decision gateway judges that a look is wanted, and the reply is told that she looks;
 * - or, when nothing decided it beforehand, she herself: the reply is told that she may look and that the words
 *   「カメラで見てみますね」 are what opens it. A look she announces is then taken, never left as a promise: in those
 *   words or others that name the camera, or by saying that she will look right after he asked her to. This is what
 *   makes the look work when the gateway gave no answer, or did not trust a spoken transcript (production, 2026-10-02:
 *   six turns in which she said she would look and nothing was opened).
 *
 * In every other turn she is told as a fact that this reply sees nothing and that she has seen nothing unless the Talk
 * says so, and a look announced anyway gets her one honest fixed line.
 *
 * - The ask is returned in the response of the turn (`appLook`), not read from `presence`.
 * - Other people listening beside the owner do not stop it (he aims the camera himself): she looks when asked and when
 *   curious, as when alone, but only when a model tier decided it before the reply: never on words alone, and never on
 *   her own announcement. A 「友人も一緒」 turn never opens one.
 * - A turn in which he shares a photo himself (`source: camera`) is about that photo: no look is offered, and nothing
 *   tells her not to describe what she was shown.
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
  /** Where the utterance came from; `camera` is a photo the owner shared himself, with its description. */
  source?: string;
};

/** The owner's plain request through the app, as the whole utterance: 「これ見れる？」「ねえ、これ見える？」「ここ見て」. */
const PLAIN_APP_ASK = /^(?:ねえ|ねぇ|シャノン|ちょっと)*(?:これ|ここ|こっち|これって|ここって)(?:を)?(?:見れる|見える|見えてる|見られる|見て|見てみて|見てよ|見てくれる)(?:かな|か|の)?$/u;
/** With someone beside the owner, how sure a model tier must be that a look is wanted before anything opens. */
const GUARDED_AGREEMENT_FROM = 0.5;
/** He tells her not to look, or reports someone's words: nothing is offered, and her announcement opens nothing. */
const REFUSES_LOOK = /見ないで|見なくて|見るな|使わないで|やめて|って(?:聞かれ|言われ|言っ)/u;
const NO_ASK = () => ({});

/** Her body's turn; a turn in which it offers nothing still tells her that this reply sees nothing (not a guest, who is told of no camera). */
const viaBody = (turn: VoiceRoomLookTurn, guard: string): VoiceLookTurn =>
  ({ prompt: turn.prompt || guard, open: turn.open, cutOff: turn.cutOff, ask: NO_ASK });

export function voiceLookTurn(looks: VoiceLooks | undefined, turn: Turn, environment: Readonly<Record<string, string | undefined>> = process.env): VoiceLookTurn {
  // Her body first, always: its bookkeeping runs on every voice turn, whoever looks.
  const body = voiceRoomLookTurn(looks?.body, turn, environment);
  // He shared a photo himself: the turn is about what he showed her, and carries its description.
  if (turn.source === 'camera') return { prompt: '', open: () => false, cutOff: () => undefined, ask: NO_ASK };
  const guarded = turn.audience !== 'owner';
  const guard = turn.guest ? '' : guarded ? LOOK_NOT_NOW_GUARD : LOOK_NOT_SEEN_GUARD;
  const client = looks?.client;
  if (!looks || !client) return viaBody(body, guard);
  try {
    const camera = voiceLookCamera(turn.transcript, turn.decision.lookSelfProbability);
    const app = looks.app.turn(turn.scopeKey, turn.at, client, { guest: turn.guest, guarded });
    let ask: AppLookAsk | null = null;
    // Alone with her, 「これ見れる？」 said as the whole utterance is a request.
    // A statement of what he sees (「これは見える。」) is not one: the particle は／が is not accepted, and a full stop only with 見て.
    const plainAsk = PLAIN_APP_ASK.test(turn.transcript.normalize('NFKC').replace(/[\s、，,!！?？…]/gu, '').replace(/(見て(?:みて|よ|くれる)?)[。.]$/u, '$1'));
    /** His words ask her to look, loosely read: then her saying that she will look or check is about the camera. */
    const heAsked = plainAsk || asksToLook(turn.transcript);
    /** No look in this turn: the fact, and her one honest line if she says she looks anyway. */
    const unseen = (prompt: string): VoiceLookTurn => ({
      prompt, ask: NO_ASK, cutOff: () => undefined,
      open: (threadId, reply) => { if (announcedLook(reply, heAsked)) app.announcedWithoutLook(threadId, turn.transcript, turn.turnId); return false; },
    });
    if (app.unavailable) {
      if (turn.guest) return viaBody(body, '');
      // The app cannot look now. Her body may, under its own rules; when neither can, the app's reason is the true one for this turn.
      // Not when the router was asked the app's wider question (the app only just looked): that score is not her body's.
      if (body.prompt && !body.unavailable && !looks.routing.appLook) return viaBody(body, guard);
      return unseen(appLookUnavailablePrompt(app.unavailable, client.platform, guarded));
    }
    const score = turn.decision.roomLookProbability;
    // With other people there, whose words they were is uncertain: words alone open nothing, a model tier has to agree
    // (at least as likely a look as not). With its agreement she looks when asked, and (owner decision 2026-10-03)
    // also when she is curious herself.
    if (guarded && (score === undefined || score < GUARDED_AGREEMENT_FROM)) return unseen(LOOK_NOT_NOW_GUARD);
    // The app as the camera of `voiceRoomLookTurn`.
    const state: BodyLookVoiceTurn = {
      unavailable: null,
      open: (threadId, _choice, spoken, turnId) => (ask = app.open(threadId, camera, spoken ?? [], turnId)) !== null,
      cutOff: (threadId, said, turnId) => app.cutOff(threadId, said, turnId),
    };
    // The app's camera is aimed by the owner himself: for it, a turn other people hear is judged like one of his alone.
    // His plain request stands even when no model tier answered.
    const chosen = voiceRoomLookTurn({ voiceTurn: () => state },
      { ...turn, audience: 'owner', ...(!guarded && score === undefined && plainAsk ? { decision: { ...turn.decision, roomLookProbability: 1 } } : {}) },
      { ...environment, SHANNON_VOICE_ROOM_LOOK: 'on' });
    const withAsk = () => (ask ? { appLook: ask } : {});
    if (chosen.prompt && chosen.prompt !== VOICE_ROOM_LOOK_READY_PROMPT) {
      // Decided before the reply: she is told that she looks, and the look follows whatever her words are.
      return { prompt: voiceAppLookPrompt(chosen.prompt === voiceRoomLookPrompt(true), camera), open: chosen.open, cutOff: chosen.cutOff, ask: withAsk };
    }
    // With someone beside the owner nothing but that decision opens a look: no offer, and her announcement opens nothing.
    if (guarded) return unseen(LOOK_NOT_NOW_GUARD);
    // 「カメラで見ないで」: he does not want a look. She is told that this reply does not look, and nothing can open one.
    if (REFUSES_LOOK.test(turn.transcript.normalize('NFKC'))) return { prompt: LOOK_NOT_SEEN_GUARD, open: () => false, cutOff: () => undefined, ask: NO_ASK };
    if (!turn.decision.shouldRespond) return unseen('');
    // Nothing decided it: the choice is hers, made by saying so. Only the announced look is opened.
    let settled = false;
    // A transcript a model tier did not trust, or a request it scored as most likely not one: she may look, and is not told that she must.
    const doubtful = (turn.uncertain && turn.decision.transcriptReliabilityProbability !== undefined) || (score !== undefined && score < 0.2);
    return {
      prompt: voiceAppLookOfferPrompt(doubtful), ask: withAsk,
      open: (threadId, reply) => {
        if (settled || !announcedLook(reply, heAsked)) return false;
        settled = true;
        return state.open(threadId, 'asked', [{ role: 'user', content: turn.transcript }, { role: 'assistant', content: reply.trim() }], turn.turnId);
      },
      cutOff: (threadId, said) => {
        if (settled || !announcedLook(said, heAsked)) return;
        settled = true;
        state.cutOff(threadId, turn.transcript, turn.turnId);
      },
    };
  } catch { return viaBody(body, guard); }
}
