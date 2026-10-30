import { BODY_LOOK_SEEN_SUMMARY,bodyLookNotSeenSummary,BODY_SCREEN_LOOK_SEEN_SUMMARY,bodyScreenLookNotSeenSummary,bodyScreenLookNotSeenLine,ROOM_LOOK_OFFER_PROMPT,roomLookUnavailablePrompt } from './bodyLookWords.js';
import type { ScreenLookUnavailable,Unavailable } from './bodyLookWords.js';
import { asksToLook,type BodyLookVoiceTurn } from '../../mind/perception/lookPorts.js';
import { randomUUID } from 'node:crypto';
import {
BODY_LOOK_ACTIVITY_THREAD,BODY_LOOK_LIMITS,configuredBodyLook,roomLookChoice,
type BodyLookCode,type BodyLookConfig,type BodyLookResult,type BodyLookSource
} from '../../contracts/bodyLookContract.js';
import {
BODY_LOOK_CUT_OFF_LINE,ROOM_LOOK_UNAVAILABLE_REASON,UNOPENED_LINE,bodyLookNotSeenLine,
type BodyLookUnavailable
} from '../../mind/perception/bodyLookLines.js';
import { VoiceTurnWaits,type TurnWait } from './bodyLookTurnWait.js';
import { SQLiteBodyLookStore,type BodyLookOutcome,type StoredBodyLook } from './store/bodyLookStore.js';
import type { RoomLookContextLine,RoomLookViewer } from './bodyLookVision.js';
export { BODY_LOOK_TOOL, BODY_LOOK_SEEN_SUMMARY, bodyLookNotSeenSummary, BODY_SCREEN_LOOK_SEEN_SUMMARY, bodyScreenLookNotSeenSummary, bodyScreenLookNotSeenLine, ROOM_LOOK_OFFER_PROMPT, roomLookUnavailablePrompt } from './bodyLookWords.js';
export type { ScreenLookUnavailable } from './bodyLookWords.js';
export { asksToLook, type BodyLookVoiceTurn } from '../../mind/perception/lookPorts.js';

/**
 * One look at the room, from the offer in an owner turn to her next message.
 *
 * - Deciding: the look is available only in a turn with the owner alone, while a body with
 *   its camera on is showing her window, the limits have room, and both switches are on.
 *   In a text turn the conversation model chooses it in the structured reply; a choice that
 *   arrives without an offer is ignored. A voice turn is streamed speech and has no such
 *   field: there the decision gateway chooses (`voiceRoomLook.ts`), under the same conditions.
 * - Asking: the open look is carried by `GET /v1/body/presence` to the one device it was
 *   opened for, for 30 seconds.
 * - Seeing: the frame goes to the model once and is dropped. This module holds it only as
 *   the argument of that call. What remains is her message, and one line in the activity record.
 *
 * Stage 2: her activity loop, in its own process, may open a look too (`bodyLookActivity.ts`).
 * Such a look has no Talk. Its frame arrives here like any other and is shown once to the
 * model of her own activity; her short text is left for the loop and nothing is said or
 * recorded from this process: the loop records it through the gate.
 */
export interface BodyLookMessage {
  /** The conversation message. */
  id: string;
  threadId: string;
  text: string;
  /** Present when the message also went out as an initiative (`GET /v1/initiatives`, push). */
  initiativeId?: string;
}

/** How her message about a look reaches the Talk. It receives text only, never a frame. */
export interface BodyLookSpeaker {
  say(scopeKey: string, threadId: string, look: { id: string; outcome: 'seen' | 'not_seen'; source?: BodyLookSource }, text: string, at:
     string): BodyLookMessage | null;
}

/** The API side of a look she takes in her own time. It is handed her text and token counts, never a frame. */
export interface BodyLookActivityOptions {
  /** The model call with the dedicated autonomy key. Without it such a look fails as `model_failed`. */
  viewer: RoomLookViewer | null;
  hand: {
    markPresence(scopeKey: string, deviceId: string, at: string): void;
    get(scopeKey: string, lookId: string): { model: string } | null;
    keepNote(scopeKey: string, lookId: string, note: string): boolean;
    prune(scopeKey: string, untakenBefore: string, createdBefore: string): void;
  };
}

