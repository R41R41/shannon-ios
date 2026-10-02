import { randomUUID } from 'node:crypto';
import {
  APP_LOOK_LIMITS, appLookChoice, availableCamera, configuredAppLook, voiceLookCamera,
  type AppLookAsk, type AppLookCamera, type AppLookClient, type AppLookCode, type AppLookConfig, type AppLookResult,
} from './appLookContract.js';
import {
  APP_LOOK_OFFER_PROMPT, APP_LOOK_SEEN_SUMMARY, announcesCameraLook, appLookNotSeenLine, appLookNotSeenSummary, appLookUnavailablePrompt, type AppLookUnavailable,
} from './appLookLines.js';
import { SQLiteAppLookStore, type AppLookOutcome, type StoredAppLook } from './appLookStore.js';
import type { BodyLookMessage, BodyLookSpeaker } from './bodyLook.js';
import { BODY_LOOK_LIMITS } from './bodyLookContract.js';
import { BODY_LOOK_CUT_OFF_LINE } from './bodyLookLines.js';
import { VoiceTurnWaits, type TurnWait } from './bodyLookTurnWait.js';
import type { RoomLookContextLine, RoomLookViewer } from './bodyLookVision.js';

/**
 * One look through the camera of the app the owner is talking through, from the turn that
 * chose it to her next message (owner decision 2026-10-02). The machinery is that of a look
 * through her body (`bodyLook.ts`): one frame, shown to the conversation model once and dropped,
 * her message stored in the Talk, one entry in the activity record. What differs:
 *
 * - The viewer is the app of the turn itself. No presence is guessed: the request proves the
 *   app is there, and says whether it can capture now (`AppLookClient`).
 * - Other people may be around: the owner aims the camera himself. A guest never opens a look.
 * - There is no hourly or daily limit. The loop guard is one look per turn, one open look per
 *   scope, and a few seconds between two looks.
 * - The ask travels in the response of the turn, and only the device of that turn may answer.
 */
export interface AppLookOptions {
  store?: SQLiteAppLookStore;
  config?: AppLookConfig;
  /** The one model call of a look. Without it a look is never offered. */
  viewer?: RoomLookViewer | null;
  /** How her message reaches the Talk. It receives text only, never a frame. */
  speaker?: BodyLookSpeaker;
  /** False in tests that drive expiry by the clock they control. */
  timers?: boolean;
  /** How long her message about a voice look waits for the client to store that turn. Default 8 seconds; 0 does not wait. */
  voiceTurnWaitMilliseconds?: number;
}

export interface AppLookDependencies extends AppLookOptions {
  now: () => string;
  /** The last few messages of a Talk, oldest first. */
  context(scopeKey: string, threadId: string): readonly RoomLookContextLine[];
  /** Appends one entry to the activity record. */
  record(scopeKey: string, entry: { summary: string; outcome: 'done' | 'failed'; reasonCode?: string }): void;
  speaker: BodyLookSpeaker;
}

/** What one turn that came from an app is told about looking through it. */
export interface AppLookTurn {
  /** Why the app cannot be asked now, or null when it can. */
  unavailable: AppLookUnavailable | null;
  /** One line for a text turn's prompt, or empty. */
  prompt: string;
  /** Spread into the model request of a text turn: the structured reply gets `appLook` only when the look is offered. */
  request: { offerAppLook?: true };
  /** A text turn: opens the look the model chose in the structured reply. `reply` is what she wrote. */
  decide(choice: unknown, threadId: string, reply: string): AppLookAsk | null;
  /** A voice turn: opens the look once the reply is written. `spoken` is the turn as it was said. */
  open(threadId: string, camera: AppLookCamera, spoken: readonly RoomLookContextLine[], turnId?: string): AppLookAsk | null;
  /** A voice turn cut off after she had begun to say she would look: no look, and one honest line once the turn is stored. */
  cutOff(threadId: string, said: string, turnId?: string): void;
  /**
   * She said that she would look through the camera in a turn that could not open a look: one honest fixed line in the
   * Talk, once the turn is stored. `said` is his words of a voice turn; absent for a text turn, which is stored already.
   */
  announcedWithoutLook(threadId: string, said?: string, turnId?: string): void;
}

export type AppLookAnswer =
  | { kind: 'disabled' | 'not_found' | 'wrong_device' | 'answered' | 'expired' }
  | { kind: 'done'; id: string; status: 'seen' | 'refused' | 'failed'; message: BodyLookMessage | null };

