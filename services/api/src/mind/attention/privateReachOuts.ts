import type { BodyReachOutDeliveryOutcome } from '../../contracts/bodyContract.js';
import { isDesktopBodyDeviceId } from '../inhibition/bodyIdentityPorts.js';
import { PRIVATE_REACH_OUT_LIMITS, type PrivateReachOutOutcome } from '../../contracts/privateListeningContract.js';
import type { PrivateListener, SQLitePrivateListeningStore } from '../inhibition/inhibitionStorePorts.js';
import type { ClaimedReachOut, ReachOutClaim, SQLiteReachOutClaims, UnreadReachOut } from './store/reachOutClaims.js';
import type { ReachOutReportResult, SQLiteReachOutReports } from './attentionPorts.js';

/**
 * A message she started on her own, spoken through the owner's earphones (owner decision 2026-10-02).
 *
 * Her message is written as before: one assistant message in the Talk and one initiative. What is
 * decided here is only which surface says it aloud, and that exactly one does.
 *
 * The rule: while one of the owner's apps is privately listening and able to speak, that app speaks,
 * and when several are, the one whose device he used most recently. Her body speaks only when no app
 * is. Whoever speaks first takes the message's claim (`reachOutClaims.ts`); nobody else speaks it.
 */
export interface PrivateReachOutsDependencies {
  listening: Pick<SQLitePrivateListeningStore, 'listeners'>;
  claims: SQLiteReachOutClaims;
  reports: Pick<SQLiteReachOutReports, 'report'>;
  /** Whether the device registered as her body (`PUT /v1/body/capabilities`). */
  isBody: (scopeKey: string, deviceId: string) => boolean;
  /** `SHANNON_PRIVATE_LISTENING` and `SHANNON_PRIVATE_LISTENING_REACH_OUTS`. Off, apps are offered nothing and her body is told everything, as before. */
  enabled: boolean;
  /** `SHANNON_AUTONOMY_MAX_FOLLOW_UPS` above zero: whether a delivery is kept for her to observe. */
  reportsEnabled: boolean;
  /** How long the app keeps its microphone open for his answer after speaking. */
  listenSeconds: number;
  now: () => string;
}

export type PrivateReachOutClaim =
  | { kind: 'claimed'; status: 'claimed' | 'held'; surface: 'mac' | 'iphone'; spoken: boolean; message: ClaimedReachOut; listenSeconds: number }
  | { kind: 'disabled' | 'not_found' | 'read' | 'expired' | 'not_listening' | 'not_chosen' | 'answered' | 'taken' };

export type PrivateReachOutReport =
  | { kind: 'done'; status: 'stored' | 'duplicate' | 'ignored' | 'released' }
  | { kind: 'disabled' | 'not_claimed' | 'already_spoken' | 'not_found' | 'expired' | 'conflict' };

/** Among the apps that are privately listening and can speak: the one whose device the owner used most recently. */
export function chosenSpeaker(listeners: readonly PrivateListener[]): PrivateListener | null {
  const able = listeners.filter(listener => listener.speaks);
  return [...able].sort((left, right) => (right.ownerActiveAt ?? '').localeCompare(left.ownerActiveAt ?? '')
    || right.since.localeCompare(left.since) || left.deviceId.localeCompare(right.deviceId))[0] ?? null;
}

export class PrivateReachOuts {
  constructor(private readonly dependencies: PrivateReachOutsDependencies) {}

  get enabled(): boolean { return this.dependencies.enabled; }

  /**
   * The app that speaks now, or null when no app is privately listening and able to speak. For one message, an app
   * that already gave that message back is left out: it does not get it again, and it does not keep it from the others.
   */
  speaker(scopeKey: string, at: string, initiativeId?: string): PrivateListener | null {
    if (!this.dependencies.enabled) return null;
    try {
      const listeners = this.dependencies.listening.listeners(scopeKey, at);
      if (!initiativeId || !listeners.some(listener => listener.speaks)) return chosenSpeaker(listeners);
      const declined = this.dependencies.claims.declinedBy(scopeKey, initiativeId);
      return chosenSpeaker(listeners.filter(listener => !declined.has(listener.deviceId)));
    } catch { return null; }
  }

  /**
   * What a heartbeat of this device is told: the newest of her messages it should speak now, as an identifier.
   * Only for the chosen app, only a fresh, unread message nobody holds, and never once the owner wrote or spoke after it.
   * A message this device took and has not spoken is offered again, so a claim whose answer was lost is not stuck.
   */
  offer(scopeKey: string, deviceId: string, at: string): { id: string; createdAt: string } | null {
    if (!this.dependencies.enabled) return null;
    const { claims } = this.dependencies;
    const newest = claims.unread(scopeKey).find(message => {
      if (!fresh(message.createdAt, at)) return false;
      // A message the server rang his iPhone with is the call's: no heartbeat is offered it, whoever asks.
      if (message.claim) return message.claim.deviceId === deviceId && isApp(message.claim.surface) && message.claim.spokenAt === null;
      return this.speaker(scopeKey, at, message.id)?.deviceId === deviceId;
    });
    if (!newest || claims.ownerActiveAfter(scopeKey, newest.createdAt)) return null;
    return { id: newest.id, createdAt: newest.createdAt };
  }

