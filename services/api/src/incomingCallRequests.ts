import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AutonomyPhone, PhoneFacts } from './autonomyLoopPhoneStep.js';
import { INCOMING_CALL_LIMITS, incomingCallMinimumIntervalMilliseconds, incomingCallsEnabled } from './incomingCallContract.js';
import type { SQLiteIncomingCallStore } from './incomingCallStore.js';
import { privateReachOutsEnabled } from './privateListeningContract.js';
import type { PrivateListener } from './privateListeningStore.js';
import type { SQLiteReachOutClaims } from './reachOutClaims.js';

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
  store: Pick<SQLiteIncomingCallStore, 'devices' | 'begin' | 'latest' | 'openCalls' | 'outcome' | 'ofMessage'>;
  claims: Pick<SQLiteReachOutClaims, 'claim' | 'release' | 'message' | 'ownerLastActiveAt'>;
  /** The owner's apps that say only he can hear them now. */
  listeners: (scopeKey: string, at: string) => readonly PrivateListener[];
  /** Whether her body read presence a moment ago. */
  bodyVisible: (scopeKey: string, at: string) => boolean;
  /** The server may ring: the switches are on and what APNs needs is configured. */
  serverReady: boolean;
  minimumIntervalMilliseconds: number;
  newCallId?: () => string;
}

export class IncomingCallRequests implements AutonomyPhone {
  constructor(private readonly dependencies: IncomingCallRequestsDependencies) {}

  facts(scopeKey: string, at: string): PhoneFacts {
    const { store, claims } = this.dependencies;
    const latest = store.latest(scopeKey);
    const open = store.openCalls(scopeKey).length > 0;
    const sinceLast = latest ? Date.parse(at) - Date.parse(latest.createdAt) : null;
    const wait = sinceLast === null ? 0 : Math.max(0, this.dependencies.minimumIntervalMilliseconds - sinceLast);
    let listeners: readonly PrivateListener[] = [];
    try { listeners = this.dependencies.listeners(scopeKey, at); } catch { listeners = []; }
    let body = false;
    try { body = this.dependencies.bodyVisible(scopeKey, at); } catch { body = false; }
    return {
      switchedOn: store.devices(scopeKey).length > 0,
      serverReady: this.dependencies.serverReady,
      ringing: open,
      waitMinutes: Math.ceil(wait / 60_000),
      earphones: listeners.length > 0,
      body,
      ownerLastActiveAt: claims.ownerLastActiveAt(scopeKey),
      last: latest ? { at: latest.createdAt, outcome: latest.state === 'pending' || latest.state === 'sending' || latest.state === 'ringing' ? 'ringing' : latest.state } : null,
    };
  }

  /** Asks for the call with one message of hers. `requested`, or why not, as a code. */
  request(scopeKey: string, initiativeId: string, at: string): 'requested' | 'unavailable' | 'too_soon' | 'ringing' | 'taken' {
    const { store, claims } = this.dependencies;
    const facts = this.facts(scopeKey, at);
    if (!facts.switchedOn || !facts.serverReady) return 'unavailable';
    if (facts.ringing) return 'ringing';
    if (facts.waitMinutes > 0) return 'too_soon';
    const device = store.devices(scopeKey)[0];
    const message = claims.message(scopeKey, initiativeId);
    if (!device || !message || store.ofMessage(scopeKey, initiativeId)) return 'unavailable';
    // The claim first: from here no other surface says it. Then the request the API process sends.
    if (claims.claim(scopeKey, initiativeId, device.deviceId, 'iphone_call', at) !== 'claimed') return 'taken';
    const callId = (this.dependencies.newCallId ?? randomUUID)();
    // The ring's end is set when the push leaves; until then the row carries the latest moment it may still be sent.
    const expiresAt = new Date(Date.parse(at) + INCOMING_CALL_LIMITS.pendingMilliseconds + INCOMING_CALL_LIMITS.ringSeconds * 1_000).toISOString();
    if (!store.begin(scopeKey, { callId, initiativeId, deviceId: device.deviceId, threadId: message.threadId, expiresAt }, at)) {
      claims.release(scopeKey, initiativeId, device.deviceId);
      return 'unavailable';
    }
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
export function incomingCallsConfigured(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (!incomingCallsEnabled(environment) || !privateReachOutsEnabled(environment)) return false;
  const keyFile = environment.SHANNON_APNS_PRIVATE_KEY_FILE?.trim();
  return Boolean(environment.SHANNON_APNS_KEY_ID?.trim() && environment.SHANNON_APNS_TEAM_ID?.trim() && keyFile && existsSync(keyFile));
}

export { incomingCallMinimumIntervalMilliseconds };
