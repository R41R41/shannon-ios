import { DatabaseSync } from 'node:sqlite';
import {
  INCOMING_CALL_LIMITS, INCOMING_CALL_OUTCOMES, type IncomingCallOutcome, type IncomingCallRegistration, type IncomingCallState, type VoipEnvironment,
} from './contracts/incomingCallContract.js';
import { secureDatabaseFiles } from './infra/sqlite/sqliteStoreContext.js';

/**
 * The VoIP push tokens of the owner's iPhones, and the calls the server placed (`incomingCallContract.ts`).
 *
 * A token is kept apart from the ordinary notification token (`push_registrations`): another token, another
 * topic. A call is one row per message she started, so a message is rung with at most once, also across a
 * restart. Neither table has a column for words.
 */
export interface VoipDevice { deviceId: string; deviceToken: string; environment: VoipEnvironment; bundleId: string; enabled: boolean; updatedAt: string }

export interface IncomingCall {
  callId: string;
  initiativeId: string;
  deviceId: string;
  threadId: string;
  state: IncomingCallState;
  createdAt: string;
  /** When the iPhone stops ringing. */
  expiresAt: string;
  /** Who closed it: the app's own report, or the server (a push that failed, a ring nobody reported on). */
  decidedBy: 'app' | 'server' | null;
}

interface CallRow {
  call_id: string; initiative_id: string; device_id: string; thread_id: string; state: string; created_at: string; expires_at: string; decided_by: string | null;
}

const STATES: readonly IncomingCallState[] = ['pending', 'sending', 'ringing', ...INCOMING_CALL_OUTCOMES];