  /** Takes one message for this device and hands over its words. Every reason not to speak is checked again here. */
  claim(scopeKey: string, deviceId: string, initiativeId: string): PrivateReachOutClaim {
    const { claims, enabled, listenSeconds } = this.dependencies;
    if (!enabled) return { kind: 'disabled' };
    const at = this.dependencies.now();
    const found = claims.message(scopeKey, initiativeId);
    if (!found) return { kind: 'not_found' };
    const { read, ...message } = found;
    const listener = this.dependencies.listening.listeners(scopeKey, at).find(item => item.deviceId === deviceId && item.speaks);
    if (!listener) return { kind: 'not_listening' };
    const held = claims.holder(scopeKey, initiativeId);
    // A repeated request of the device that holds it gets the same answer, so a lost reply can be asked for again.
    if (held?.deviceId === deviceId && isApp(held.surface)) {
      return { kind: 'claimed', status: 'held', surface: held.surface, spoken: held.spokenAt !== null, message, listenSeconds };
    }
    if (held) return { kind: 'taken' };
    if (read) return { kind: 'read' };
    if (!fresh(message.createdAt, at)) return { kind: 'expired' };
    if (this.speaker(scopeKey, at, initiativeId)?.deviceId !== deviceId) return { kind: 'not_chosen' };
    // He already wrote or spoke after it: she does not speak over a conversation.
    if (claims.ownerActiveAfter(scopeKey, message.createdAt)) return { kind: 'answered' };
    const result = claims.claim(scopeKey, initiativeId, deviceId, listener.kind, at);
    if (result === 'taken') return { kind: 'taken' };
    return { kind: 'claimed', status: result, surface: listener.kind, spoken: false, message, listenSeconds };
  }

  /**
   * What the claiming app did. `shown_spoken`: it spoke the message through his earphones; kept in the same
   * report table as her body's, with the surface named. `not_spoken`: private listening had ended, so it said
   * nothing and gives the message back; the text in the Talk and the notification remain.
   */
  report(scopeKey: string, deviceId: string, initiativeId: string, outcome: PrivateReachOutOutcome): PrivateReachOutReport {
    const { claims, reports, enabled, reportsEnabled } = this.dependencies;
    if (!enabled) return { kind: 'disabled' };
    const held = claims.holder(scopeKey, initiativeId);
    // A call's outcome is reported on the call's own route (`incomingCalls.ts`), never here.
    if (!held || held.deviceId !== deviceId || !isApp(held.surface)) return { kind: 'not_claimed' };
    const at = this.dependencies.now();
    if (outcome === 'not_spoken') {
      if (held.spokenAt !== null) return { kind: 'already_spoken' };
      claims.decline(scopeKey, initiativeId, deviceId, at);
      claims.release(scopeKey, initiativeId, deviceId);
      return { kind: 'done', status: 'released' };
    }
    const first = claims.markSpoken(scopeKey, initiativeId, deviceId, at);
    if (!reportsEnabled) return { kind: 'done', status: 'ignored' };
    const result = reports.report(scopeKey, deviceId, initiativeId, 'shown_spoken', at, held.surface);
    if (result === 'stored' || result === 'duplicate') return { kind: 'done', status: first ? result : 'duplicate' };
    return { kind: result };
  }

  /**
   * Whether her body is told about one of her unread messages. A message an app holds is not the body's, unless
   * the app never said what it did with it and the message is long past being spoken. A fresh message nobody holds
   * is not the body's while an app is privately listening; otherwise it becomes the body's here, by the body's own
   * read, so an app that starts listening a moment later does not say it a second time.
   */
  private visibleToBody(scopeKey: string, deviceId: string, message: UnreadReachOut, at: string): boolean {
    const { claims } = this.dependencies;
    if (message.claim) return this.claimLeavesItToBody(message.claim, at);
    if (!fresh(message.createdAt, at)) return true;
    if (this.speaker(scopeKey, at, message.id)) return false;
    return claims.claim(scopeKey, message.id, deviceId, 'body', at) !== 'taken' || claims.holder(scopeKey, message.id)?.surface === 'body';
  }

  /** A message her body holds is the body's. One an app holds is not, unless the app took it long ago and never said it spoke. */
  private claimLeavesItToBody(claim: ReachOutClaim, at: string): boolean {
    if (claim.surface === 'body') return true;
    // A call he declined or did not answer stays the call's: nobody shows or says it after he chose not to hear it.
    if (claim.surface === 'iphone_call') return false;
    return claim.spokenAt === null && Date.parse(at) - Date.parse(claim.claimedAt) > PRIVATE_REACH_OUT_LIMITS.abandonedMilliseconds;
  }