const VOICE_TURN_WAIT_MILLISECONDS = 8_000;
/** A look the model is seeing is given up this long after its expiry (the process stopped mid-call). */
const SEEING_GRACE_MILLISECONDS = 90_000;
const RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;
/** She wrote that she would look: 「見てみますね」「のぞいてみますね」, not 「意見」「見つけ」. */
const ANNOUNCES_LOOK = /見て(?:み|き)ま|見てみる|見ますね|みてみま|のぞいてみ|カメラで/u;
const CLOSED: Pick<AppLookTurn, 'request' | 'decide' | 'open' | 'cutOff' | 'announcedWithoutLook'> = Object.freeze({
  request: Object.freeze({}), decide: () => null, open: () => null, cutOff: () => undefined, announcedWithoutLook: () => undefined,
});
/** The fixed line for a look she announced in a turn that could not look: the app's own reason where it has a line. */
const UNLOOKED_CODE: Readonly<Record<AppLookUnavailable, AppLookCode>> = Object.freeze({
  background: 'background', denied: 'denied', no_camera: 'no_camera', switched_off: 'switched_off', busy: 'too_soon',
  server_off: 'not_opened', no_viewer: 'not_opened', guest: 'not_opened',
});

export class AppLooks {
  private readonly store: SQLiteAppLookStore;
  private readonly config: AppLookConfig;
  private readonly viewer: RoomLookViewer | null;
  private readonly turns: VoiceTurnWaits;
  /** The wait of each open voice look, by look id. */
  private readonly lookWaits = new Map<string, TurnWait>();
  /** The turn a look was opened in, as it was said, until the look ends. Memory only. */
  private readonly spoken = new Map<string, readonly RoomLookContextLine[]>();

  constructor(private readonly dependencies: AppLookDependencies) {
    this.store = dependencies.store ?? new SQLiteAppLookStore(':memory:');
    this.config = dependencies.config ?? configuredAppLook({});
    this.viewer = dependencies.viewer ?? null;
    this.turns = new VoiceTurnWaits(dependencies.voiceTurnWaitMilliseconds ?? VOICE_TURN_WAIT_MILLISECONDS);
  }

  /** `SHANNON_APP_LOOK`. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The client stored a voice turn of this Talk with these words of his: her message about that turn's look may follow now. */
  turnStored(scopeKey: string, threadId: string, said: string, turnId?: string): void {
    this.turns.turnStored(scopeKey, threadId, said, turnId);
  }

  /**
   * What one turn from an app is told about looking through it, and the ways to open the look. `guest`: the
   * words may not be the owner's (「友人も一緒」): no look. `guarded`: other people can hear the reply; the look is
   * allowed, and the model that sees the frame is then given no line of the owner's Talk. `message` is a text turn's
   * message: without it (a voice turn) the caller words the prompt. It never throws.
   */
  turn(scopeKey: string, at: string, client: AppLookClient, audience: { guest: boolean; guarded: boolean }, message?: string): AppLookTurn {
    try {
      this.sweep(scopeKey, at);
      const unavailable = this.unavailable(scopeKey, at, client, audience.guest);
      const since = this.turns.mark;
      let unlooked = false;
      const announcedWithoutLook = (code: AppLookCode) => (threadId: string, said?: string, turnId?: string) => {
        try {
          if (unlooked) return;
          unlooked = true;
          this.unopened(scopeKey, threadId, said === undefined ? null : this.turns.await(scopeKey, threadId, said, since, turnId), code, appLookNotSeenLine(code, client.platform));
        } catch { /* nothing more to do */ }
      };
      if (unavailable) {
        // The reason is a fact of the turn, told whether or not he asks: she must not think she can look, or has.
        return { ...CLOSED, unavailable, prompt: message !== undefined ? appLookUnavailablePrompt(unavailable, client.platform) : '',
          announcedWithoutLook: audience.guest ? CLOSED.announcedWithoutLook : announcedWithoutLook(UNLOOKED_CODE[unavailable]) };
      }
      let opened = false;
      const open = (threadId: string, camera: AppLookCamera, announced: boolean, spoken: readonly RoomLookContextLine[], wait: TurnWait | null) => {
        if (opened) return null;
        opened = true;
        return this.open(scopeKey, threadId, client, camera, { announced, guarded: audience.guarded }, spoken, wait);
      };
      return {
        unavailable: null, prompt: message === undefined ? '' : APP_LOOK_OFFER_PROMPT, request: { offerAppLook: true },
        decide: (choice, threadId, reply) => {
          try {
            // Her own words 「カメラで見てみますね」 are a choice too: a look she announced is taken, not left as a promise.
            const chosen = appLookChoice(choice) ?? (announcesCameraLook(reply) ? { choice: 'curious' as const, camera: voiceLookCamera(message ?? '', undefined) } : null);
            if (!chosen) return null;
            // Her text about the look follows this turn, which is stored before this runs: nothing is waited for.
            const announced = chosen.choice === 'asked' || ANNOUNCES_LOOK.test(reply);
            const ask = open(threadId, chosen.camera, announced, [{ role: 'user', content: message ?? '' }, { role: 'assistant', content: reply }], null);
            // Another look was opened while she was writing: if she said she would look, one honest line follows.
            if (!ask && ANNOUNCES_LOOK.test(reply)) this.unopened(scopeKey, threadId, null, 'too_soon', appLookNotSeenLine('too_soon', client.platform));
            return ask;
          } catch { return null; }
        },
        open: (threadId, camera, spoken, turnId) => {
          try {
            if (opened) return null;
            const wait = this.turns.await(scopeKey, threadId, spoken[0]?.content ?? '', since, turnId);
            // She says aloud that she will look, so a look that then does not happen always gets her one honest line.
            const ask = open(threadId, camera, true, spoken, wait);
            if (!ask) this.unopened(scopeKey, threadId, wait, 'too_soon', appLookNotSeenLine('too_soon', client.platform));
            return ask;
          } catch { return null; }
        },
        cutOff: (threadId, said, turnId) => {
          try {
            if (opened) return;
            opened = true;
            this.unopened(scopeKey, threadId, this.turns.await(scopeKey, threadId, said, since, turnId), 'interrupted', BODY_LOOK_CUT_OFF_LINE);
          } catch { /* nothing more to do */ }
        },
        announcedWithoutLook: announcedWithoutLook('not_opened'),
      };
    } catch { return { ...CLOSED, unavailable: 'no_viewer', prompt: '' }; }
  }

