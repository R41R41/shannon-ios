import { randomUUID } from 'node:crypto';
import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import {
  BODY_LOOK_LIMITS, configuredBodyLook, roomLookChoice,
  type BodyLookCode, type BodyLookConfig, type BodyLookResult,
} from './bodyLookContract.js';
import { bodyLookNotSeenLine } from './bodyLookLines.js';
import { SQLiteBodyLookStore, type BodyLookOutcome, type StoredBodyLook } from './bodyLookStore.js';
import type { RoomLookContextLine, RoomLookViewer } from './bodyLookVision.js';

/**
 * One look at the room, from the offer in an owner text turn to her next message.
 *
 * - Deciding: the look is offered to the conversation model only in a text turn with the
 *   owner alone, while a body with its camera on is showing her window, the limits have
 *   room, and both switches are on. The model chooses it in the structured reply; a
 *   choice that arrives without an offer is ignored.
 * - Asking: the open look is carried by `GET /v1/body/presence` to the one device it was
 *   opened for, for 30 seconds.
 * - Seeing: the frame goes to the model once and is dropped. This module holds it only as
 *   the argument of that call. What remains is her message, and one line in the activity record.
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
  say(scopeKey: string, threadId: string, look: { id: string; outcome: 'seen' | 'not_seen' }, text: string, at: string): BodyLookMessage | null;
}

export interface BodyLookOptions {
  store?: SQLiteBodyLookStore;
  config?: BodyLookConfig;
  /** The one model call of a look. Without it a look is never offered. */
  viewer?: RoomLookViewer | null;
  speaker?: BodyLookSpeaker;
  /** False in tests that drive expiry by the clock they control. */
  timers?: boolean;
}

export interface BodyLookDependencies extends BodyLookOptions {
  /** `SHANNON_BODY_INGEST`: with the body switched off there is no look either. */
  ingestEnabled: boolean;
  now: () => string;
  /** Owner-local day of an instant. */
  dayKey(at: string): string;
  /** Devices that registered `flags.camera: true`. */
  cameraDevices(scopeKey: string): readonly string[];
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
  | { kind: 'disabled' | 'not_found' | 'wrong_device' | 'answered' | 'expired' }
  | { kind: 'done'; id: string; status: 'seen' | 'refused' | 'discarded' | 'failed'; message: BodyLookMessage | null };

type Unavailable = 'switched_off' | 'not_alone' | 'no_viewer' | 'no_camera' | 'body_away' | 'busy' | 'limit_hour' | 'limit_day';

const UNAVAILABLE_REASON: Readonly<Record<Unavailable, string>> = Object.freeze({
  switched_off: 'この機能は止めてある',
  not_alone: 'ほかの人がいる場では見ない',
  no_viewer: '見る仕組みがいまは使えない',
  no_camera: '体のカメラが入っていない',
  body_away: '体の窓が出ていない',
  busy: 'いま見ている途中',
  limit_hour: 'この1時間に見られる回数を使い切った',
  limit_day: '今日見られる回数を使い切った',
});

/** Neutral wording for the activity record. */
const NOT_SEEN_REASON: Readonly<Record<BodyLookCode, string>> = Object.freeze({
  camera_off: 'カメラが切ってあった',
  window_hidden: '体の窓が隠れていた',
  busy: '体が別のことをしていた',
  no_camera: 'カメラがなかった',
  denied: 'カメラを使う許可がなかった',
  failed: '写せなかった',
  timeout: '体から返事がなかった',
  others_present: 'ほかの人がいるかもしれなかった',
  rate_limited: '体の側の回数の上限に達していた',
  model_failed: '届いた1枚を見られなかった',
});

export const BODY_LOOK_TOOL = 'body.look';
export const BODY_LOOK_SEEN_SUMMARY = '部屋を一度見ました。';
export const bodyLookNotSeenSummary = (code: BodyLookCode, frameDiscarded = false) =>
  `部屋を見ませんでした（${NOT_SEEN_REASON[code]}${frameDiscarded ? '。届いた1枚は見ずに捨てた' : ''}）。`;

export const ROOM_LOOK_OFFER_PROMPT = `[部屋を見る]（いまは体のカメラで部屋を一度だけ見られる。${SHANNON_OWNER_NAME}に見てと言われた時か、自分が見たい時だけ、返答のroomLookで選ぶ。`
  + '見えたものはこの返事のあとで届く。この返事では見てみると伝えるだけにして、まだ見ていないものを語らない）';
export const roomLookUnavailablePrompt = (reason: Unavailable) =>
  `[部屋を見る]（体のカメラで部屋を見てほしいという頼みなら、いまは見られない: ${UNAVAILABLE_REASON[reason]}。見たふりをせず、見られないと正直に伝える）`;

/**
 * The owner's words ask her to look. This only decides whether the turn is told that she
 * cannot look right now; it never starts a look. Starting one is the model's choice.
 */
export function asksToLook(message: string): boolean {
  return /(?:部屋|まわり|周り|こっち|ここ|これ|机|外|カメラ)[^。！？\n]{0,12}(?:見て|見える|見えて|見れる|見られる|のぞいて|写して)|見て(?:みて|ほしい|くれ)|カメラ(?:で|を)/u.test(message);
}

const NO_TURN: BodyLookTurn = Object.freeze({ prompt: '', request: Object.freeze({}), decide: () => undefined });
/** A look the model is seeing is given up this long after its expiry (the process stopped mid-call). */
const SEEING_GRACE_MILLISECONDS = 90_000;
const RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;

export class BodyLooks {
  private readonly store: SQLiteBodyLookStore;
  private readonly config: BodyLookConfig;
  private readonly viewer: RoomLookViewer | null;
  /** When each device last read presence. Memory only: reading presence still writes nothing. */
  private readonly presenceReads = new Map<string, number>();
  private readonly lastTurns = new Map<string, number>();
  /** Looks whose message must not be delivered because someone else joined while the model was seeing. */
  private readonly withheld = new Set<string>();

