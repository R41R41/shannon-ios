import { switchOn, type SwitchValues } from '@shannon/switches';

/**
 * Device actions (`docs/device-actions-contract.md`): Shannon cannot touch the owner's devices, so a conversation tool writes a
 * durable action to an outbox, the owner's own paired app (iPhone or Mac) takes it, does it with the system's own frameworks,
 * and reports what became of it once. An action is idempotent by its id: a device never runs an id twice, the server never hands
 * a reported id again, and an action nobody took before `expiresAt` is closed as expired.
 */
export const DEVICE_ACTION_SCHEMA_VERSION = 1;
export const DEVICE_ACTIONS_PATH = '/v1/device/actions';
export const DEVICE_MUSIC_PLAYS_PATH = '/v1/device/music/plays';
const RESULT_PATH = /^\/v1\/device\/actions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/result$/u;

export const DEVICE_ACTION_KINDS = Object.freeze([
  'reminder.create', 'timer.start', 'calendar.create_event', 'calendar.update_event', 'calendar.delete_event',
  'music.search', 'music.recent', 'music.play', 'music.control', 'music.playlist_create',
] as const);
export type DeviceActionKind = typeof DEVICE_ACTION_KINDS[number];

/** Kinds that only read: the tool waits for the answer and nothing is queued for later. */
export const DEVICE_READ_KINDS: readonly DeviceActionKind[] = Object.freeze(['music.search', 'music.recent']);
/** Kinds that make sense only now, on a device that is open: never queued for a device that is away. */
export const DEVICE_LIVE_KINDS: readonly DeviceActionKind[] = Object.freeze([
  'music.search', 'music.recent', 'music.play', 'music.control', 'music.playlist_create',
]);

export type DeviceActionStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'denied' | 'expired';
export type DeviceReportedStatus = 'done' | 'failed' | 'denied';
/** `changed`: the event the owner confirmed a change of was changed on the device since (its title or time no longer match). */
export const DEVICE_ACTION_CODES = Object.freeze([
  'unsupported', 'not_authorized', 'not_found', 'invalid', 'past', 'unavailable', 'failed', 'changed',
] as const);
export type DeviceActionCode = typeof DEVICE_ACTION_CODES[number];
export const MUSIC_PLAY_OUTCOMES = Object.freeze(['started', 'skipped', 'finished', 'stopped'] as const);
export type MusicPlayOutcome = typeof MUSIC_PLAY_OUTCOMES[number];

export const DEVICE_ACTION_LIMITS = Object.freeze({
  /** How long a conversation tool waits for the device's answer (the owner's decision: reads time out at about 8 s). */
  waitMilliseconds: 8_000,
  /** A device that polled this recently is connected. */
  connectedSeconds: 25,
  /** How long a device's poll may be held open waiting for an action. */
  longPollSeconds: 15,
  /** At most this many actions are handed in one poll. */
  pollBatch: 5,
  /** The device's result, as JSON, at most this long; anything longer is refused. */
  resultBytes: 8_192,
  /** Open actions of one scope at most (a runaway loop cannot fill the outbox). */
  openPerScope: 20,
  /** What happened in the last hours reaches her next turns with the owner alone. */
  reportHours: 3,
  keepDays: 14,
  /** Polls of one device a minute. */
  pollsPerMinute: 90,
});

/** How long an action waits to be taken, by kind: a read or a song is worth nothing later; a reminder still is. */
export const DEVICE_ACTION_EXPIRY_SECONDS: Readonly<Record<DeviceActionKind, number>> = Object.freeze({
  'reminder.create': 24 * 3_600, 'calendar.create_event': 24 * 3_600, 'timer.start': 10 * 60,
  // A change the owner confirmed is still his wish a few hours later, not the next day.
  'calendar.update_event': 6 * 3_600, 'calendar.delete_event': 6 * 3_600,
  'music.search': 30, 'music.recent': 30, 'music.play': 120, 'music.control': 60, 'music.playlist_create': 120,
});

