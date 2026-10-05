import { DatabaseSync } from 'node:sqlite';

/**
 * Whether the owner is in a voice call with her on one of his apps, seen from another device (owner decision
 * 2026-10-05, after the desktop body's wake listener took her iPhone voice for his turns).
 *
 * A device is in a call:
 * - from its `callStarted` body event to its `callEnded`, for at most `reportedCallMaximumMilliseconds` when
 *   `callEnded` never arrives; and
 * - while the server sees its voice conversation: a session started (`POST /v1/voice/gemini/cascade/sessions`) or a
 *   turn delegated (`…/delegations`, `…/delegations/stream`), until `voiceIdleMilliseconds` pass without either,
 *   or its own `callEnded` arrives. The apps report no body event for a call, so this is what tells the server that
 *   the iPhone or the Mac is in one. It is held in the API process only: after a restart it starts empty (fail open).
 *
 * Only the owner's apps count: a device registered as her full body (the desktop) is never "the call elsewhere",
 * so a false wake on the desktop never marks him as in a call. The requesting device is always excluded.
 *
 * A request may be refused (`OWNER_IN_CALL_ELSEWHERE`) only when it comes from her full body, in owner mode,
 * with a known device, while another device is in a call. The apps are never refused, a guest call is never
 * refused, and a request without a device is never refused.
 */
export type OwnerCallSurface = 'ios' | 'mac';
export interface OwnerCallElsewhere { active: boolean; since?: string; surface?: OwnerCallSurface }

export const OWNER_CALL_LIMITS = Object.freeze({
  /** A `callStarted` without its `callEnded` stops counting after this long. */
  reportedCallMaximumMilliseconds: 2 * 60 * 60_000,
  /** A voice conversation the server sees stops counting this long after its last session start or delegation. */
  voiceIdleMilliseconds: 3 * 60_000,
  /** `pollAfterSeconds` of a presence answer while the owner is in a call elsewhere. */
  pollSeconds: 5,
  trackedDevices: 256,
});

export const OWNER_IN_CALL_ELSEWHERE = 'OWNER_IN_CALL_ELSEWHERE';
/** The answer to a refused voice request (docs/body-contract.md). The same shape as the server's other errors. */
export const OWNER_IN_CALL_ELSEWHERE_RESPONSE = Object.freeze({
  status: 409, body: Object.freeze({ error: OWNER_IN_CALL_ELSEWHERE, message: 'The owner is in a voice call on another device.' }),
});

export interface OwnerCallEvent { deviceId: string; type: 'callStarted' | 'callEnded'; occurredAt: string }

export interface OwnerCallDependencies {
  /** `SHANNON_OWNER_CALL_ELSEWHERE`; unset means on. Off: presence has no field and nothing is refused. */
  enabled?: boolean;
  /** `callStarted` / `callEnded` events of the scope that occurred in `[since, until]`, any order. */
  events: (scopeKey: string, since: string, until: string) => readonly OwnerCallEvent[];
  /** True for a device registered as her full body (`bodyTouchOnly.ts`). */
  isFullBody: (scopeKey: string, deviceId: string) => boolean;
  /** Which of the owner's apps a device is, when the server can tell. */
  surface: (scopeKey: string, deviceId: string) => OwnerCallSurface | undefined;
}

interface VoiceRun { first: number; last: number }

export class OwnerCalls {
  readonly enabled: boolean;
  private readonly runs = new Map<string, VoiceRun>();

  constructor(private readonly dependencies: OwnerCallDependencies) {
    this.enabled = dependencies.enabled ?? true;
  }

  /** A voice session started or a turn was delegated from this device, and was not refused. */
  noteVoice(scopeKey: string, deviceId: string | undefined, at: string): void {
    if (!this.enabled || !deviceId) return;
    const time = Date.parse(at);
    if (!Number.isFinite(time)) return;
    const key = `${scopeKey}\u0000${deviceId}`;
    const run = this.runs.get(key);
    if (run && time - run.last >= 0 && time - run.last <= OWNER_CALL_LIMITS.voiceIdleMilliseconds) { run.last = time; return; }
    if (!run && this.runs.size >= OWNER_CALL_LIMITS.trackedDevices) this.runs.clear();
    this.runs.set(key, { first: time, last: time });
  }

  /** For the device that asks: is the owner in a call on another of his apps. Never throws; unknown is not active. */
  elsewhere(scopeKey: string, deviceId: string, at: string): OwnerCallElsewhere {
    try {
      const calls = this.calls(scopeKey, deviceId, at);
      if (!calls.length) return { active: false };
      const first = calls.reduce((earliest, call) => call.since < earliest.since ? call : earliest);
      const surface = this.dependencies.surface(scopeKey, first.deviceId);
      return { active: true, since: new Date(first.since).toISOString(), ...(surface ? { surface } : {}) };
    } catch { return { active: false }; }
  }