export interface BodyLookOptions {
  store?: SQLiteBodyLookStore;
  activity?: BodyLookActivityOptions;
  config?: BodyLookConfig;
  /** The one model call of a look. Without it a look is never offered. */
  viewer?: RoomLookViewer | null;
  speaker?: BodyLookSpeaker;
  /** False in tests that drive expiry by the clock they control. */
  timers?: boolean;
  /**
   * How long her message about a look opened in a voice turn waits for the client to store that turn, so that the Talk
   * reads question, 「見てみますね」, then what she saw. Default 8 seconds; 0 does not wait.
   */
  voiceTurnWaitMilliseconds?: number;
}

export interface BodyLookDependencies extends BodyLookOptions {
  /** `SHANNON_BODY_INGEST`: with the body switched off there is no look either. */
  ingestEnabled: boolean;
  now: () => string;
  /** Owner-local day of an instant. */
  dayKey(at: string): string;
  /** Devices that registered `flags.camera: true`. */
  cameraDevices(scopeKey: string): readonly string[];
  /** Every device that registered as her body, whatever its flags. Absent: a missing body reads as a camera that is off. */
  bodyDevices?(scopeKey: string): readonly string[];
  /** The last few messages of a Talk, oldest first. */
  context(scopeKey: string, threadId: string): readonly RoomLookContextLine[];
  /** Appends one entry to the activity record. */
  record(scopeKey: string, entry: { summary: string; outcome: 'done' | 'failed'; reasonCode?: string }): void;
  speaker: BodyLookSpeaker;
}

export interface BodyLookTurn {
  /** One line for the turn's prompt, or empty. */
  prompt: string;
  /** Spread into the model request: the structured reply gets the `roomLook` field only when the look is offered. */
  request: { offerRoomLook?: true };
  /** Called with what the model answered. Opens a look only when one was offered in this turn. */
  decide(choice: unknown, threadId: string): void;
}

export type BodyLookAnswer =
  | { kind: 'disabled' | 'not_found' | 'wrong_device' | 'answered' | 'expired' | 'wrong_source' }
  | { kind: 'unavailable'; reason: ScreenLookUnavailable }
  | { kind: 'done'; id: string; status: 'seen' | 'refused' | 'discarded' | 'failed'; message: BodyLookMessage | null };

export { ROOM_LOOK_UNAVAILABLE_REASON, type BodyLookUnavailable };
const VOICE_TURN_WAIT_MILLISECONDS = 8_000;

const NO_TURN: BodyLookTurn = Object.freeze({ prompt: '', request: Object.freeze({}), decide: () => undefined });
/** A look the model is seeing is given up this long after its expiry (the process stopped mid-call). */
const SEEING_GRACE_MILLISECONDS = 90_000;
const RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;
/** The presence of a camera device is written for the activity loop at most this often. */
const PRESENCE_MARK_MILLISECONDS = 5_000;
/** Her text about a look waits for the loop this long at most. */
const HAND_OFF_MILLISECONDS = 10 * 60_000;

export class BodyLooks {
  private readonly store: SQLiteBodyLookStore;
  private readonly config: BodyLookConfig;
  private readonly viewer: RoomLookViewer | null;
  /** When each device last read presence. Memory only: reading presence still writes nothing. */
  private readonly presenceReads = new Map<string, number>();
  private readonly presenceMarks = new Map<string, number>();
  private readonly activity: BodyLookActivityOptions | null;
  private readonly lastTurns = new Map<string, number>();
  /** Looks whose message must not be delivered because someone else joined while the model was seeing. */
  private readonly withheld = new Set<string>();
  /** The voice turn a look was opened in, until the look ends. Memory only. */
  private readonly spoken = new Map<string, readonly RoomLookContextLine[]>();
  /** How many turns other people could hear, per scope: a turn that sees the number change opens nothing. */
  private readonly othersTurns = new Map<string, number>();
  /** Voice turns the client has not stored yet: her message about such a turn's look waits for it (`bodyLookTurnWait.ts`). */
  private readonly turns: VoiceTurnWaits;
  /** The wait of each open voice look, by look id. */
  private readonly lookWaits = new Map<string, TurnWait>();