  constructor(private readonly dependencies: BodyLookDependencies) {
    this.store = dependencies.store ?? new SQLiteBodyLookStore(':memory:');
    this.config = dependencies.config ?? configuredBodyLook({});
    this.viewer = dependencies.viewer ?? null;
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
      this.lastTurns.set(scopeKey, Date.parse(at));
      this.sweep(scopeKey, at);
      if (audience !== 'owner') this.withdraw(scopeKey, at);
      const state = this.availability(scopeKey, at, audience);
      if (typeof state === 'string') return asksToLook(message) ? { ...NO_TURN, prompt: roomLookUnavailablePrompt(state) } : NO_TURN;
      return {
        prompt: ROOM_LOOK_OFFER_PROMPT,
        request: { offerRoomLook: true },
        decide: (choice, threadId) => { try { this.open(scopeKey, threadId, choice); } catch { /* the reply is already written */ } },
      };
    } catch { return NO_TURN; }
  }

  /** The `look` field and the poll interval of one presence read. With the switch off there is no `look` key. */
  presence(scopeKey: string, deviceId: string, at: string): { look?: { id: string; requestedAt: string; expiresAt: string } | null; fastPoll: boolean } {
    if (!this.enabled) return { fastPoll: false };
    const time = Date.parse(at);
    if (this.presenceReads.size >= 256) this.presenceReads.clear();
    this.presenceReads.set(`${scopeKey}\u0000${deviceId}`, time);
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
    const at = this.dependencies.now();
    const look = this.store.get(scopeKey, id);
    if (!look) return { kind: 'not_found' };
    if (look.deviceId !== deviceId) return { kind: 'wrong_device' };
    if (look.outcome !== 'pending') return { kind: look.outcome === 'expired' ? 'expired' : 'answered' };
    if (Date.parse(at) >= Date.parse(look.expiresAt)) {
      this.sweep(scopeKey, at);
      return { kind: 'expired' };
    }
    if (result.outcome === 'refused') {
      const closed = this.close(look, 'pending', 'refused', result.code, at);
      return closed ? { kind: 'done', id, status: 'refused', message: closed.message } : { kind: 'answered' };
    }
    // Someone else may be in the room: the frame is dropped without being shown to the model.
    if (result.audience !== 'owner') {
      const closed = this.close(look, 'pending', 'discarded', 'others_present', at, true);
      return closed ? { kind: 'done', id, status: 'discarded', message: closed.message } : { kind: 'answered' };
    }
    if (!this.viewer) {
      const closed = this.close(look, 'pending', 'failed', 'model_failed', at, true);
      return closed ? { kind: 'done', id, status: 'failed', message: closed.message } : { kind: 'answered' };
    }
    if (!this.store.advance(scopeKey, id, 'pending', 'seeing', at, { frameReceived: true })) return { kind: 'answered' };
    let text: string | null = null;
    try {
      text = (await this.viewer.see({ scopeKey, image: result.image, context: this.dependencies.context(scopeKey, look.threadId) })).trim() || null;
    } catch { text = null; }
    const doneAt = this.dependencies.now();
    if (this.withheld.delete(id)) {
      this.close({ ...look, ownerAsked: false }, 'seeing', 'failed', 'others_present', doneAt);
      return { kind: 'done', id, status: 'failed', message: null };
    }
    if (text && this.store.advance(scopeKey, id, 'seeing', 'seen', doneAt)) {
      try {
        this.dependencies.record(scopeKey, { summary: BODY_LOOK_SEEN_SUMMARY, outcome: 'done' });
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

  private availability(scopeKey: string, at: string, audience: unknown): { deviceId: string } | Unavailable {
    if (!this.enabled) return 'switched_off';
    if (audience !== 'owner') return 'not_alone';
    if (!this.viewer) return 'no_viewer';
    const cameras = this.dependencies.cameraDevices(scopeKey);
    if (!cameras.length) return 'no_camera';
    const time = Date.parse(at);
    const present = cameras
      .map(deviceId => ({ deviceId, readAt: this.presenceReads.get(`${scopeKey}\u0000${deviceId}`) ?? Number.NEGATIVE_INFINITY }))
      .filter(device => time - device.readAt >= 0 && time - device.readAt <= BODY_LOOK_LIMITS.presenceFreshMilliseconds)
      .sort((left, right) => right.readAt - left.readAt)[0];
    if (!present) return 'body_away';
    if (this.store.waiting(scopeKey).length) return 'busy';
    if (this.store.usedSince(scopeKey, new Date(time - 60 * 60_000).toISOString()) >= this.config.perHour) return 'limit_hour';
    if (this.store.usedOnDay(scopeKey, this.dependencies.dayKey(at)) >= this.config.perDay) return 'limit_day';
    return { deviceId: present.deviceId };
  }

  /** Opens the look the model chose. The conditions are checked again: the reply took time. */
  private open(scopeKey: string, threadId: string, choice: unknown): void {
    const chosen = roomLookChoice(choice);
    if (!chosen) return;
    const at = this.dependencies.now();
    const state = this.availability(scopeKey, at, 'owner');
    if (typeof state === 'string') return;
    const time = Date.parse(at);
    this.store.prune(scopeKey, new Date(time - RETENTION_MILLISECONDS).toISOString());
    const opened = this.store.open({
      id: randomUUID(), scopeKey, deviceId: state.deviceId, threadId, requestedAt: at,
      expiresAt: new Date(time + BODY_LOOK_LIMITS.lifetimeMilliseconds).toISOString(), ownerAsked: chosen === 'asked',
    }, this.dependencies.dayKey(at));
    if (opened && this.dependencies.timers !== false) {
      setTimeout(() => { try { this.sweep(scopeKey, this.dependencies.now()); } catch { /* the next read sweeps */ } },
        BODY_LOOK_LIMITS.lifetimeMilliseconds + 250).unref();
    }
  }

  /** A turn other people can see ends a look in progress: nothing she saw is said in front of them. */
  private withdraw(scopeKey: string, at: string): void {
    for (const look of this.store.waiting(scopeKey)) {
      if (look.outcome === 'pending') this.close({ ...look, ownerAsked: false }, 'pending', 'refused', 'others_present', at);
      else this.withheld.add(look.id);
    }
  }

  /** Ends a look that did not become a message about the room: one activity entry, and one honest line if the owner had asked. */
  private close(look: StoredBodyLook, from: BodyLookOutcome, to: BodyLookOutcome, code: BodyLookCode, at: string, frameReceived = false): { message: BodyLookMessage | null } | null {
    if (!this.store.advance(look.scopeKey, look.id, from, to, at, { code, frameReceived })) return null;
    try {
      this.dependencies.record(look.scopeKey, { summary: bodyLookNotSeenSummary(code, to === 'discarded'), outcome: 'failed', reasonCode: code });
    } catch { /* her line below still tells the owner */ }
    return { message: look.ownerAsked ? this.say(look, 'not_seen', bodyLookNotSeenLine(code), at) : null };
  }

  private say(look: StoredBodyLook, outcome: 'seen' | 'not_seen', text: string, at: string): BodyLookMessage | null {
    try { return this.dependencies.speaker.say(look.scopeKey, look.threadId, { id: look.id, outcome }, text, at); } catch { return null; }
  }
}