  /** The app's answer to one ask. A frame is passed to the model once and to nothing else. */
  async answer(scopeKey: string, deviceId: string, id: string, result: AppLookResult): Promise<AppLookAnswer> {
    if (!this.enabled) return { kind: 'disabled' };
    // A look opened in a voice turn: what she says about it must follow that turn in the Talk, so the answer waits
    // until the client has stored the turn (bounded by `voiceTurnWaitMilliseconds`). The checks below run afterwards.
    const asked = this.store.get(scopeKey, id);
    // Whether it came in time is judged by when it arrived, not by when the wait for the turn ended.
    const arrivedAt = this.dependencies.now();
    if (asked?.outcome === 'pending' && asked.deviceId === deviceId) {
      await this.lookWaits.get(id)?.stored;
      this.lookWaits.delete(id);
    }
    const at = this.dependencies.now();
    const look = this.store.get(scopeKey, id);
    if (!look) return { kind: 'not_found' };
    if (look.deviceId !== deviceId) return { kind: 'wrong_device' };
    if (look.outcome !== 'pending') return { kind: look.outcome === 'expired' ? 'expired' : 'answered' };
    if (Date.parse(arrivedAt) >= Date.parse(look.expiresAt)) {
      this.sweep(scopeKey, at);
      return { kind: 'expired' };
    }
    if (result.outcome === 'refused') {
      const closed = this.close(look, 'pending', 'refused', result.code, at);
      return closed ? { kind: 'done', id, status: 'refused', message: closed.message } : { kind: 'answered' };
    }
    if (!this.viewer) {
      const closed = this.close(look, 'pending', 'failed', 'model_failed', at);
      return closed ? { kind: 'done', id, status: 'failed', message: closed.message } : { kind: 'answered' };
    }
    if (!this.store.advance(scopeKey, id, 'pending', 'seeing', at)) return { kind: 'answered' };
    let text: string | null = null;
    try {
      text = (await this.viewer.see({ scopeKey, image: result.image, context: this.context(look), app: { camera: result.camera } })).trim() || null;
    } catch { text = null; }
    this.spoken.delete(id);
    const doneAt = this.dependencies.now();
    if (text && this.store.advance(scopeKey, id, 'seeing', 'seen', doneAt)) {
      try {
        this.dependencies.record(scopeKey, { summary: APP_LOOK_SEEN_SUMMARY, outcome: 'done' });
      } catch {
        // A look that cannot be written to the activity record leaves no message either.
        return { kind: 'done', id, status: 'failed', message: null };
      }
      return { kind: 'done', id, status: 'seen', message: this.say(look, 'seen', text, doneAt) };
    }
    const closed = this.close(look, 'seeing', 'failed', 'model_failed', doneAt);
    return { kind: 'done', id, status: 'failed', message: closed?.message ?? null };
  }

  /** Closes looks nobody answered in time. Called on every turn and answer, and by a timer. */
  sweep(scopeKey: string, at: string): void {
    const time = Date.parse(at);
    for (const look of this.store.waiting(scopeKey)) {
      const overdue = time - Date.parse(look.expiresAt);
      if (look.outcome === 'pending' && overdue >= 0) this.close(look, 'pending', 'expired', 'timeout', at);
      else if (look.outcome === 'seeing' && overdue >= SEEING_GRACE_MILLISECONDS) this.close(look, 'seeing', 'failed', 'model_failed', at);
    }
  }

