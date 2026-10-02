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
  /** When the owner last used that device, as the app saw it. Canonical ISO 8601 (UTC). */
  ownerActiveAt?: string;
}

const REPORT_FIELDS = ['scopeKey', 'kind', 'listening', 'ownerActiveAt'];
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

/** The fields of one report, or why the request is refused. A closed kind, a boolean and a timestamp: nothing else. */
export function validatedPrivateListeningReport(body: Record<string, unknown>): PrivateListeningReport | string {
  const unknown = Object.keys(body).find(key => !REPORT_FIELDS.includes(key));
  if (unknown) return `${unknown.slice(0, 40)} is not allowed`;
  const kind = PRIVATE_LISTENING_KINDS.find(value => value === body.kind);
  if (!kind) return `kind must be one of ${PRIVATE_LISTENING_KINDS.join(', ')}`;
  if (typeof body.listening !== 'boolean') return 'listening must be a boolean';
  if (body.ownerActiveAt === undefined) return { kind, listening: body.listening };
  const time = typeof body.ownerActiveAt === 'string' && body.ownerActiveAt.length <= 40 && ISO_8601.test(body.ownerActiveAt)
    ? Date.parse(body.ownerActiveAt) : Number.NaN;
  if (!Number.isFinite(time)) return 'ownerActiveAt must be an ISO 8601 timestamp';
  return { kind, listening: body.listening, ownerActiveAt: new Date(time).toISOString() };
}

const OFF = ['off', 'false', '0', 'disabled'];

/** `SHANNON_PRIVATE_LISTENING=off` refuses every report and treats nobody as privately listening. Unset means on. */
export function privateListeningEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !OFF.includes(environment.SHANNON_PRIVATE_LISTENING?.trim().toLowerCase() ?? '');
}