export interface DeviceActionView {
  id: string;
  kind: DeviceActionKind;
  payload: Readonly<Record<string, unknown>>;
  requestedAt: string;
  expiresAt: string;
}

export interface DeviceActionReport {
  status: DeviceReportedStatus;
  code?: DeviceActionCode;
  result?: Readonly<Record<string, unknown>>;
}

export interface DevicePollState {
  platform: 'ios' | 'macos';
  foreground: boolean;
  inCall: boolean;
  kinds: readonly DeviceActionKind[];
  wait: boolean;
}

export interface MusicPlayReport {
  actionId?: string;
  itemId: string;
  title: string;
  artist?: string;
  outcome: MusicPlayOutcome;
}

/** `SHANNON_DEVICE_ACTIONS` (default on): off, no device tool is offered and the routes answer 403. */
export function deviceActionsEnabled(values: SwitchValues): boolean {
  return switchOn(values, 'SHANNON_DEVICE_ACTIONS');
}

export function deviceActionResultId(path: string): string | null {
  return RESULT_PATH.exec(path)?.[1] ?? null;
}

export function isDeviceActionPath(path: string): boolean {
  return path === DEVICE_ACTIONS_PATH || path === DEVICE_MUSIC_PLAYS_PATH || RESULT_PATH.test(path);
}

export function isDeviceActionKind(value: unknown): value is DeviceActionKind {
  return typeof value === 'string' && (DEVICE_ACTION_KINDS as readonly string[]).includes(value);
}

const flag = (value: string | null) => value === '1' || value === 'true';

/** The query of a poll: who the device is now and what it can do. Unknown kinds are ignored. */
export function validatedPollState(query: URLSearchParams): DevicePollState | string {
  const platform = query.get('platform');
  if (platform !== 'ios' && platform !== 'macos') return 'platform must be ios or macos';
  const kinds = (query.get('kinds') ?? '').split(',').map(kind => kind.trim()).filter(isDeviceActionKind);
  return { platform, foreground: flag(query.get('foreground')), inCall: flag(query.get('call')), kinds: [...new Set(kinds)], wait: flag(query.get('wait')) };
}

/** The body of a result: a closed status, an optional closed code and a small object. A string is the problem. */
export function validatedDeviceReport(body: Readonly<Record<string, unknown>>): DeviceActionReport | string {
  const { status, code, result } = body;
  if (status !== 'done' && status !== 'failed' && status !== 'denied') return 'status must be done, failed or denied';
  if (code !== undefined && !(DEVICE_ACTION_CODES as readonly unknown[]).includes(code)) return 'code is not one of the closed codes';
  if (result !== undefined && (typeof result !== 'object' || result === null || Array.isArray(result))) return 'result must be an object';
  if (result !== undefined && Buffer.byteLength(JSON.stringify(result), 'utf8') > DEVICE_ACTION_LIMITS.resultBytes) return 'result is too large';
  return { status, ...(code ? { code: code as DeviceActionCode } : {}), ...(result ? { result: result as Record<string, unknown> } : {}) };
}

const line = (value: unknown, maximum: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, maximum) : '';

/** One play outcome the device saw (started, skipped, finished, stopped): ids and names only. */
export function validatedMusicPlay(body: Readonly<Record<string, unknown>>): MusicPlayReport | string {
  const outcome = body.outcome;
  if (!(MUSIC_PLAY_OUTCOMES as readonly unknown[]).includes(outcome)) return 'outcome must be started, skipped, finished or stopped';
  const itemId = line(body.itemId, 120), title = line(body.title, 200);
  if (!itemId || !title) return 'itemId and title are required';
  const actionId = typeof body.actionId === 'string' && /^[0-9a-f-]{36}$/u.test(body.actionId) ? body.actionId : undefined;
  const artist = line(body.artist, 200);
  return { itemId, title, outcome: outcome as MusicPlayOutcome, ...(actionId ? { actionId } : {}), ...(artist ? { artist } : {}) };
}