  /** A desktop-body identity (`desktopBodyIdentity.ts`) without its registration as her full body. */
  private unregisteredDesktopBody(scopeKey: string, deviceId: string): boolean {
    return isDesktopBodyDeviceId(deviceId) && !this.safeIsBody(scopeKey, deviceId);
  }

  /** Her unread messages, newest first, each with whether her body is told about it. */
  private forBody(scopeKey: string, deviceId: string, at: string): Array<{ message: UnreadReachOut; visible: boolean }> {
    return this.dependencies.claims.unread(scopeKey).map(message => ({ message, visible: this.visibleToBody(scopeKey, deviceId, message, at) }));
  }

  /** `presence.reachOut` for one device: unchanged for a device that is not her body, and while the mechanism is off. */
  bodyPresence(scopeKey: string, deviceId: string, unchanged: { pending: number; latestId?: string }): { pending: number; latestId?: string } {
    if (this.unregisteredDesktopBody(scopeKey, deviceId)) return { pending: 0 };
    if (!this.dependencies.enabled || !this.safeIsBody(scopeKey, deviceId)) return unchanged;
    try {
      const visible = this.forBody(scopeKey, deviceId, this.dependencies.now()).filter(item => item.visible);
      return visible.length ? { pending: visible.length, latestId: visible[0]!.message.id } : { pending: 0 };
    } catch { return unchanged; }
  }

  /** `GET /v1/initiatives` for one device: her body does not receive a message of hers that is an app's to speak. */
  bodyInitiatives(scopeKey: string, deviceId: string, body: unknown): unknown {
    // An app's desktop body that has not registered yet is neither an app nor a body here: it is told of no message of
    // hers (never the app's unfiltered inbox) and claims nothing, whether or not the mechanism is on.
    if (this.unregisteredDesktopBody(scopeKey, deviceId)) {
      if (!isInbox(body)) return body;
      const messages = body.messages.filter(message => message.kind !== 'reach_out');
      return { ...body, unreadCount: messages.length, messages };
    }
    if (!this.dependencies.enabled || !this.safeIsBody(scopeKey, deviceId) || !isInbox(body)) return body;
    try {
      const at = this.dependencies.now();
      const known = new Map(this.forBody(scopeKey, deviceId, at).map(item => [item.message.id, item.visible]));
      // Only what is an app's is taken out; any other initiative is left as it was. A message of hers that is older
      // than the newest twenty is judged by who holds it.
      const messages = body.messages.filter(message => {
        if (message.kind !== 'reach_out') return true;
        const id = String(message.id);
        const visible = known.get(id);
        if (visible !== undefined) return visible;
        const claim = this.dependencies.claims.holder(scopeKey, id);
        return !claim || this.claimLeavesItToBody(claim, at);
      });
      return { ...body, unreadCount: messages.length, messages };
    } catch { return body; }
  }

  /**
   * Her body's own delivery report, stored as before. A body that did not show the message (the owner away,
   * her window hidden, 「話しかける」 off) gives back the claim it holds itself, so an app in his ears may still say it.
   * A report of one body never touches what another body holds.
   */
  bodyReported(scopeKey: string, deviceId: string, initiativeId: string, outcome: BodyReachOutDeliveryOutcome, at: string): ReachOutReportResult {
    const { reports, claims, enabled } = this.dependencies;
    const result = reports.report(scopeKey, deviceId, initiativeId, outcome, at);
    if (!enabled || result !== 'stored' || !NOT_SHOWN.includes(outcome)) return result;
    try {
      if (claims.holder(scopeKey, initiativeId)?.surface === 'body') claims.release(scopeKey, initiativeId, deviceId);
    } catch { /* the report is stored either way */ }
    return result;
  }

  private safeIsBody(scopeKey: string, deviceId: string): boolean {
    try { return this.dependencies.isBody(scopeKey, deviceId); } catch { return false; }
  }
}

/** One of the owner's apps saying it through his earphones: not her body, and not a call the server placed. */
function isApp(surface: ReachOutClaim['surface']): surface is 'mac' | 'iphone' {
  return surface === 'mac' || surface === 'iphone';
}

/** What a body reports when it did not show her message. */
const NOT_SHOWN: readonly BodyReachOutDeliveryOutcome[] = ['away', 'hidden', 'muted'];

/** A message is spoken only while it is this recent; an older one stays text. */
function fresh(createdAt: string, at: string): boolean {
  const age = Date.parse(at) - Date.parse(createdAt);
  return age >= -PRIVATE_REACH_OUT_LIMITS.futureSkewMilliseconds && age <= PRIVATE_REACH_OUT_LIMITS.freshMilliseconds;
}

function isInbox(value: unknown): value is { unreadCount: number; messages: Array<Record<string, unknown>> } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { messages?: unknown }).messages);
}