  constructor(private readonly dependencies: BodyLookDependencies) {
    this.turns = new VoiceTurnWaits(dependencies.voiceTurnWaitMilliseconds ?? VOICE_TURN_WAIT_MILLISECONDS);
    this.store = dependencies.store ?? new SQLiteBodyLookStore(':memory:');
    this.config = dependencies.config ?? configuredBodyLook({});
    this.viewer = dependencies.viewer ?? null;
    this.activity = dependencies.activity ?? null;
  }

  /** Both switches: `SHANNON_BODY_LOOK` and `SHANNON_BODY_INGEST`. */
  get enabled(): boolean {
    return this.config.enabled && this.dependencies.ingestEnabled;
  }

  /**
   * What one `POST /v1/chat` turn is told about looking, and the way to act on the model's
   * choice. It never throws: a failure here must not cost the owner a reply.
   */
  turn(scopeKey: string, message: string, at: string, audience: unknown): BodyLookTurn {
    try {
      const state = this.begin(scopeKey, at, audience);
      if (typeof state === 'string') return asksToLook(message) ? { ...NO_TURN, prompt: roomLookUnavailablePrompt(state) } : NO_TURN;
      const others = this.othersTurns.get(scopeKey);
      return {
        prompt: ROOM_LOOK_OFFER_PROMPT,
        request: { offerRoomLook: true },
        // A turn other people could hear that arrived while the reply was written stops the look.
        decide: (choice, threadId) => { try { if (this.othersTurns.get(scopeKey) === others) this.open(scopeKey, threadId, choice);
           } catch { /* the reply is already written */ } }, // No wait: a text turn is stored before this runs.
      };
    } catch { return NO_TURN; }
  }

  /**
   * The client stored a voice turn of this Talk with the owner alone (`POST /v1/voice/…/turns`), with these words of his
   * and its utterance id when the client sent one: her message about that turn's look may follow now. With looks switched
   * off nothing is noted.
   */
  turnStored(scopeKey: string, threadId: string, said: string, turnId?: string): void {
    if (this.enabled) this.turns.turnStored(scopeKey, threadId, said, turnId);
  }

  /**
   * The same for one voice turn (`POST /v1/voice/.../delegations`), under the conditions of a text turn.
   * Nothing here reads the words that were said: whether to look is the caller's decision. It never throws.
   */
  voiceTurn(scopeKey: string, at: string, audience: unknown): BodyLookVoiceTurn {
    try {
      const state = this.begin(scopeKey, at, audience);
      if (typeof state === 'string') return { unavailable: state, open: () => false, cutOff: () => undefined };
      const others = this.othersTurns.get(scopeKey);
      // A turn other people could hear that arrived while she was replying stops the look, and nothing is said about it.
      const alone = () => this.othersTurns.get(scopeKey) === others;
      // The client may already have stored this turn by the time her reply is written: then nothing is waited for.
      const since = this.turns.mark;
      return {
        unavailable: null,
        open: (threadId, choice, spoken, turnId) => {
          try {
            if (!alone()) return false;
            const wait = this.turns.await(scopeKey, threadId, spoken?.[0]?.content ?? '', since, turnId);
            const id = this.open(scopeKey, threadId, choice, spoken);
            if (id) {
              if (wait) this.lookWaits.set(id, wait);
              return true;
            }
            const state = this.availability(scopeKey, this.dependencies.now(), 'owner');
            const line = typeof state === 'string' ? UNOPENED_LINE[state] : UNOPENED_LINE.busy;
            if (line) this.unopened(scopeKey, threadId, wait, alone, line.code, line.line,
               typeof state === 'string' ? ROOM_LOOK_UNAVAILABLE_REASON[state] : ROOM_LOOK_UNAVAILABLE_REASON.busy);
            else wait?.done();
          } catch { /* the reply is already spoken */ }
          return false;
        },
        cutOff: (threadId, said, turnId) => {
          try {
            if (alone()) this.unopened(scopeKey, threadId, this.turns.await(scopeKey, threadId, said, since, turnId), alone, 'failed',
               BODY_LOOK_CUT_OFF_LINE, '話が途中で切れた');
          } catch { /* nothing more to do */ }
        },
      };
    } catch { return { unavailable: 'no_viewer', open: () => false, cutOff: () => undefined }; }
  }

