import { DatabaseSync } from 'node:sqlite';

/**
 * Whether the owner is in a voice call with her on one of his apps, seen from another device (owner decision
 * 2026-10-05, after the desktop body's wake listener heard the owner's own 「シャノン」 and then transcribed her
 * iPhone voice as his turns).
 *
 * For each device:
 * - **A device that reports its calls** (a `callStarted` or `callEnded` body event in the last two hours; the iPhone
 *   app from the build that has `ShannonVoiceCallPresence`) is in a call from its `callStarted` to its `callEnded`, ordered by the device's own clock.
 *   A `callStarted` without its end stops counting `reportedCallMaximumMilliseconds` after it, or once the server
 *   has seen nothing of the device's voice for `reportedCallQuietMilliseconds` (the app was killed mid-call). After a
 *   `callEnded`, only a voice session the server noted after it arrived (server clock) counts, until the device's
 *   next `callStarted` arrives.
 * - **Any other device** is in a call while the server sees its voice conversation: a session created
 *   (`POST /v1/voice/gemini/cascade/sessions`), a turn delegated (`…/delegations`, `…/delegations/stream`), or one of
 *   her calls it answered (`incoming_calls`, `answered`, from the answer), until `voiceIdleMilliseconds` pass
 *   without any of them. Sessions and turns are held in the API process only: after a restart they start empty.
 *
 * Only the owner's apps count: a device registered as her full body (the desktop) is never "the call elsewhere",
 * so a false wake on the desktop never marks him as in a call. The requesting device is always excluded.
 *
 * A request may be refused (`OWNER_IN_CALL_ELSEWHERE`) only when it comes from her full body, in owner mode,
 * with a known device, while another device is in a call. The apps are never refused, a guest call is never
 * refused, and a request without a device is never refused (fail open).
 */
export type OwnerCallSurface = 'ios' | 'mac';
export interface OwnerCallElsewhere { active: boolean; since?: string; surface?: OwnerCallSurface }

export const OWNER_CALL_LIMITS = Object.freeze({
  /** A `callStarted` without its `callEnded` stops counting after this long. */
  reportedCallMaximumMilliseconds: 2 * 60 * 60_000,
  /** …or once nothing of the device's voice (its `callStarted`, a session, a turn) was seen for this long. */
  reportedCallQuietMilliseconds: 30 * 60_000,
  /** A voice conversation of a device that reports no calls stops counting this long after its last session, turn or answer. */
  voiceIdleMilliseconds: 3 * 60_000,
  /** `pollAfterSeconds` of a presence answer while the owner is in a call elsewhere. */
  pollSeconds: 5,
  /** The future skew an event may have and still be stored (`BODY_LIMITS.eventFutureSkewMilliseconds`). */
  ingestSkewMilliseconds: 5 * 60_000,
  trackedDevices: 256,
});

export const OWNER_IN_CALL_ELSEWHERE = 'OWNER_IN_CALL_ELSEWHERE';
/** The answer to a refused voice request (docs/body-contract.md). The same shape as the server's other errors. */
export const OWNER_IN_CALL_ELSEWHERE_RESPONSE = Object.freeze({
  status: 409, body: Object.freeze({ error: OWNER_IN_CALL_ELSEWHERE, message: 'The owner is in a voice call on another device.' }),
});

/** A reported call event: `occurredAt` on the device's clock, `receivedAt` on the server's. */
export interface OwnerCallEvent { deviceId: string; type: 'callStarted' | 'callEnded'; occurredAt: string; receivedAt: string }

export interface OwnerCallDependencies {
  /** `SHANNON_OWNER_CALL_ELSEWHERE`; unset means on. Off: presence has no field and nothing is refused. */
  enabled?: boolean;
  /** `callStarted` / `callEnded` events of the scope that occurred in `[since, until]`, any order. */
  events: (scopeKey: string, since: string, until: string) => readonly OwnerCallEvent[];
  /** Her calls answered since `since`: the device and when it answered (server clock). Absent: none is read. */
  answered?: (scopeKey: string, since: string) => ReadonlyArray<{ deviceId: string; answeredAt: string }>;
  /** True for a device registered as her full body (`bodyTouchOnly.ts`). */
  isFullBody: (scopeKey: string, deviceId: string) => boolean;
  /** Which of the owner's apps a device is, when the server can tell. */
  surface: (scopeKey: string, deviceId: string) => OwnerCallSurface | undefined;
}

interface VoiceRun { first: number; last: number }
/** What the session route asks (`serverGeminiLiveRoute.ts`): refused, which notes nothing; and created, after a session was made. */
export interface VoiceSessionCalls { refused(scopeKey: string, deviceId: string | undefined, participantMode: unknown): boolean; created(scopeKey: string, deviceId: string): void }

export function voiceSessionCalls(calls: Pick<OwnerCalls, 'refuses' | 'noteVoice'>, now: () => string): VoiceSessionCalls {
  return {
    refused: (scopeKey, deviceId, participantMode) => calls.refuses(scopeKey, deviceId, participantMode, now()),
    created: (scopeKey, deviceId) => calls.noteVoice(scopeKey, deviceId, now(), 'session'),
  };
}

