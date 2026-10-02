import type { AppLooks, AppLookTurn } from './appLook.js';
import { appLookClient, type AppLookAsk, type AppLookClient } from './appLookContract.js';
import type { BodyLooks } from './bodyLook.js';

/**
 * Which camera a conversation turn may look through: her body's, or that of the app the turn came from.
 *
 * - A turn that says nothing about an app camera (her body's own calls, an older app) is what it was: her body.
 * - A turn from an app that can capture now looks through that app: the surface the turn came from wins.
 * - A turn from an app that cannot capture now may still look through her body under the body's own rules
 *   (the owner alone, her window showing). When neither can, the app's reason is the one she is given.
 *
 * Every turn still passes `BodyLooks` first, so that her body's bookkeeping (the fast poll after a turn, ending a
 * look when other people join) runs whoever looks.
 */
export interface ConversationLookTurn {
  /** One line for the turn's prompt, or empty. */
  prompt: string;
  /** Spread into the model request: the structured reply gets `roomLook` or `appLook` only when that look is offered. */
  request: { offerRoomLook?: true; offerAppLook?: true };
  /** Called with what the model answered. Opens a look only when one was offered in this turn; returns what the response carries. */
  decide(completion: { roomLook?: unknown; appLook?: unknown; reply: string }, threadId: string): { appLook?: AppLookAsk };
}

/** The looks of one voice request (`voiceAppLook.ts`). */
export interface VoiceLooks {
  /** The same, bound to the request a turn arrived in: its device and what it said about its camera. */
  of(request: { deviceId?: string; body?: unknown }): VoiceLooks;
  body: Pick<BodyLooks, 'voiceTurn'>;
  app: Pick<AppLooks, 'turn'>;
  /** The app of this request, when it said that it has a camera to offer. */
  client: AppLookClient | null;
  /** Spread into the voice router's input: the app's questions are asked in place of the body's, only while the app can look. */
  routing: { appLook?: true };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** `appLook` of a turn's body; a voice turn may carry it inside `deviceContext`, beside the other facts of the device. */
const appLookField = (body: unknown): unknown =>
  !isRecord(body) ? undefined : body.appLook ?? (isRecord(body.deviceContext) ? body.deviceContext.appLook : undefined);

export class ConversationLooks implements VoiceLooks {
  readonly client: AppLookClient | null = null;
  readonly routing: { appLook?: true } = Object.freeze({});

  constructor(readonly body: BodyLooks, readonly app: AppLooks) {}

  /** What one `POST /v1/chat` turn is told about looking. It never throws: a failure here must not cost the owner a reply. */
  turn(scopeKey: string, message: string, at: string, audience: unknown, request: { deviceId?: string; body?: unknown }): ConversationLookTurn {
    const body = this.body.turn(scopeKey, message, at, audience);
    const viaBody: ConversationLookTurn = {
      prompt: body.prompt, request: body.request,
      decide: (completion, threadId) => { body.decide(completion.roomLook, threadId); return {}; },
    };
    let app: AppLookTurn;
    try {
      const client = appLookClient(request.deviceId, appLookField(request.body));
      if (!client) return viaBody;
      // Text is typed on the owner's own device: other people who can see the reply do not stop a look he aims himself.
      app = this.app.turn(scopeKey, at, client, { guest: false, guarded: audience !== 'owner' }, message);
    } catch { return viaBody; }
    if (!app.unavailable) {
      return {
        prompt: app.prompt, request: app.request,
        decide: (completion, threadId) => {
          const ask = app.decide(completion.appLook, threadId, completion.reply);
          return ask ? { appLook: ask } : {};
        },
      };
    }
    return body.request.offerRoomLook ? viaBody : { ...viaBody, prompt: app.prompt || body.prompt };
  }

  /** The client stored a voice turn: her message about that turn's look, whichever camera took it, may follow now. */
  turnStored(scopeKey: string, threadId: string, said: string): void {
    this.body.turnStored(scopeKey, threadId, said);
    this.app.turnStored(scopeKey, threadId, said);
  }

  of(request: { deviceId?: string; body?: unknown }): VoiceLooks {
    let client: AppLookClient | null = null;
    try { client = appLookClient(request.deviceId, appLookField(request.body)); } catch { client = null; }
    return { of: next => this.of(next), body: this.body, app: this.app, client, routing: client && this.app.enabled && (client.state === 'ready' || client.state === 'undetermined') ? { appLook: true } : {} };
  }
}