  /** What every conversation turn does first: note the turn, close what is overdue, and end a look other people
 * would hear about. */
  private begin(scopeKey: string, at: string, audience: unknown): { deviceId: string } | Unavailable {
    this.lastTurns.set(scopeKey, Date.parse(at));
    this.sweep(scopeKey, at);
    if (audience !== 'owner') {
      if (this.othersTurns.size >= 256) this.othersTurns.clear();
      this.othersTurns.set(scopeKey, (this.othersTurns.get(scopeKey) ?? 0) + 1);
      this.withdraw(scopeKey, at);
    }
    return this.availability(scopeKey, at, audience);
  }

  /** The `look` field and the poll interval of one presence read. With the switch off there is no `look` key. */
  presence(scopeKey: string, deviceId: string, at: string): { look?: { id: string; requestedAt: string; expiresAt: string } | null; fastPoll: boolean } {
    if (!this.enabled) return { fastPoll: false };
    const time = Date.parse(at);
    if (this.presenceReads.size >= 256) this.presenceReads.clear();
    this.presenceReads.set(`${scopeKey}\u0000${deviceId}`, time);
    this.markForActivity(scopeKey, deviceId, at);
    this.sweep(scopeKey, at);
    const waiting = this.store.waiting(scopeKey);
    const mine = waiting.find(look => look.outcome === 'pending' && look.deviceId === deviceId);
    const lastTurn = this.lastTurns.get(scopeKey);
    return {
      look: mine ? { id: mine.id, requestedAt: mine.requestedAt, expiresAt: mine.expiresAt } : null,
      fastPoll: waiting.length > 0 || (lastTurn !== undefined && time - lastTurn >= 0 && time - lastTurn <= BODY_LOOK_LIMITS.fastPollWindowMilliseconds),
    };
  }

