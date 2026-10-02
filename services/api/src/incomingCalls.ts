import { randomUUID } from 'node:crypto';
import type { BodyReachOutDeliveryOutcome } from './bodyContract.js';
import { INCOMING_CALL_LIMITS, type IncomingCallOutcome, type IncomingCallRegistration } from './incomingCallContract.js';
import type { SQLiteIncomingCallStore } from './incomingCallStore.js';
import { PRIVATE_REACH_OUT_LIMITS } from './privateListeningContract.js';
import type { ClaimedReachOut, SQLiteReachOutClaims } from './reachOutClaims.js';
import type { VoipPushSender } from './voipPushSender.js';

/**
 * A call from Shannon (owner decision 2026-10-03, `docs/incoming-call-contract.md`).
 *
 * Her message is written as before: one assistant message in the Talk and one initiative. When no surface can
 * simply say it, the server rings the owner's iPhone with it, once. Answering is his choice; then the app takes
 * her words through the claim route, says them in her voice, and an ordinary voice conversation follows.
 *
 * The order of surfaces for one message:
 *   1. one of his apps that is privately listening and speaks (`privateReachOuts.ts`), as before;
 *   2. her body, when it is there and shows the message, by its own rules, as before;
 *   3. the call, when he switched 「シャノンからの着信を受ける」 on.
 * The call holds the message's claim (`iphone_call`) from before the push, so no other surface says it while
 * the phone rings or after he answered.
 *
 * Nothing here calls a model, and nothing here reads or writes words except to hand her own line to the device
 * that answered.
 */
export interface IncomingCallsDependencies {
  store: SQLiteIncomingCallStore;
  claims: Pick<SQLiteReachOutClaims, 'unread' | 'message' | 'claim' | 'release' | 'markSpoken' | 'holder' | 'ownerActiveAfter'>;
  /** Whether one of his apps would say this message through his earphones now. */
  appSpeaks: (scopeKey: string, at: string, initiativeId: string) => boolean;
  /** What the server knows of her body: whether it read presence a moment ago, and what it reported about this message. */
  body: { windowVisible(scopeKey: string, at: string): boolean; delivery(scopeKey: string, initiativeId: string): BodyReachOutDeliveryOutcome | null };
  /** Whether the device still holds a pairing that is neither revoked nor expired. */
  isPaired: (scopeKey: string, deviceId: string) => boolean;
  sender: VoipPushSender;
  /** `SHANNON_INCOMING_CALLS`, and the claim mechanism (`SHANNON_PRIVATE_LISTENING_REACH_OUTS`) it relies on. */
  enabled: boolean;
  /** Only the owner's own scope is ever rung. */
  ownerScopeKey: string;
  now: () => string;
  newCallId?: () => string;
  /** A fixed word and a status; never a token, never her words. */
  log?: (event: 'ringing' | 'failed', detail: { status: number; reason: string | null }) => void;
}

export type IncomingCallAnswer =
  | { kind: 'answered'; status: 'claimed' | 'held'; message: ClaimedReachOut }
  | { kind: 'disabled' | 'not_found' | 'not_yours' | 'expired' | 'ended' };

export type IncomingCallReport =
  | { kind: 'done'; status: 'stored' | 'duplicate' | 'kept' }
  | { kind: 'not_found' | 'not_yours' | 'conflict' };

/** What her body reports when it did not show her message: the call may then ring at once. */
const BODY_DID_NOT_SHOW: readonly BodyReachOutDeliveryOutcome[] = ['away', 'hidden', 'muted'];

export class IncomingCalls {
  private placing = false;
  /** Calls whose push is on its way in this process: they are not closed as interrupted meanwhile. */
  private readonly sending = new Set<string>();

  constructor(private readonly dependencies: IncomingCallsDependencies) {}

  /** Whether a call can be placed at all: switched on, and the server holds what APNs needs. */
  get available(): boolean { return this.dependencies.enabled && this.dependencies.sender.enabled; }

  register(scopeKey: string, deviceId: string, registration: IncomingCallRegistration): void {
    this.dependencies.store.register(scopeKey, deviceId, registration, this.dependencies.now());
  }

  /** Whether this device is registered with the owner's switch on. */
  registered(scopeKey: string, deviceId: string): boolean {
    return this.dependencies.store.devices(scopeKey).some(device => device.deviceId === deviceId);
  }