export class OwnerCalls {
  readonly enabled: boolean;
  private readonly runs = new Map<string, VoiceRun>();

  constructor(private readonly dependencies: OwnerCallDependencies) {
    this.enabled = dependencies.enabled ?? true;
  }

  /**
   * A voice session was created (`session`: always the start of a new run) or a turn was delegated (`turn`: it goes
   * on with the device's run, or starts one after an idle gap) from this device.
   */
  noteVoice(scopeKey: string, deviceId: string | undefined, at: string, kind: 'session' | 'turn'): void {
    if (!this.enabled || !deviceId) return;
    const time = Date.parse(at);
    if (!Number.isFinite(time)) return;
    const key = `${scopeKey}\u0000${deviceId}`;
    const run = this.runs.get(key);
    if (kind === 'turn' && run && time - run.last >= 0 && time - run.last <= OWNER_CALL_LIMITS.voiceIdleMilliseconds) { run.last = time; return; }
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

  /** A delegated turn: false when it must be answered `409 OWNER_IN_CALL_ELSEWHERE` (nothing is noted); otherwise it is noted. */
  admitTurn(scopeKey: string, deviceId: string | undefined, participantMode: unknown, at: string): boolean {
    if (this.refuses(scopeKey, deviceId, participantMode, at)) return false;
    this.noteVoice(scopeKey, deviceId, at, 'turn');
    return true;
  }

  /** True when this request must be answered `409 OWNER_IN_CALL_ELSEWHERE`. Notes nothing. Fails open. */
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
    const window = new Date(time - OWNER_CALL_LIMITS.reportedCallMaximumMilliseconds).toISOString();
    const reported = new Map<string, OwnerCallEvent>();
    // An event stamped up to the ingest skew ahead of the server's clock is stored (`BODY_LIMITS`), so it is read too.
    for (const event of this.dependencies.events(scopeKey, window, new Date(time + OWNER_CALL_LIMITS.ingestSkewMilliseconds).toISOString())) {
      const known = reported.get(event.deviceId);
      // The newest event of a device, on its own clock, decides; at the same instant an end wins over a start.
      if (!known || event.occurredAt > known.occurredAt || (event.occurredAt === known.occurredAt && event.type === 'callEnded')) reported.set(event.deviceId, event);
    }
    // What the server saw of each device's voice: its run, and her call it answered, joined when they are one call.
    const seen = new Map<string, VoiceRun>();
    const prefix = `${scopeKey}\u0000`;
    for (const [key, run] of this.runs) if (key.startsWith(prefix) && run.last - time <= 60_000) seen.set(key.slice(prefix.length), { ...run });
    const idleWindow = new Date(time - OWNER_CALL_LIMITS.reportedCallQuietMilliseconds).toISOString();
    for (const answer of this.dependencies.answered?.(scopeKey, idleWindow) ?? []) {
      const answeredAt = Date.parse(answer.answeredAt);
      if (!Number.isFinite(answeredAt) || answeredAt > time + 60_000) continue;
      const run = seen.get(answer.deviceId);
      // Her call he answered begins the voice that follows it; an older run of the device is another call.
      if (run && run.last >= answeredAt) run.first = Math.min(run.first, answeredAt);
      else seen.set(answer.deviceId, { first: answeredAt, last: answeredAt });
    }
    const devices = new Map<string, number>();
    for (const device of new Set([...reported.keys(), ...seen.keys()])) {
      const latest = reported.get(device);
      const run = seen.get(device);
      if (latest?.type === 'callStarted') {
        const quietFrom = Math.max(Date.parse(latest.receivedAt) || 0, run?.last ?? 0);
        const started = Date.parse(latest.occurredAt);
        if (time - quietFrom <= OWNER_CALL_LIMITS.reportedCallQuietMilliseconds) devices.set(device, Number.isFinite(started) ? started : quietFrom);
        continue;
      }
      if (!run || time - run.last > OWNER_CALL_LIMITS.voiceIdleMilliseconds) continue;
      // After its own end, a device that reports calls counts only for a session the server noted later.
      if (latest?.type === 'callEnded' && !(run.first > Date.parse(latest.receivedAt))) continue;
      devices.set(device, run.first);
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
 * What the database says of the owner's devices for a call elsewhere: her calls they answered, and which app a device
 * is: her body's registration (`surface`), else what it reported for private listening (`private_listening.kind`), else
 * a VoIP registration (only the iPhone app has one). Unknown is left out.
 */
export class SQLiteOwnerCallFacts {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 2000;');
  }

  /** Her calls answered since `since`, with the device and the moment of the answer (`ended_at` of an answered call). */
  answered(scopeKey: string, since: string): Array<{ deviceId: string; answeredAt: string }> {
    if (!this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'incoming_calls'`).get()) return [];
    return (this.database.prepare(`
      SELECT device_id, ended_at FROM incoming_calls WHERE scope_key = ? AND state = 'answered' AND ended_at >= ? ORDER BY ended_at DESC LIMIT 8
    `).all(scopeKey, since) as unknown as Array<{ device_id: string; ended_at: string }>).map(row => ({ deviceId: row.device_id, answeredAt: row.ended_at }));
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