  /** The body's answer to one look. A frame is passed to the model once and to nothing else. */
  async answer(scopeKey: string, deviceId: string, id: string, result: BodyLookResult): Promise<BodyLookAnswer> {
    if (!this.enabled) return { kind: 'disabled' };
    // A look opened in a voice turn: what she says about it must follow that turn in the Talk, so the answer waits
    // until the client has stored the turn (bounded by `voiceTurnWaitMilliseconds`). The checks below run afterwards.
    const asked = this.store.get(scopeKey, id);
    if (asked?.outcome === 'pending' && asked.deviceId === deviceId) await this.lookWaits.get(id)?.stored;
    const at = this.dependencies.now();
    let look = this.store.get(scopeKey, id);
    // A frame of the owner's screen for a look nobody opened: the owner pressed the button himself. Opened here, answered below.
    if (!look && result.outcome === 'seen' && result.source === 'screen') {
      const opened = this.openOwnerScreen(scopeKey, deviceId, id, result.threadId ?? '', at);
      if ('kind' in opened) return opened;
      look = opened;
    }
    if (!look) return { kind: 'not_found' };
    if (look.deviceId !== deviceId) return { kind: 'wrong_device' };
    this.lookWaits.delete(id);
    if (look.outcome !== 'pending') return { kind: look.outcome === 'expired' ? 'expired' : 'answered' };
    if (Date.parse(at) >= Date.parse(look.expiresAt)) {
      this.sweep(scopeKey, at);
      return { kind: 'expired' };
    }
    // The open look is of the room or of the screen, and so is the frame that answers it.
    if (result.outcome === 'seen' && result.source !== look.source) return { kind: 'wrong_source' };
    // A look her activity loop opened: no Talk, her own model and key, and the loop records it.
    const own = look.threadId === BODY_LOOK_ACTIVITY_THREAD;
    const hand = own ? this.activity?.hand.get(scopeKey, id) ?? null : null;
    const viewer = own ? (hand ? this.activity?.viewer ?? null : null) : this.viewer;
    if (result.outcome === 'refused') {
      const closed = this.close(look, 'pending', 'refused', result.code, at);
      return closed ? { kind: 'done', id, status: 'refused', message: closed.message } : { kind: 'answered' };
    }
    // Someone else may be in the room: the frame is dropped without being shown to the model.
    if (result.audience !== 'owner') {
      const closed = this.close(look, 'pending', 'discarded', 'others_present', at, true);
      return closed ? { kind: 'done', id, status: 'discarded', message: closed.message } : { kind: 'answered' };
    }
    if (!viewer) {
      const closed = this.close(look, 'pending', 'failed', 'model_failed', at, true);
      return closed ? { kind: 'done', id, status: 'failed', message: closed.message } : { kind: 'answered' };
    }
    if (!this.store.advance(scopeKey, id, 'pending', 'seeing', at, { frameReceived: true })) return { kind: 'answered' };
    let text: string | null = null;
    try {
      text = (await viewer.see({
        scopeKey, image: result.image, context: own ? [] : this.context(look),
        ...(hand ? { activity: { lookId: id, model: hand.model } } : {}),
        ...(look.source === 'screen' ? { source: 'screen' as const } : {}),
      })).trim() || null;
    } catch { text = null; }
    this.spoken.delete(id);
    const doneAt = this.dependencies.now();
    if (this.withheld.delete(id)) {
      this.close({ ...look, ownerAsked: false }, 'seeing', 'failed', 'others_present', doneAt);
      return { kind: 'done', id, status: 'failed', message: null };
    }
    if (own) {
      // Her text waits for the loop, which writes the note and the record. A loop that already gave up gets nothing.
      if (text && this.activity!.hand.keepNote(scopeKey, id, text) && this.store.advance(scopeKey, id, 'seeing', 'seen', doneAt)) {
        return { kind: 'done', id, status: 'seen', message: null };
      }
      this.close(look, 'seeing', 'failed', 'model_failed', doneAt);
      return { kind: 'done', id, status: 'failed', message: null };
    }
    if (text && this.store.advance(scopeKey, id, 'seeing', 'seen', doneAt)) {
      try {
        this.dependencies.record(scopeKey, { summary: look.source === 'screen' ? BODY_SCREEN_LOOK_SEEN_SUMMARY : BODY_LOOK_SEEN_SUMMARY, outcome: 'done' });
      } catch {
        // A look that cannot be written to the activity record leaves no message either.
        return { kind: 'done', id, status: 'failed', message: null };
      }
      return { kind: 'done', id, status: 'seen', message: this.say(look, 'seen', text, doneAt) };
    }
    const closed = this.close(look, 'seeing', 'failed', 'model_failed', doneAt);
    return { kind: 'done', id, status: 'failed', message: closed?.message ?? null };
  }

  /** Closes looks nobody answered in time. Called on every turn, presence read and answer, and by a timer. */
  sweep(scopeKey: string, at: string): void {
    const time = Date.parse(at);
    for (const look of this.store.waiting(scopeKey)) {
      const overdue = time - Date.parse(look.expiresAt);
      if (look.outcome === 'pending' && overdue >= 0) this.close(look, 'pending', 'expired', 'timeout', at);
      else if (look.outcome === 'seeing' && overdue >= SEEING_GRACE_MILLISECONDS) this.close(look, 'seeing', 'failed', 'model_failed', at);
    }
  }

  /**
   * The owner's own screen look: he pressed the button, so there is no model choice and no body presence to wait for. The look
   * is opened here under the id the client chose, for its own device, in the Talk it names (or the latest one), and is answered
   * by the same frame. It shares the room's budget; nothing else about the frame differs. When the look cannot be taken, nothing
   * is opened and no model sees the frame.
   */
  private openOwnerScreen(
    scopeKey: string, deviceId: string, id: string, threadId: string, at: string,
  ): StoredBodyLook | { kind: 'answered' } | { kind: 'unavailable'; reason: ScreenLookUnavailable } {
    this.sweep(scopeKey, at);
    const time = Date.parse(at);
    const unavailable: ScreenLookUnavailable | null = !this.viewer ? 'no_viewer'
      : this.store.waiting(scopeKey).length ? 'busy'
        : this.store.usedSince(scopeKey, new Date(time - 60 * 60_000).toISOString()) >= this.config.perHour ? 'limit_hour'
          : this.store.usedOnDay(scopeKey, this.dependencies.dayKey(at)) >= this.config.perDay ? 'limit_day' : null;
    if (unavailable) return { kind: 'unavailable', reason: unavailable };
    this.store.prune(scopeKey, new Date(time - RETENTION_MILLISECONDS).toISOString());
    const look = {
      id, scopeKey, deviceId, threadId, requestedAt: at, expiresAt: new Date(time + BODY_LOOK_LIMITS.lifetimeMilliseconds).toISOString(),
      ownerAsked: true, source: 'screen' as const,
    };
    let opened = false;
    try { opened = this.store.open(look, this.dependencies.dayKey(at)); } catch { return { kind: 'answered' }; } // The id is already some other look's.
    return opened ? { ...look, outcome: 'pending' as const } : { kind: 'unavailable', reason: 'busy' };
  }