  /** One look: closes what is over, and rings with at most one message. Never throws. */
  async tick(): Promise<void> {
    if (this.placing) return;
    this.placing = true;
    try {
      const scopeKey = this.dependencies.ownerScopeKey;
      this.expire(scopeKey);
      if (this.available) await this.place(scopeKey);
    } catch { /* the next look tries again */ } finally {
      this.placing = false;
    }
  }

  /** A row whose push was never confirmed is closed and never sent again; a ring nobody reported on was not answered. */
  private expire(scopeKey: string): void {
    const { store, claims } = this.dependencies;
    const at = this.dependencies.now();
    const time = Date.parse(at);
    for (const call of store.openCalls(scopeKey)) {
      if (call.state === 'pending' && !this.sending.has(call.callId) && time - Date.parse(call.createdAt) > INCOMING_CALL_LIMITS.pendingMilliseconds) {
        if (store.end(call.callId, ['pending'], 'failed', 'server', at, { reason: 'interrupted' })) claims.release(scopeKey, call.initiativeId, call.deviceId);
      } else if (call.state === 'ringing' && time - Date.parse(call.expiresAt) > INCOMING_CALL_LIMITS.reportGraceMilliseconds) {
        store.end(call.callId, ['ringing'], 'unanswered', 'server', at);
      }
    }
  }

  private async place(scopeKey: string): Promise<void> {
    const { store, claims, sender } = this.dependencies;
    const at = this.dependencies.now();
    // Only the newest of her messages, and only while it is fresh: an older one stays text.
    const newest = claims.unread(scopeKey).find(message => fresh(message.createdAt, at));
    if (!newest) return;
    if (newest.claim) {
      // A claim of a call without its row: the process stopped between the two. It is given back.
      if (newest.claim.surface === 'iphone_call' && newest.claim.spokenAt === null && !store.ofMessage(scopeKey, newest.id)) {
        claims.release(scopeKey, newest.id, newest.claim.deviceId);
      }
      return;
    }
    // One call per message, whatever became of it.
    if (store.ofMessage(scopeKey, newest.id)) return;
    const message = claims.message(scopeKey, newest.id);
    // Her one second call after an unanswered message is never a ring: he is not rung twice about one thing.
    if (!message || message.read || message.reason === 'follow_up') return;
    // Never into a conversation: he wrote or spoke in the last minutes, in any Talk.
    if (claims.ownerActiveAfter(scopeKey, new Date(Date.parse(at) - INCOMING_CALL_LIMITS.conversationQuietMilliseconds).toISOString())) return;
    if (this.dependencies.appSpeaks(scopeKey, at, newest.id)) return;
    if (this.bodyMayStillTakeIt(scopeKey, newest.id, newest.createdAt, at)) return;
    const device = store.devices(scopeKey).find(candidate => this.dependencies.isPaired(scopeKey, candidate.deviceId));
    if (!device) return;
    // The claim first: from here no other surface says it. Then the row, then the push.
    if (claims.claim(scopeKey, newest.id, device.deviceId, 'iphone_call', at) !== 'claimed') return;
    const callId = (this.dependencies.newCallId ?? randomUUID)();
    const expiresAt = new Date(Date.parse(at) + INCOMING_CALL_LIMITS.ringSeconds * 1_000).toISOString();
    if (!store.begin(scopeKey, { callId, initiativeId: newest.id, deviceId: device.deviceId, threadId: message.threadId, expiresAt }, at)) {
      claims.release(scopeKey, newest.id, device.deviceId);
      return;
    }
    this.sending.add(callId);
    let result: Awaited<ReturnType<VoipPushSender['send']>>;
    try {
      result = await sender.send(
        { deviceToken: device.deviceToken, environment: device.environment, bundleId: device.bundleId },
        { callId, reachOutId: newest.id, threadId: message.threadId, expiresAt },
      );
    } catch {
      result = { delivered: false, invalidToken: false, status: 0, reason: 'transport' };
    } finally {
      this.sending.delete(callId);
    }
    const after = this.dependencies.now();
    if (result.delivered) {
      store.ringing(callId, after, result.status);
      this.dependencies.log?.('ringing', { status: result.status, reason: null });
      return;
    }
    // It never rang: the message goes back, so her body or an app in his ears may still say it. It is not rung with again.
    if (store.end(callId, ['pending'], 'failed', 'server', after, { status: result.status, ...(result.reason ? { reason: result.reason } : {}) })) {
      claims.release(scopeKey, newest.id, device.deviceId);
    }
    if (result.invalidToken) store.invalidateDevice(device.deviceId, after);
    this.dependencies.log?.('failed', { status: result.status, reason: result.reason });
  }