  private unavailable(scopeKey: string, at: string, client: AppLookClient, guest: boolean): AppLookUnavailable | null {
    if (!this.enabled) return 'server_off';
    if (guest) return 'guest';
    if (!this.viewer) return 'no_viewer';
    if (client.state !== 'ready' && client.state !== 'undetermined') return client.state;
    return this.store.blocked(scopeKey, new Date(Date.parse(at) - this.config.minimumIntervalMilliseconds + 1).toISOString()) ? 'busy' : null;
  }

  /** Opens the look. The loop guard is checked again inside the store's transaction: the reply took time. */
  private open(
    scopeKey: string, threadId: string, client: AppLookClient, camera: AppLookCamera,
    marks: { announced: boolean; guarded: boolean }, spoken: readonly RoomLookContextLine[], wait: TurnWait | null,
  ): AppLookAsk | null {
    if (!this.enabled || !this.viewer) return null;
    const at = this.dependencies.now();
    const time = Date.parse(at);
    this.store.prune(scopeKey, new Date(time - RETENTION_MILLISECONDS).toISOString());
    const lifetime = client.state === 'undetermined' ? APP_LOOK_LIMITS.firstUseLifetimeMilliseconds : APP_LOOK_LIMITS.lifetimeMilliseconds;
    const ask: AppLookAsk = { id: randomUUID(), camera: availableCamera(client, camera), expiresAt: new Date(time + lifetime).toISOString(), lifetimeSeconds: lifetime / 1_000 };
    const opened = this.store.open({
      id: ask.id, scopeKey, deviceId: client.deviceId, threadId, camera: ask.camera, platform: client.platform,
      requestedAt: at, expiresAt: ask.expiresAt, ...marks,
    }, new Date(time - this.config.minimumIntervalMilliseconds + 1).toISOString());
    if (!opened) return null;
    if (this.spoken.size >= 64) this.spoken.clear();
    this.spoken.set(ask.id, spoken.filter(line => line.content.trim()).slice(-2));
    if (wait) this.lookWaits.set(ask.id, wait);
    if (this.dependencies.timers !== false) {
      setTimeout(() => { try { this.sweep(scopeKey, this.dependencies.now()); } catch { /* the next turn sweeps */ } },
        lifetime + 250).unref();
    }
    return ask;
  }

  /** She said aloud that she would look and no look was opened: one honest line in the Talk once the client has stored the turn. */
  private unopened(scopeKey: string, threadId: string, wait: TurnWait | null, code: AppLookCode, line: string): void {
    const say = () => {
      try {
        const at = this.dependencies.now();
        try { this.dependencies.record(scopeKey, { summary: appLookNotSeenSummary(code), outcome: 'failed', reasonCode: code }); } catch { /* her line still says it */ }
        this.dependencies.speaker.say(scopeKey, threadId, { id: randomUUID(), outcome: 'not_seen' }, line, at);
      } catch { /* nothing more to do */ }
    };
    if (wait) void wait.stored.then(say); else say();
  }

  /**
   * What the model that sees the frame is told of the conversation: the last few messages of the look's Talk, then the
   * turn it was opened in while that turn is not stored yet. A look opened where other people could hear is given the
   * turn itself and nothing else of the Talk.
   */
  private context(look: StoredAppLook): readonly RoomLookContextLine[] {
    const spoken = this.spoken.get(look.id) ?? [];
    if (look.guarded) return spoken;
    const stored = this.dependencies.context(look.scopeKey, look.threadId);
    return [...stored, ...spoken.filter(line => !stored.some(item => item.role === line.role && item.content === line.content))]
      .slice(-BODY_LOOK_LIMITS.contextMessages);
  }

  /** Ends a look that did not become a message about what she saw: one activity entry, and one honest line if she had announced it. */
  private close(look: StoredAppLook, from: AppLookOutcome, to: AppLookOutcome, code: AppLookCode, at: string): { message: BodyLookMessage | null } | null {
    if (!this.store.advance(look.scopeKey, look.id, from, to, at, code)) return null;
    this.spoken.delete(look.id);
    this.lookWaits.delete(look.id);
    try {
      this.dependencies.record(look.scopeKey, { summary: appLookNotSeenSummary(code), outcome: 'failed', reasonCode: code });
    } catch { /* her line below still tells the owner */ }
    return { message: look.announced ? this.say(look, 'not_seen', appLookNotSeenLine(code, look.platform), at) : null };
  }

  private say(look: StoredAppLook, outcome: 'seen' | 'not_seen', text: string, at: string): BodyLookMessage | null {
    try { return this.dependencies.speaker.say(look.scopeKey, look.threadId, { id: look.id, outcome }, text, at); } catch { return null; }
  }
}