  private availability(scopeKey: string, at: string, audience: unknown): { deviceId: string } | Unavailable {
    if (!this.enabled) return 'switched_off';
    if (audience !== 'owner') return 'not_alone';
    if (!this.viewer) return 'no_viewer';
    const cameras = this.dependencies.cameraDevices(scopeKey);
    if (!cameras.length) return this.dependencies.bodyDevices && !this.dependencies.bodyDevices(scopeKey).length ? 'no_body' : 'no_camera';
    const time = Date.parse(at);
    const fresh = this.config.presenceFreshMilliseconds ?? BODY_LOOK_LIMITS.conversationPresenceFreshMilliseconds;
    const present = cameras
      .map(deviceId => ({ deviceId, readAt: this.presenceReads.get(`${scopeKey}\u0000${deviceId}`) ?? Number.NEGATIVE_INFINITY }))
      // A read that arrived after the turn began (while the reply was being decided) is as fresh as can be, not "from the future".
      .filter(device => Math.max(0, time - device.readAt) <= fresh)
      .sort((left, right) => right.readAt - left.readAt)[0];
    if (!present) return 'body_away';
    if (this.store.waiting(scopeKey).length) return 'busy';
    if (this.store.usedSince(scopeKey, new Date(time - 60 * 60_000).toISOString()) >= this.config.perHour) return 'limit_hour';
    if (this.store.usedOnDay(scopeKey, this.dependencies.dayKey(at)) >= this.config.perDay) return 'limit_day';
    return { deviceId: present.deviceId };
  }

  /** Opens the look the model chose. The conditions are checked again: the reply took time. */
  private open(scopeKey: string, threadId: string, choice: unknown, spoken?: readonly RoomLookContextLine[]): string | null {
    const chosen = roomLookChoice(choice);
    if (!chosen) return null;
    const at = this.dependencies.now();
    const state = this.availability(scopeKey, at, 'owner');
    if (typeof state === 'string') return null;
    const time = Date.parse(at);
    this.store.prune(scopeKey, new Date(time - RETENTION_MILLISECONDS).toISOString());
    const id = randomUUID();
    const opened = this.store.open({
      id, scopeKey, deviceId: state.deviceId, threadId, requestedAt: at,
      expiresAt: new Date(time + BODY_LOOK_LIMITS.lifetimeMilliseconds).toISOString(), ownerAsked: chosen === 'asked',
    }, this.dependencies.dayKey(at));
    if (!opened) return null;
    if (spoken?.length) {
      if (this.spoken.size >= 64) this.spoken.clear();
      this.spoken.set(id, spoken.slice(-2));
    }
    if (this.dependencies.timers !== false) {
      setTimeout(() => { try { this.sweep(scopeKey, this.dependencies.now()); } catch { /* the next read sweeps */ } },
        BODY_LOOK_LIMITS.lifetimeMilliseconds + 250).unref();
    }
    return id;
  }