  /**
   * Her body comes before the call when it is there and shows the message. A body that read presence a moment ago
   * takes a fresh message at its next read; the call waits for that, for a bounded time. A body that reported it
   * did not show the message (the owner away, her window hidden, 「話しかける」 off) has given it back.
   */
  private bodyMayStillTakeIt(scopeKey: string, initiativeId: string, createdAt: string, at: string): boolean {
    try {
      const { body } = this.dependencies;
      if (!body.windowVisible(scopeKey, at)) return false;
      const reported = body.delivery(scopeKey, initiativeId);
      if (reported) return !BODY_DID_NOT_SHOW.includes(reported);
      return Date.parse(at) - Date.parse(createdAt) < INCOMING_CALL_LIMITS.bodyGraceMilliseconds;
    } catch { return false; }
  }

  /**
   * He answered: the device that was rung takes her words. From here the message counts as said, and its claim is
   * never given back. The same request again gets the same answer, so a lost reply can be asked for again.
   */
  answer(scopeKey: string, deviceId: string, initiativeId: string, callId: string): IncomingCallAnswer {
    const { store, claims } = this.dependencies;
    if (!this.dependencies.enabled) return { kind: 'disabled' };
    const call = store.call(scopeKey, callId);
    if (!call || call.initiativeId !== initiativeId) return { kind: 'not_found' };
    if (call.deviceId !== deviceId) return { kind: 'not_yours' };
    const found = claims.message(scopeKey, initiativeId);
    if (!found) return { kind: 'not_found' };
    const { read: _read, ...message } = found;
    if (call.state === 'answered') return { kind: 'answered', status: 'held', message };
    if (call.state !== 'pending' && call.state !== 'ringing') return { kind: call.state === 'unanswered' ? 'expired' : 'ended' };
    const at = this.dependencies.now();
    if (Date.parse(at) - Date.parse(call.expiresAt) > INCOMING_CALL_LIMITS.reportGraceMilliseconds) {
      store.end(callId, ['pending', 'ringing'], 'unanswered', 'server', at);
      return { kind: 'expired' };
    }
    const holder = claims.holder(scopeKey, initiativeId);
    if (!holder || holder.deviceId !== deviceId || holder.surface !== 'iphone_call') return { kind: 'ended' };
    if (!store.end(callId, ['pending', 'ringing'], 'answered', 'app', at)) return { kind: 'ended' };
    claims.markSpoken(scopeKey, initiativeId, deviceId, at);
    return { kind: 'answered', status: 'claimed', message };
  }

  /** What the app says became of the call: he answered, he declined, it rang out, or it could not be shown or heard. */
  report(scopeKey: string, deviceId: string, callId: string, outcome: IncomingCallOutcome): IncomingCallReport {
    const { store, claims } = this.dependencies;
    const call = store.call(scopeKey, callId);
    if (!call) return { kind: 'not_found' };
    if (call.deviceId !== deviceId) return { kind: 'not_yours' };
    if (call.state === outcome) return { kind: 'done', status: 'duplicate' };
    const at = this.dependencies.now();
    // Once he answered, the call was answered: what went wrong afterwards does not undo that.
    if (call.state === 'answered') return { kind: 'done', status: 'kept' };
    const changed = call.state === 'pending' || call.state === 'ringing'
      ? store.end(callId, ['pending', 'ringing'], outcome, 'app', at)
      // The server had only assumed that nobody answered: the app knows.
      : call.state === 'unanswered' && call.decidedBy === 'server' && store.correct(callId, outcome, at);
    if (!changed) return { kind: 'conflict' };
    if (outcome === 'answered') claims.markSpoken(scopeKey, call.initiativeId, deviceId, at);
    // It could not ring or be heard: the message goes back. Declined or not answered, it stays the call's: nobody says it after he chose not to hear it.
    if (outcome === 'failed') claims.release(scopeKey, call.initiativeId, deviceId);
    return { kind: 'done', status: 'stored' };
  }
}

/** The same span in which an app may say her message: a ring begins only this soon after she wrote it. */
function fresh(createdAt: string, at: string): boolean {
  const age = Date.parse(at) - Date.parse(createdAt);
  return age >= -PRIVATE_REACH_OUT_LIMITS.futureSkewMilliseconds && age <= PRIVATE_REACH_OUT_LIMITS.freshMilliseconds;
}
