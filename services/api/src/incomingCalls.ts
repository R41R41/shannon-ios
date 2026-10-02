import { INCOMING_CALL_LIMITS, type IncomingCallOutcome, type IncomingCallRegistration } from './incomingCallContract.js';
import type { IncomingCall, SQLiteIncomingCallStore } from './incomingCallStore.js';
import type { ClaimedReachOut, SQLiteReachOutClaims } from './reachOutClaims.js';
import type { VoipPushSender } from './voipPushSender.js';

/**
 * A call from Shannon (owner decisions 2026-10-03, `docs/incoming-call-contract.md`).
 *
 * The call is her own act: a step of her activity loop (`autonomyLoopPhoneStep.ts`) that she chooses when she wants to
 * tell him something and he is not in the app. That step writes her line as a message of hers (the Talk, an initiative,
 * the ordinary notification), takes the message's claim as `iphone_call`, and asks for the call: one `pending` row
 * (`incomingCallRequests.ts`). Nothing rings by itself: an ordinary message of hers is never rung with.
 *
 * This class is the API's side. It sends the push for a call she asked for, once; hands her words to the device that
 * answered; and keeps what became of the call. The claim is held from before the push, so no other surface says the
 * message while the phone rings or after he answered.
 *
 * Nothing here calls a model, and nothing here reads or writes words except to hand her own line to the device
 * that answered.
 */
export interface IncomingCallsDependencies {
  store: SQLiteIncomingCallStore;
  claims: Pick<SQLiteReachOutClaims, 'message' | 'release' | 'markSpoken' | 'holder' | 'ownerActiveAfter' | 'unread'>;
  /** Whether the device still holds a pairing that is neither revoked nor expired. */
  isPaired: (scopeKey: string, deviceId: string) => boolean;
  sender: VoipPushSender;
  /** `SHANNON_INCOMING_CALLS`, and the claim mechanism (`SHANNON_PRIVATE_LISTENING_REACH_OUTS`) it relies on. */
  enabled: boolean;
  /** Only the owner's own scope is ever rung. */
  ownerScopeKey: string;
  now: () => string;
  /** A fixed word and a status; never a token, never her words. */
  log?: (event: 'ringing' | 'failed', detail: { status: number; reason: string | null }) => void;
}

export type IncomingCallAnswer =
  | { kind: 'answered'; status: 'claimed' | 'held'; message: ClaimedReachOut }
  | { kind: 'disabled' | 'not_found' | 'not_yours' | 'expired' | 'ended' };