  /**
   * A voice turn in which she said aloud that she would look, and no look was opened (the conditions stopped holding,
   * or the call was cut off): one honest line in the Talk and one activity entry, once the client has stored the turn,
   * so that the line follows it. Nothing is said if a turn other people could hear arrived meanwhile.
   */
  private unopened(scopeKey: string, threadId: string, wait: TurnWait | null, alone: () => boolean, code: BodyLookCode, line: string, reason: string): void {
    const say = () => {
      try {
        if (!alone()) return;
        const at = this.dependencies.now();
        try { this.dependencies.record(scopeKey, { summary: `部屋を見ませんでした（${reason}）。`, outcome: 'failed', reasonCode: code }); } catch {
           /* her line still says it */ }
        this.dependencies.speaker.say(scopeKey, threadId, { id: randomUUID(), outcome: 'not_seen' }, line, at);
      } catch { /* nothing more to do */ }
    };
    if (wait) void wait.stored.then(say); else say();
  }

  /** The last few messages of the look's Talk, then the voice turn it was opened in while that turn is not stored yet. */
  private context(look: StoredBodyLook): readonly RoomLookContextLine[] {
    const stored = this.dependencies.context(look.scopeKey, look.threadId);
    const spoken = (this.spoken.get(look.id) ?? []).filter(line => !stored.some(item => item.role === line.role && item.content === line.content));
    return [...stored, ...spoken].slice(-BODY_LOOK_LIMITS.contextMessages);
  }

  /** A turn other people can see ends a look in progress: nothing she saw is said in front of them. */
  private withdraw(scopeKey: string, at: string): void {
    for (const look of this.store.waiting(scopeKey)) {
      if (look.outcome === 'pending') this.close({ ...look, ownerAsked: false }, 'pending', 'refused', 'others_present', at);
      else this.withheld.add(look.id);
    }
  }

  /** Ends a look that did not become a message about the room: one activity entry, and one honest line if the owner had asked. */
  private close(look: StoredBodyLook, from: BodyLookOutcome, to: BodyLookOutcome, code: BodyLookCode, at: string, frameReceived = false): {
     message: BodyLookMessage | null } | null {
    if (!this.store.advance(look.scopeKey, look.id, from, to, at, { code, frameReceived })) return null;
    this.spoken.delete(look.id);
    this.lookWaits.delete(look.id);
    // Her activity loop reads the outcome and records it through the gate; nothing is said in a Talk.
    if (look.threadId === BODY_LOOK_ACTIVITY_THREAD) return { message: null };
    try {
      const screen = look.source === 'screen';
      this.dependencies.record(look.scopeKey, {
        summary: screen ? bodyScreenLookNotSeenSummary(code, to === 'discarded') : bodyLookNotSeenSummary(code, to === 'discarded'),
           outcome: 'failed', reasonCode: code,
      });
    } catch { /* her line below still tells the owner */ }
    return { message: look.ownerAsked ? this.say(look, 'not_seen', look.source === 'screen' ? bodyScreenLookNotSeenLine(code) :
       bodyLookNotSeenLine(code), at) : null };
  }

  /**
   * Stage 2 only: tells the activity loop, through one timestamp per device, that a body with its camera on is
   * showing her window. With stage 2 off (or no camera) reading presence still writes nothing.
   */
  private markForActivity(scopeKey: string, deviceId: string, at: string): void {
    if (!this.activity || this.config.activityPerDay < 1) return;
    const key = `${scopeKey}\u0000${deviceId}`;
    const time = Date.parse(at);
    const last = this.presenceMarks.get(key);
    if (last !== undefined && time - last >= 0 && time - last < PRESENCE_MARK_MILLISECONDS) return;
    try {
      if (!this.dependencies.cameraDevices(scopeKey).includes(deviceId)) return;
      if (this.presenceMarks.size >= 256) this.presenceMarks.clear();
      this.presenceMarks.set(key, time);
      this.activity.hand.markPresence(scopeKey, deviceId, at);
      this.activity.hand.prune(scopeKey, new Date(time - HAND_OFF_MILLISECONDS).toISOString(), new Date(time - RETENTION_MILLISECONDS).toISOString());
    } catch { /* presence is still answered; the loop simply does not plan a look */ }
  }

  private say(look: StoredBodyLook, outcome: 'seen' | 'not_seen', text: string, at: string): BodyLookMessage | null {
    try { return this.dependencies.speaker.say(look.scopeKey, look.threadId, { id: look.id, outcome, ...(look.source === 'screen' ? {
       source: 'screen' as const } : {}) }, text, at); } catch { return null; }
  }
}
