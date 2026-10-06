/**
 * The wire contract of private listening (`docs/private-listening-contract.md`, owner decision 2026-10-02).
 *
 * "Privately listening" means: the sound of one of the owner's own apps comes out of a device he
 * registered as earphones on that device, or out of wired headphones, so only he can hear it. The app
 * decides this from its audio route and its own registry; the server is told a kind, a yes or no and
 * a timestamp. No device name, no identifier of the earphones and no free text reaches the server.
 *
 * The state is a heartbeat: it holds while the app keeps reporting and lapses by itself.
 */
export const PRIVATE_LISTENING_SCHEMA_VERSION = 1;
export const PRIVATE_LISTENING_PATH = '/v1/private-listening';

export const PRIVATE_LISTENING_KINDS = ['mac', 'iphone'] as const;
export type PrivateListeningKind = typeof PRIVATE_LISTENING_KINDS[number];

export const PRIVATE_LISTENING_LIMITS = Object.freeze({
  /** How often an app reports while it is privately listening. */
  pollSeconds: 15,
  /** A report older than this no longer counts: three missed reports. */
  freshMilliseconds: 45_000,
  /** Clock skew allowed for `ownerActiveAt`; anything later is taken as the server's now. */
  futureSkewMilliseconds: 5 * 60_000,
  /** Rows not reported for this long are removed. */
  retentionMilliseconds: 24 * 60 * 60_000,
  /** One device may send this many requests a minute. */
  requestsPerMinute: 60,
});

export interface PrivateListeningReport {
  kind: PrivateListeningKind;
  listening: boolean;
  /** The app would say a message of hers aloud now: the owner switched that on, and on an iPhone the app can run. */
  speaks: boolean;
  /** When the owner last used that device, as the app saw it. Canonical ISO 8601 (UTC). */
  ownerActiveAt?: string;
}

const REPORT_FIELDS = ['scopeKey', 'kind', 'listening', 'speaks', 'ownerActiveAt'];
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

/** The fields of one report, or why the request is refused. A closed kind, a boolean and a timestamp: nothing else. */
export function validatedPrivateListeningReport(body: Record<string, unknown>): PrivateListeningReport | string {
  const unknown = Object.keys(body).find(key => !REPORT_FIELDS.includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const kind = PRIVATE_LISTENING_KINDS.find(value => value === body.kind);
  if (!kind) return `kind must be one of ${PRIVATE_LISTENING_KINDS.join(', ')}`;
  if (typeof body.listening !== 'boolean') return 'listening must be a boolean';
  if (body.speaks !== undefined && typeof body.speaks !== 'boolean') return 'speaks must be a boolean';
  const speaks = body.listening && body.speaks === true;
  if (body.ownerActiveAt === undefined) return { kind, listening: body.listening, speaks };
  const time = typeof body.ownerActiveAt === 'string' && body.ownerActiveAt.length <= 40 && ISO_8601.test(body.ownerActiveAt)
    ? Date.parse(body.ownerActiveAt) : Number.NaN;
  if (!Number.isFinite(time)) return 'ownerActiveAt must be an ISO 8601 timestamp';
  return { kind, listening: body.listening, speaks, ownerActiveAt: new Date(time).toISOString() };
}

/**
 * A message she started on her own, spoken by one of the owner's apps through his earphones
 * (`privateReachOuts.ts`). `shown_spoken` is the body contract's own word for "shown and said aloud";
 * `not_spoken` gives the message back because private listening had ended.
 */
export const PRIVATE_REACH_OUT_PREFIX = `${PRIVATE_LISTENING_PATH}/reach-outs/`;
export const PRIVATE_REACH_OUT_OUTCOMES = ['shown_spoken', 'not_spoken'] as const;
export type PrivateReachOutOutcome = typeof PRIVATE_REACH_OUT_OUTCOMES[number];

export const PRIVATE_REACH_OUT_LIMITS = Object.freeze({
  /** A message is spoken only this soon after she wrote it; later it stays text. Her own wait for an answer is three minutes. */
  freshMilliseconds: 3 * 60_000,
  /**
   * An app that took a message and never said what it did with it (it was closed) no longer keeps the message from her body
   * this long after its claim. The app gives up a line whose sound has not begun within 30 seconds and stops any line after
   * two minutes, and it sends a report that did not arrive again with every heartbeat, so by then nothing is still being said.
   */
  abandonedMilliseconds: 5 * 60_000,
  futureSkewMilliseconds: 60_000,
  /** How long the app keeps its microphone open for his answer, unless `SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS` says otherwise. */
  listenSeconds: 8,
  maximumListenSeconds: 30,
});

const REACH_OUT_ID = /^[A-Za-z0-9-]{1,80}$/u;

/** The initiative id and the action of `/v1/private-listening/reach-outs/{id}/claim|delivery`, or null. */
export function privateReachOutRoute(path: string): { id: string; action: 'claim' | 'delivery' } | null {
  const match = /^\/v1\/private-listening\/reach-outs\/([^/]+)\/(claim|delivery)$/u.exec(path);
  return match && REACH_OUT_ID.test(match[1]!) ? { id: match[1]!, action: match[2] as 'claim' | 'delivery' } : null;
}

/** The one field of a delivery report besides `scopeKey`, or why the request is refused. There is no text field. */
export function validatedPrivateReachOutReport(body: Record<string, unknown>): { outcome: PrivateReachOutOutcome } | string {
  const unknown = Object.keys(body).find(key => key !== 'scopeKey' && key !== 'outcome');
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const outcome = PRIVATE_REACH_OUT_OUTCOMES.find(value => value === body.outcome);
  return outcome ? { outcome } : `outcome must be one of ${PRIVATE_REACH_OUT_OUTCOMES.join(', ')}`;
}

const OFF = ['off', 'false', '0', 'disabled'];

/** `SHANNON_PRIVATE_LISTENING=off` refuses every report and treats nobody as privately listening. Unset means on. */
export function privateListeningEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !OFF.includes(environment.SHANNON_PRIVATE_LISTENING?.trim().toLowerCase() ?? '');
}

/**
 * `SHANNON_PRIVATE_LISTENING_REACH_OUTS=off` keeps the state and stops the speaking: no app is offered a message,
 * a claim is refused, and her body is told about every message as before. `SHANNON_PRIVATE_LISTENING=off` does the same.
 */
export function privateReachOutsEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return privateListeningEnabled(environment) && !OFF.includes(environment.SHANNON_PRIVATE_LISTENING_REACH_OUTS?.trim().toLowerCase() ?? '');
}

/** `SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS` (0–30, default 8). Zero: the app speaks and does not listen. */
export function privateReachOutListenSeconds(environment: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(environment.SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS?.trim() || Number.NaN);
  return Number.isInteger(value) && value >= 0 && value <= PRIVATE_REACH_OUT_LIMITS.maximumListenSeconds ? value : PRIVATE_REACH_OUT_LIMITS.listenSeconds;
}