export class SQLiteIncomingCallStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS voip_push_registrations (
        device_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        device_token TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
        bundle_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        invalidated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS voip_push_registrations_scope ON voip_push_registrations (scope_key, invalidated_at);

      CREATE TABLE IF NOT EXISTS incoming_calls (
        call_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        initiative_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        pushed_at TEXT,
        ended_at TEXT,
        decided_by TEXT,
        apns_status INTEGER,
        reason TEXT,
        UNIQUE (scope_key, initiative_id)
      );
      CREATE INDEX IF NOT EXISTS incoming_calls_open ON incoming_calls (state, expires_at);

      CREATE TABLE IF NOT EXISTS incoming_call_server (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        available INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    secureDatabaseFiles(path);
  }

  /** Stores the token of one paired device, with the owner's switch. A token another device held moves to this one. */
  register(scopeKey: string, deviceId: string, registration: IncomingCallRegistration, at: string): VoipDevice {
    this.database.prepare('DELETE FROM voip_push_registrations WHERE device_token = ? AND device_id <> ?').run(registration.deviceToken, deviceId);
    this.database.prepare(`
      INSERT INTO voip_push_registrations (device_id, scope_key, device_token, environment, bundle_id, enabled, updated_at, invalidated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (device_id) DO UPDATE SET scope_key = excluded.scope_key, device_token = excluded.device_token, environment = excluded.environment,
        bundle_id = excluded.bundle_id, enabled = excluded.enabled, updated_at = excluded.updated_at, invalidated_at = NULL
    `).run(deviceId, scopeKey, registration.deviceToken, registration.environment, registration.bundleId, registration.enabled ? 1 : 0, at);
    return { deviceId, ...registration, updatedAt: at };
  }

  /** The device was unpaired, or APNs said its token is gone: it is never rung again until it registers anew. */
  invalidateDevice(deviceId: string, at: string): void {
    this.database.prepare('UPDATE voip_push_registrations SET invalidated_at = ?, enabled = 0 WHERE device_id = ? AND invalidated_at IS NULL').run(at, deviceId);
  }

  /** The owner's iPhones that may be rung now, the one registered last first. */
  devices(scopeKey: string): readonly VoipDevice[] {
    const rows = this.database.prepare(`
      SELECT device_id, device_token, environment, bundle_id, enabled, updated_at FROM voip_push_registrations
      WHERE scope_key = ? AND invalidated_at IS NULL AND enabled = 1 ORDER BY updated_at DESC, device_id
    `).all(scopeKey) as unknown as Array<{ device_id: string; device_token: string; environment: string; bundle_id: string; enabled: number; updated_at: string }>;
    return rows.map(row => ({
      deviceId: row.device_id, deviceToken: row.device_token, environment: row.environment === 'sandbox' ? 'sandbox' : 'production',
      bundleId: row.bundle_id, enabled: Number(row.enabled) === 1, updatedAt: row.updated_at,
    }));
  }

  /**
   * Opens the one call of a message, before anything is sent. False when the message already has a call,
   * whatever became of it: a message is rung with at most once.
   */
  begin(scopeKey: string, call: { callId: string; initiativeId: string; deviceId: string; threadId: string; expiresAt: string }, at: string): boolean {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO incoming_calls (call_id, scope_key, initiative_id, device_id, thread_id, state, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(call.callId, scopeKey, call.initiativeId, call.deviceId, call.threadId, at, call.expiresAt);
    this.database.prepare('DELETE FROM incoming_calls WHERE created_at < ? AND state NOT IN (\'pending\', \'sending\', \'ringing\')')
      .run(new Date(Date.parse(at) - INCOMING_CALL_LIMITS.retentionMilliseconds).toISOString());
    return Number(inserted.changes) > 0;
  }

  /** The API takes a call she asked for, to send it: only one process can, and only once. The ring ends at `expiresAt`. */
  take(callId: string, expiresAt: string): boolean {
    return Number(this.database.prepare(`
      UPDATE incoming_calls SET state = 'sending', expires_at = ? WHERE call_id = ? AND state = 'pending'
    `).run(expiresAt, callId).changes) > 0;
  }

  /** The push left: the iPhone rings. */
  ringing(callId: string, at: string, status: number): boolean {
    return Number(this.database.prepare(`
      UPDATE incoming_calls SET state = 'ringing', pushed_at = ?, apns_status = ? WHERE call_id = ? AND state = 'sending'
    `).run(at, status, callId).changes) > 0;
  }

  /** Her newest call, whatever became of it: when she asked for it and its state. */
  latest(scopeKey: string): IncomingCall | null {
    return callOf(this.database.prepare('SELECT * FROM incoming_calls WHERE scope_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(scopeKey) as unknown as CallRow | undefined);
  }

  /** The API process says whether it can ring: it holds the key and the switches. Written when it starts. */
  setServerAvailable(available: boolean, at: string): void {
    this.database.prepare(`
      INSERT INTO incoming_call_server (singleton, available, updated_at) VALUES (1, ?, ?)
      ON CONFLICT (singleton) DO UPDATE SET available = excluded.available, updated_at = excluded.updated_at
    `).run(available ? 1 : 0, at);
  }

  /** What the API process last said about itself, for her loop; null while it never said anything. */
  serverAvailable(): boolean | null {
    const row = this.database.prepare('SELECT available FROM incoming_call_server WHERE singleton = 1').get() as unknown as { available: number } | undefined;
    return row ? Number(row.available) === 1 : null;
  }

  /**
   * Closes a call from one of the given states. `reason` is a short code of the server's own; an APNs reason
   * is kept as APNs worded it. Returns whether this request changed the row.
   */
  end(callId: string, from: readonly IncomingCallState[], outcome: IncomingCallOutcome, decidedBy: 'app' | 'server', at: string, detail: { status?: number; reason?: string } = {}): boolean {
    const placeholders = from.map(() => '?').join(', ');
    return Number(this.database.prepare(`
      UPDATE incoming_calls SET state = ?, ended_at = ?, decided_by = ?, apns_status = COALESCE(?, apns_status), reason = COALESCE(?, reason)
      WHERE call_id = ? AND state IN (${placeholders})
    `).run(outcome, at, decidedBy, detail.status ?? null, detail.reason?.replace(/[^A-Za-z0-9_:. -]/gu, '_').slice(0, 80) ?? null, callId, ...from).changes) > 0;
  }

  /** What the app said replaces what the server only assumed (a ring nobody had reported on yet). */
  correct(callId: string, outcome: IncomingCallOutcome, at: string): boolean {
    return Number(this.database.prepare(`
      UPDATE incoming_calls SET state = ?, ended_at = ?, decided_by = 'app' WHERE call_id = ? AND state = 'unanswered' AND decided_by = 'server'
    `).run(outcome, at, callId).changes) > 0;
  }

  call(scopeKey: string, callId: string): IncomingCall | null {
    return callOf(this.database.prepare('SELECT * FROM incoming_calls WHERE scope_key = ? AND call_id = ?').get(scopeKey, callId) as unknown as CallRow | undefined);
  }

  ofMessage(scopeKey: string, initiativeId: string): IncomingCall | null {
    return callOf(this.database.prepare('SELECT * FROM incoming_calls WHERE scope_key = ? AND initiative_id = ?').get(scopeKey, initiativeId) as unknown as CallRow | undefined);
  }

  /** What became of the call for one message, for her loop; null while there was none or it still rings. */
  outcome(scopeKey: string, initiativeId: string): IncomingCallOutcome | null {
    const state = this.ofMessage(scopeKey, initiativeId)?.state;
    return INCOMING_CALL_OUTCOMES.find(value => value === state) ?? null;
  }

  /** Calls that are still open: asked for, being sent, or ringing. */
  openCalls(scopeKey: string): readonly IncomingCall[] {
    const rows = this.database.prepare(`
      SELECT * FROM incoming_calls WHERE scope_key = ? AND state IN ('pending', 'sending', 'ringing') ORDER BY created_at
    `).all(scopeKey) as unknown as CallRow[];
    return rows.flatMap(row => callOf(row) ?? []);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function callOf(row: CallRow | undefined): IncomingCall | null {
  const state = STATES.find(value => value === row?.state);
  if (!row || !state) return null;
  return {
    callId: row.call_id, initiativeId: row.initiative_id, deviceId: row.device_id, threadId: row.thread_id, state,
    createdAt: row.created_at, expiresAt: row.expires_at, decidedBy: row.decided_by === 'app' || row.decided_by === 'server' ? row.decided_by : null,
  };
}
