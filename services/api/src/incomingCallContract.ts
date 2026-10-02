/**
 * The wire contract of a call from Shannon (`docs/incoming-call-contract.md`, owner decision 2026-10-03).
 *
 * When she starts a message on her own and no surface can simply say it, the server rings the owner's
 * iPhone: one VoIP push, which the app shows as an incoming call through CallKit. The push carries
 * identifiers and a time, never her words; the app fetches them after he answered.
 *
 * Everything here is a closed vocabulary, identifiers and timestamps.
 */
export const INCOMING_CALL_SCHEMA_VERSION = 1;
export const INCOMING_CALL_PATH = '/v1/incoming-calls';
export const INCOMING_CALL_REGISTRATION_PATH = `${INCOMING_CALL_PATH}/registration`;

export const INCOMING_CALL_LIMITS = Object.freeze({
  /** How long the iPhone rings. */
  ringSeconds: 30,
  /** A ringing call nobody reported on is counted as not answered this long after its ring ended. */
  reportGraceMilliseconds: 15_000,
  /** A call row whose push was never confirmed (the process stopped in between) is closed after this long, and never sent again. */
  pendingMilliseconds: 10_000,
  /** While her body read presence a moment ago and has not taken the message yet, the call waits this long for it. */
  bodyGraceMilliseconds: 20_000,
  /** An owner turn this recent is a conversation in progress: nobody is rung into one. Her own step uses the same span. */
  conversationQuietMilliseconds: 10 * 60_000,
  /** How often the server looks for a message to ring with. */
  tickMilliseconds: 2_000,
  /** One device may send this many requests a minute. */
  requestsPerMinute: 30,
  /** Closed calls are kept this long. */
  retentionMilliseconds: 30 * 24 * 60 * 60_000,
});

/** What became of one call. `ringing` is the only open state after the push left; `pending` is before it. */
export const INCOMING_CALL_OUTCOMES = ['answered', 'declined', 'unanswered', 'failed'] as const;
export type IncomingCallOutcome = typeof INCOMING_CALL_OUTCOMES[number];
export type IncomingCallState = 'pending' | 'ringing' | IncomingCallOutcome;

export type VoipEnvironment = 'sandbox' | 'production';

export interface IncomingCallRegistration {
  deviceToken: string;
  environment: VoipEnvironment;
  /** The app's bundle identifier; the push topic is `<bundle id>.voip`. */
  bundleId: string;
  /** The owner's switch 「シャノンからの着信を受ける」. Off, the token is kept and nothing is rung. */
  enabled: boolean;
}

const REGISTRATION_FIELDS = ['scopeKey', 'deviceToken', 'environment', 'bundleId', 'enabled'];
const DEVICE_TOKEN = /^[a-f0-9]{64,200}$/u;
const BUNDLE_ID = /^[A-Za-z0-9.-]{3,150}$/u;
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The fields of one registration, or why it is refused. */
export function validatedIncomingCallRegistration(body: Record<string, unknown>): IncomingCallRegistration | string {
  const unknown = Object.keys(body).find(key => !REGISTRATION_FIELDS.includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const deviceToken = typeof body.deviceToken === 'string' ? body.deviceToken.trim().toLowerCase() : '';
  if (!DEVICE_TOKEN.test(deviceToken)) return 'deviceToken must be a hexadecimal push token';
  if (body.environment !== 'sandbox' && body.environment !== 'production') return 'environment must be sandbox or production';
  if (typeof body.bundleId !== 'string' || !BUNDLE_ID.test(body.bundleId) || body.bundleId.endsWith('.voip')) return 'bundleId must be the app\'s bundle identifier';
  if (typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
  return { deviceToken, environment: body.environment, bundleId: body.bundleId, enabled: body.enabled };
}

/** The call id of `/v1/incoming-calls/{callId}/report`, or null. */
export function incomingCallReportRoute(path: string): string | null {
  const match = /^\/v1\/incoming-calls\/([^/]+)\/report$/u.exec(path);
  return match && CALL_ID.test(match[1]!) ? match[1]! : null;
}

export function validCallId(value: unknown): value is string {
  return typeof value === 'string' && CALL_ID.test(value);
}

/** The one field of a report besides `scopeKey`, or why it is refused. There is no text field. */
export function validatedIncomingCallReport(body: Record<string, unknown>): { outcome: IncomingCallOutcome } | string {
  const unknown = Object.keys(body).find(key => key !== 'scopeKey' && key !== 'outcome');
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const outcome = INCOMING_CALL_OUTCOMES.find(value => value === body.outcome);
  return outcome ? { outcome } : `outcome must be one of ${INCOMING_CALL_OUTCOMES.join(', ')}`;
}

/** What the push carries, and all it carries: identifiers and a time. Her words are never in it. */
export interface IncomingCallPayload { callId: string; reachOutId: string; threadId: string; expiresAt: string }

export function incomingCallPushBody(payload: IncomingCallPayload): string {
  return JSON.stringify({
    aps: {}, shannonCall: INCOMING_CALL_SCHEMA_VERSION,
    callId: payload.callId, reachOutId: payload.reachOutId, threadId: payload.threadId, expiresAt: payload.expiresAt,
  });
}

const OFF = ['off', 'false', '0', 'disabled'];

/** `SHANNON_INCOMING_CALLS=off` is the kill switch: nothing is rung, and the app's settings are told so. Unset means on. */
export function incomingCallsEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !OFF.includes(environment.SHANNON_INCOMING_CALLS?.trim().toLowerCase() ?? '');
}