  /** False when this voice request must be answered `409 OWNER_IN_CALL_ELSEWHERE` (nothing is noted); otherwise notes it and returns true. */
  admit(scopeKey: string, deviceId: string | undefined, participantMode: unknown, at: string): boolean {
    if (this.refuses(scopeKey, deviceId, participantMode, at)) return false;
    this.noteVoice(scopeKey, deviceId, at);
    return true;
  }

  /** True when this request must be answered `409 OWNER_IN_CALL_ELSEWHERE`. Fails open. */
  refuses(scopeKey: string, deviceId: string | undefined, participantMode: unknown, at: string): boolean {
    if (!this.enabled || !deviceId || participantMode === 'guest') return false;
    try {
      if (!this.dependencies.isFullBody(scopeKey, deviceId)) return false;
      return this.calls(scopeKey, deviceId, at).length > 0;
    } catch { return false; }
  }

  /** The calls of the owner's apps other than `deviceId`, with when each began (epoch milliseconds). */
  private calls(scopeKey: string, deviceId: string, at: string): Array<{ deviceId: string; since: number }> {
    if (!this.enabled) return [];
    const time = Date.parse(at);
    const reported = new Map<string, OwnerCallEvent>();
    const since = new Date(time - OWNER_CALL_LIMITS.reportedCallMaximumMilliseconds).toISOString();
    for (const event of this.dependencies.events(scopeKey, since, at)) {
      const known = reported.get(event.deviceId);
      // The newest event of a device decides; at the same instant an end wins over a start.
      if (!known || event.occurredAt > known.occurredAt || (event.occurredAt === known.occurredAt && event.type === 'callEnded')) reported.set(event.deviceId, event);
    }
    const devices = new Map<string, number>();
    for (const [device, event] of reported) {
      if (event.type === 'callStarted') devices.set(device, Date.parse(event.occurredAt));
    }
    const prefix = `${scopeKey}\u0000`;
    for (const [key, run] of this.runs) {
      if (!key.startsWith(prefix)) continue;
      const device = key.slice(prefix.length);
      if (time - run.last > OWNER_CALL_LIMITS.voiceIdleMilliseconds || run.last - time > 60_000) continue;
      const latest = reported.get(device);
      if (latest?.type === 'callEnded' && Date.parse(latest.occurredAt) >= run.last) continue;
      devices.set(device, Math.min(devices.get(device) ?? run.first, run.first));
    }
    devices.delete(deviceId);
    return [...devices].filter(([device]) => !this.dependencies.isFullBody(scopeKey, device)).map(([device, start]) => ({ deviceId: device, since: start }));
  }
}

/** `SHANNON_OWNER_CALL_ELSEWHERE=off` (also `false`, `0`, `disabled`) switches the field and the refusal off. */
export function ownerCallElsewhereEnabled(environment: Readonly<Record<string, string | undefined>>): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_OWNER_CALL_ELSEWHERE?.trim().toLowerCase() ?? '');
}

/**
 * Which app a device is: her body's registration (`surface`), else what it reported for private listening
 * (`private_listening.kind`), else a VoIP registration (only the iPhone app has one). Unknown is left out.
 */
export class SQLiteDeviceSurfaces {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 2000;');
  }

  surface(scopeKey: string, deviceId: string): OwnerCallSurface | undefined {
    const tables = new Set((this.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('body_capabilities', 'private_listening', 'voip_push_registrations')`).all() as unknown as Array<{ name: string }>).map(row => row.name));
    const of = (value: unknown): OwnerCallSurface | undefined => value === 'iphone' ? 'ios' : value === 'mac' ? 'mac' : undefined;
    if (tables.has('body_capabilities')) {
      const row = this.database.prepare('SELECT surface FROM body_capabilities WHERE scope_key = ? AND device_id = ?').get(scopeKey, deviceId) as { surface?: unknown } | undefined;
      const surface = of(row?.surface);
      if (surface) return surface;
    }
    if (tables.has('private_listening')) {
      const row = this.database.prepare('SELECT kind FROM private_listening WHERE scope_key = ? AND device_id = ?').get(scopeKey, deviceId) as { kind?: unknown } | undefined;
      const surface = of(row?.kind);
      if (surface) return surface;
    }
    if (tables.has('voip_push_registrations')
      && this.database.prepare('SELECT 1 FROM voip_push_registrations WHERE scope_key = ? AND device_id = ?').get(scopeKey, deviceId)) return 'ios';
    return undefined;
  }

  close(): void { this.database.close(); }
}