export type IncomingCallReport =
  | { kind: 'done'; status: 'stored' | 'duplicate' | 'kept' }
  | { kind: 'not_found' | 'not_yours' | 'conflict' };

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

  /** One look: closes what is over, and sends the calls she asked for. Never throws. */
  async tick(): Promise<void> {
    if (this.placing) return;
    this.placing = true;
    try {
      const scopeKey = this.dependencies.ownerScopeKey;
      this.expire(scopeKey);
      for (const call of this.dependencies.store.openCalls(scopeKey)) {
        if (call.state === 'pending') await this.send(scopeKey, call);
      }
    } catch { /* the next look tries again */ } finally {
      this.placing = false;
    }
  }

  /**
   * A call she asked for that was not sent in time, or that a stopped process left half-sent, is closed and never sent;
   * a ring nobody reported on was not answered.
   */
  private expire(scopeKey: string): void {
    const { store, claims } = this.dependencies;
    const at = this.dependencies.now();
    const time = Date.parse(at);
    // A claim of a call without its row: her process stopped between the two. It is given back, so the message is not left
    // with nobody to say it.
    for (const message of claims.unread(scopeKey)) {
      if (message.claim?.surface === 'iphone_call' && message.claim.spokenAt === null && !store.ofMessage(scopeKey, message.id)
        && time - Date.parse(message.claim.claimedAt) > INCOMING_CALL_LIMITS.pendingMilliseconds) {
        claims.release(scopeKey, message.id, message.claim.deviceId);
      }
    }
    for (const call of store.openCalls(scopeKey)) {
      if (call.state === 'pending' && time - Date.parse(call.createdAt) > INCOMING_CALL_LIMITS.pendingMilliseconds) {
        if (store.end(call.callId, ['pending'], 'failed', 'server', at, { reason: 'not_sent' })) claims.release(scopeKey, call.initiativeId, call.deviceId);
      } else if (call.state === 'sending' && !this.sending.has(call.callId)) {
        // Another process took it and stopped: whether the push left is not known, so it is not sent again. The claim stays
        // the call's for a ring's length, in case the phone does ring and he answers.
        if (time - Date.parse(call.expiresAt) > INCOMING_CALL_LIMITS.reportGraceMilliseconds
          && store.end(call.callId, ['sending'], 'failed', 'server', at, { reason: 'interrupted' })) claims.release(scopeKey, call.initiativeId, call.deviceId);
      } else if (call.state === 'ringing' && time - Date.parse(call.expiresAt) > INCOMING_CALL_LIMITS.reportGraceMilliseconds) {
        store.end(call.callId, ['ringing'], 'unanswered', 'server', at);
      }
    }
  }

  /** Why a call she asked for cannot ring now, as a code; null when it can. Checked again here, a moment after she chose. */
  private refusal(scopeKey: string, call: IncomingCall, at: string): string | null {
    const { store, claims } = this.dependencies;
    if (!this.available) return 'unavailable';
    const message = claims.message(scopeKey, call.initiativeId);
    if (!message || message.read) return 'read';
    // Never into a conversation: he wrote or spoke in the last minutes, in any Talk.
    if (claims.ownerActiveAfter(scopeKey, new Date(Date.parse(at) - INCOMING_CALL_LIMITS.conversationQuietMilliseconds).toISOString())) return 'conversation';
    // Never while another call of hers rings.
    if (store.openCalls(scopeKey).some(other => other.callId !== call.callId && other.state !== 'pending')) return 'busy';
    const holder = claims.holder(scopeKey, call.initiativeId);
    if (!holder || holder.surface !== 'iphone_call' || holder.deviceId !== call.deviceId) return 'not_claimed';
    const device = store.devices(scopeKey).find(candidate => candidate.deviceId === call.deviceId);
    if (!device || !this.dependencies.isPaired(scopeKey, device.deviceId)) return 'no_device';
    return null;
  }

  private async send(scopeKey: string, call: IncomingCall): Promise<void> {
    const { store, claims, sender } = this.dependencies;
    const at = this.dependencies.now();
    const refusal = this.refusal(scopeKey, call, at);
    if (refusal) {
      if (store.end(call.callId, ['pending'], 'failed', 'server', at, { reason: refusal })) claims.release(scopeKey, call.initiativeId, call.deviceId);
      this.dependencies.log?.('failed', { status: 0, reason: refusal });
      return;
    }
    const device = store.devices(scopeKey).find(candidate => candidate.deviceId === call.deviceId)!;
    const expiresAt = new Date(Date.parse(at) + INCOMING_CALL_LIMITS.ringSeconds * 1_000).toISOString();
    // Taken before the push: only one process sends it, and only once, also across a restart.
    if (!store.take(call.callId, expiresAt)) return;
    this.sending.add(call.callId);
    let result: Awaited<ReturnType<VoipPushSender['send']>>;
    try {
      result = await sender.send(
        { deviceToken: device.deviceToken, environment: device.environment, bundleId: device.bundleId },
        { callId: call.callId, reachOutId: call.initiativeId, threadId: call.threadId, expiresAt },
      );
    } catch {
      result = { delivered: false, invalidToken: false, status: 0, reason: 'transport' };
    } finally {
      this.sending.delete(call.callId);
    }
    const after = this.dependencies.now();
    if (result.delivered) {
      store.ringing(call.callId, after, result.status);
      this.dependencies.log?.('ringing', { status: result.status, reason: null });
      return;
    }
    // It never rang: the message goes back, so her body or an app in his ears may still say it.
    if (store.end(call.callId, ['sending'], 'failed', 'server', after, { status: result.status, ...(result.reason ? { reason: result.reason } : {}) })) {
      claims.release(scopeKey, call.initiativeId, call.deviceId);
    }
    if (result.invalidToken) store.invalidateDevice(device.deviceId, after);
    this.dependencies.log?.('failed', { status: result.status, reason: result.reason });
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
    if (call.state !== 'sending' && call.state !== 'ringing') return { kind: call.state === 'unanswered' ? 'expired' : 'ended' };
    const at = this.dependencies.now();
    if (Date.parse(at) - Date.parse(call.expiresAt) > INCOMING_CALL_LIMITS.reportGraceMilliseconds) {
      store.end(callId, ['sending', 'ringing'], 'unanswered', 'server', at);
      return { kind: 'expired' };
    }
    const holder = claims.holder(scopeKey, initiativeId);
    if (!holder || holder.deviceId !== deviceId || holder.surface !== 'iphone_call') return { kind: 'ended' };
    if (!store.end(callId, ['sending', 'ringing'], 'answered', 'app', at)) return { kind: 'ended' };
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
    const changed = call.state === 'sending' || call.state === 'ringing'
      ? store.end(callId, ['sending', 'ringing'], outcome, 'app', at)
      // The server had only assumed that nobody answered: the app knows.
      : call.state === 'unanswered' && call.decidedBy === 'server' && store.correct(callId, outcome, at);
    if (!changed) return { kind: 'conflict' };
    if (outcome === 'answered') claims.markSpoken(scopeKey, call.initiativeId, deviceId, at);
    // It could not ring or be heard: the message goes back. Declined or not answered, it stays the call's: nobody says it after he chose not to hear it.
    if (outcome === 'failed') claims.release(scopeKey, call.initiativeId, deviceId);
    return { kind: 'done', status: 'stored' };
  }
}
