import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AutonomyPhone, PhoneFacts } from '../../mind/action/ownTime/autonomyLoopPhoneStep.js';
import { INCOMING_CALL_LIMITS, incomingCallMinimumIntervalMilliseconds, incomingCallsEnabled } from '../../contracts/incomingCallContract.js';
import type { SQLiteIncomingCallStore } from './store/incomingCallStore.js';
import { privateReachOutsEnabled } from '../../contracts/privateListeningContract.js';
import type { PrivateListener } from '../body/store/privateListeningStore.js';
import type { SQLiteReachOutClaims } from '../../mind/attention/attentionPorts.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import type { ProactiveDeliveryGate, ProactiveDeliveryIntent, ProactiveDeliveryHold, ProactiveReason } from '../../mind/attention/attentionPorts.js';

/**
 * Her loop's side of a call (`autonomyLoopPhoneStep.ts`): the facts she chooses with, and asking for the call.
 *
 * Her process sends no push and reads no key for Apple's push service: it writes one `pending` row, and the API
 * process rings (`incomingCalls.ts`). Asking takes the message's claim as `iphone_call` in the same breath, so an app
 * in his ears or her body cannot say the message she chose to phone with.
 *
 * Everything read here is a yes or no, a closed state or a timestamp: never a word of his, never a device name.
 */
export interface IncomingCallRequestsDependencies {
  store: Pick<SQLiteIncomingCallStore, 'devices' | 'begin' | 'end' | 'latest' | 'openCalls' | 'outcome' | 'ofMessage' | 'serverAvailable'>;
  claims: Pick<SQLiteReachOutClaims, 'claim' | 'release' | 'message' | 'ownerLastActiveAt'>;
  /** The owner's apps that say only he can hear them now. */
  listeners: (scopeKey: string, at: string) => readonly PrivateListener[];
  /** Whether her body read presence a moment ago. */
  bodyVisible: (scopeKey: string, at: string) => boolean;
  /** The server may ring: the switches are on and what APNs needs is configured. */
  serverReady: boolean;
  minimumIntervalMilliseconds: number;
  newCallId?: () => string;
  /** Syzygy ADR-0008 stage 3: the proactive gate the call passes before anything rings; absent (switched off), as before. */
  gate?: ProactiveDeliveryGate | null;
}

export class IncomingCallRequests implements AutonomyPhone {
  constructor(private readonly dependencies: IncomingCallRequestsDependencies) {}

  facts(scopeKey: string, at: string): PhoneFacts {
    const { store, claims } = this.dependencies;
    const latest = store.latest(scopeKey);
    const open = store.openCalls(scopeKey).length > 0;
    const sinceLast = latest ? Date.parse(at) - Date.parse(latest.createdAt) : null;
    // After a call he answered, the conversation that followed is not rung into, whether or not he has spoken in it yet.
    const interval = latest?.state === 'answered' ? Math.max(this.dependencies.minimumIntervalMilliseconds, INCOMING_CALL_LIMITS.conversationQuietMilliseconds)
      : this.dependencies.minimumIntervalMilliseconds;
    const wait = sinceLast === null ? 0 : Math.max(0, interval - sinceLast);
    // What the API process, which holds the key and rings, last said about itself; until it has said anything, the environment decides.
    let apiReady: boolean | null = null;
    try { apiReady = store.serverAvailable(); } catch { apiReady = null; }
    let listeners: readonly PrivateListener[] = [];
    try { listeners = this.dependencies.listeners(scopeKey, at); } catch { listeners = []; }
    let body = false;
    try { body = this.dependencies.bodyVisible(scopeKey, at); } catch { body = false; }
    return {
      switchedOn: store.devices(scopeKey).length > 0,
      serverReady: this.dependencies.serverReady && apiReady !== false,
      ringing: open,
      waitMinutes: Math.ceil(wait / 60_000),
      // Only an app that would say a message of hers aloud: the line she is shown says a message would be heard.
      earphones: listeners.some(listener => listener.speaks),
      body,
      ownerLastActiveAt: claims.ownerLastActiveAt(scopeKey),
      last: latest ? { at: latest.createdAt, outcome: latest.state === 'pending' || latest.state === 'sending' || latest.state === 'ringing' ? 'ringing' : latest.state } : null,
    };
  }

  /** Asks for the call with one message of hers. `requested`, or why not, as a code. */
  request(scopeKey: string, initiativeId: string, at: string): 'requested' | 'unavailable' | 'too_soon' | 'ringing' | 'taken' | `held:${ProactiveDeliveryHold}` {
    const { store, claims } = this.dependencies;
    const facts = this.facts(scopeKey, at);
    if (!facts.switchedOn || !facts.serverReady) return 'unavailable';
    if (facts.ringing) return 'ringing';
    if (facts.waitMinutes > 0) return 'too_soon';
    const device = store.devices(scopeKey)[0];
    const message = claims.message(scopeKey, initiativeId);
    if (!device || !message || store.ofMessage(scopeKey, initiativeId)) return 'unavailable';
    // Syzygy ADR-0008 stage 3: the proactive gate, before the claim and before anything rings. Her line was checked for its topic
    // where it was written; the call is checked for the owner's activity, its message's age and a repeat of the same call.
    const intent: ProactiveDeliveryIntent = { point: 'call', reason: message.reason as ProactiveReason, subject: initiativeId, arisenAt: message.createdAt, text: null };
    const verdict = this.dependencies.gate?.check(scopeKey, intent, at);
    if (verdict?.verdict === 'hold') return `held:${verdict.code}`;
    const callId = (this.dependencies.newCallId ?? randomUUID)();
    // The ring's end is set when the push leaves; until then the row carries the latest moment it may still be sent.
    const expiresAt = new Date(Date.parse(at) + INCOMING_CALL_LIMITS.pendingMilliseconds + INCOMING_CALL_LIMITS.ringSeconds * 1_000).toISOString();
    const row = { callId, initiativeId, deviceId: device.deviceId, threadId: message.threadId, expiresAt };
    // The claim first: from here no other surface says it. Then the request the API process sends.
    if (claims.claim(scopeKey, initiativeId, device.deviceId, 'iphone_call', at) !== 'claimed') {
      // Another surface took her line in the instant after it was written. The attempt is kept as a call that could not
      // connect, so the interval counts from it and the message is never rung with later.
      try { if (store.begin(scopeKey, row, at)) store.end(callId, ['pending'], 'failed', 'server', at, { reason: 'taken' }); } catch { /* nothing rings either way */ }
      return 'taken';
    }
    let begun = false;
    try { begun = store.begin(scopeKey, row, at); } catch { begun = false; }
    if (!begun) {
      claims.release(scopeKey, initiativeId, device.deviceId);
      return 'unavailable';
    }
    this.dependencies.gate?.delivered(scopeKey, intent, at);
    return 'requested';
  }

  outcome(scopeKey: string, initiativeId: string) {
    return this.dependencies.store.outcome(scopeKey, initiativeId);
  }
}

/**
 * Whether the server may ring, as far as the environment says: the kill switch, the claim mechanism, and the three
 * values APNs needs with a key file that exists. The key is not read here; the API process reads it.
 */
export function incomingCallsConfigured(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): boolean {
  if (!incomingCallsEnabled(environment) || !privateReachOutsEnabled(environment)) return false;
  const keyFile = environment.SHANNON_APNS_PRIVATE_KEY_FILE?.trim();
  return Boolean(environment.SHANNON_APNS_KEY_ID?.trim() && environment.SHANNON_APNS_TEAM_ID?.trim() && keyFile && existsSync(keyFile));
}

export { incomingCallMinimumIntervalMilliseconds };
