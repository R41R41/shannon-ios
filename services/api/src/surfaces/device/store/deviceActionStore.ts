import { DatabaseSync } from 'node:sqlite';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';
import {
  DEVICE_ACTION_LIMITS, isDeviceActionKind, type DeviceActionCode, type DeviceActionKind, type DeviceActionReport, type DeviceActionStatus,
  type DeviceActionView, type DevicePollState, type MusicPlayReport,
} from '../../../contracts/deviceActionContract.js';

/**
 * The device-action outbox (`docs/device-actions-contract.md`). One row per action: what kind, its small payload, which device
 * may take it, who took it, and how it ended. A row moves `pending` → `claimed` → `done` | `failed` | `denied`, or to `expired`,
 * each step once (a guarded UPDATE), so a repeated report loses to the first and a reported action is never handed again.
 * Its own tables, additive and created here like the other surface stores.
 */
export interface StoredDeviceAction extends DeviceActionView {
  scopeKey: string;
  status: DeviceActionStatus;
  targetDeviceId: string | null;
  claimedBy: string | null;
  code: DeviceActionCode | null;
  result: Readonly<Record<string, unknown>> | null;
  reportedAt: string | null;
  told: boolean;
}

export interface DeviceSeen {
  deviceId: string;
  platform: 'ios' | 'macos';
  kinds: readonly DeviceActionKind[];
  foreground: boolean;
  inCall: boolean;
  seenAt: string;
}

export type DeviceReportOutcome =
  | { kind: 'accepted'; action: StoredDeviceAction }
  | { kind: 'already'; action: StoredDeviceAction }
  | { kind: 'not_found' }
  | { kind: 'not_yours' };

interface ActionRow {
  action_id: string; scope_key: string; kind: string; payload_json: string; target_device_id: string | null; status: string; code: string | null;
  result_json: string | null; claimed_by: string | null; requested_at: string; expires_at: string; reported_at: string | null; told: number;
}
interface DeviceRow { device_id: string; platform: string; kinds: string; foreground: number; in_call: number; seen_at: string }

const parsed = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
};

const stored = (row: ActionRow): StoredDeviceAction => ({
  id: row.action_id, scopeKey: row.scope_key, kind: row.kind as DeviceActionKind, payload: parsed(row.payload_json) ?? {},
  requestedAt: row.requested_at, expiresAt: row.expires_at, status: row.status as DeviceActionStatus, targetDeviceId: row.target_device_id,
  claimedBy: row.claimed_by, code: (row.code as DeviceActionCode | null) ?? null, result: parsed(row.result_json), reportedAt: row.reported_at,
  told: Number(row.told) === 1,
});

/** A claimed action whose device went quiet is closed this long after it expired (its outcome stays unknown: `expired`). */
const CLAIM_GRACE_MILLISECONDS = 60_000;

export class SQLiteDeviceActionStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS device_actions (
        action_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dedupe_key TEXT,
        target_device_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'denied', 'expired')),
        code TEXT,
        result_json TEXT,
        claimed_by TEXT,
        claimed_at TEXT,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        reported_at TEXT,
        told INTEGER NOT NULL DEFAULT 0 CHECK (told IN (0, 1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS device_actions_dedupe ON device_actions (scope_key, dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS device_actions_scope_status ON device_actions (scope_key, status, requested_at);
      CREATE TABLE IF NOT EXISTS device_action_devices (
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        kinds TEXT NOT NULL,
        foreground INTEGER NOT NULL DEFAULT 0,
        in_call INTEGER NOT NULL DEFAULT 0,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, device_id)
      );
      CREATE TABLE IF NOT EXISTS device_music_plays (
        play_id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        action_id TEXT,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('started', 'skipped', 'finished', 'stopped')),
        reported_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS device_music_plays_scope_time ON device_music_plays (scope_key, reported_at DESC);
    `);
    secureDatabaseFiles(path);
  }

  /** What a device said about itself when it polled. */
  seen(scopeKey: string, deviceId: string, state: Omit<DevicePollState, 'wait'>, at: string): void {
    this.database.prepare(`
      INSERT INTO device_action_devices (scope_key, device_id, platform, kinds, foreground, in_call, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET platform = excluded.platform, kinds = excluded.kinds, foreground = excluded.foreground,
        in_call = excluded.in_call, seen_at = excluded.seen_at
    `).run(scopeKey, deviceId, state.platform, state.kinds.join(','), state.foreground ? 1 : 0, state.inCall ? 1 : 0, at);
  }

  /** The devices of a scope that polled at or after `since`, most recent first. */
  devices(scopeKey: string, since: string): readonly DeviceSeen[] {
    const rows = this.database.prepare('SELECT * FROM device_action_devices WHERE scope_key = ? AND seen_at >= ? ORDER BY seen_at DESC')
      .all(scopeKey, since) as unknown as DeviceRow[];
    return rows.map(row => ({
      deviceId: row.device_id, platform: row.platform === 'macos' ? 'macos' : 'ios', kinds: row.kinds.split(',').filter(isDeviceActionKind),
      foreground: Number(row.foreground) === 1, inCall: Number(row.in_call) === 1, seenAt: row.seen_at,
    }));
  }

  /**
   * Adds an action unless the same `dedupeKey` was already used in the scope (a retried turn asks once), or the scope already has
   * `openPerScope` open actions. Returns the stored action and whether it was there already.
   */
  create(action: { id: string; scopeKey: string; kind: DeviceActionKind; payload: Readonly<Record<string, unknown>>; dedupeKey: string | null;
    targetDeviceId: string | null; requestedAt: string; expiresAt: string }): { action: StoredDeviceAction; duplicate: boolean } | 'limit' {
    return this.transaction(() => {
      if (action.dedupeKey) {
        const known = this.database.prepare('SELECT * FROM device_actions WHERE scope_key = ? AND dedupe_key = ?')
          .get(action.scopeKey, action.dedupeKey) as unknown as ActionRow | undefined;
        if (known) return { action: stored(known), duplicate: true };
      }
      const open = this.database.prepare(`SELECT COUNT(*) AS count FROM device_actions WHERE scope_key = ? AND status IN ('pending', 'claimed')`)
        .get(action.scopeKey) as { count: number };
      if (Number(open.count) >= DEVICE_ACTION_LIMITS.openPerScope) return 'limit' as const;
      this.database.prepare(`
        INSERT INTO device_actions (action_id, scope_key, kind, payload_json, dedupe_key, target_device_id, status, requested_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(action.id, action.scopeKey, action.kind, JSON.stringify(action.payload), action.dedupeKey, action.targetDeviceId,
        action.requestedAt, action.expiresAt);
      return { action: this.get(action.scopeKey, action.id)!, duplicate: false };
    });
  }

  get(scopeKey: string, id: string): StoredDeviceAction | null {
    const row = this.database.prepare('SELECT * FROM device_actions WHERE scope_key = ? AND action_id = ?')
      .get(scopeKey, id) as unknown as ActionRow | undefined;
    return row ? stored(row) : null;
  }

  /**
   * Hands a device what it may take now: pending actions for it (or for any device) of kinds it can do, which it then holds, and the
   * ones it already holds but has not reported (a lost answer is handed again to the same device, never to another).
   */
  claim(scopeKey: string, deviceId: string, kinds: readonly DeviceActionKind[], at: string): readonly DeviceActionView[] {
    if (!kinds.length) return [];
    return this.transaction(() => {
      this.expire(scopeKey, at);
      const marks = kinds.map(() => '?').join(', ');
      const rows = this.database.prepare(`
        SELECT * FROM device_actions WHERE scope_key = ? AND expires_at > ? AND kind IN (${marks})
          AND ((status = 'pending' AND (target_device_id IS NULL OR target_device_id = ?)) OR (status = 'claimed' AND claimed_by = ?))
        ORDER BY requested_at ASC LIMIT ?
      `).all(scopeKey, at, ...kinds, deviceId, deviceId, DEVICE_ACTION_LIMITS.pollBatch) as unknown as ActionRow[];
      const claim = this.database.prepare(`
        UPDATE device_actions SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE action_id = ? AND status = 'pending'
      `);
      for (const row of rows) if (row.status === 'pending') claim.run(deviceId, at, row.action_id);
      return rows.map(row => ({
        id: row.action_id, kind: row.kind as DeviceActionKind, payload: parsed(row.payload_json) ?? {},
        requestedAt: row.requested_at, expiresAt: row.expires_at,
      }));
    });
  }

  /** Whether anything is waiting for this device now (a held poll answers as soon as this turns true). */
  waiting(scopeKey: string, deviceId: string, kinds: readonly DeviceActionKind[], at: string): boolean {
    if (!kinds.length) return false;
    const marks = kinds.map(() => '?').join(', ');
    return this.database.prepare(`
      SELECT 1 AS found FROM device_actions WHERE scope_key = ? AND expires_at > ? AND kind IN (${marks})
        AND ((status = 'pending' AND (target_device_id IS NULL OR target_device_id = ?)) OR (status = 'claimed' AND claimed_by = ?)) LIMIT 1
    `).get(scopeKey, at, ...kinds, deviceId, deviceId) !== undefined;
  }

  /**
   * The device's report, once. A claimed action (also one closed as expired while its device was quiet) takes the report of the
   * device that holds it; a report of anything already reported is answered with what was recorded and changes nothing.
   */
  report(scopeKey: string, deviceId: string, id: string, report: DeviceActionReport, at: string): DeviceReportOutcome {
    return this.transaction(() => {
      const action = this.get(scopeKey, id);
      if (!action) return { kind: 'not_found' as const };
      if (action.claimedBy !== deviceId && !(action.status === 'pending' && (action.targetDeviceId === null || action.targetDeviceId === deviceId))) {
        return { kind: 'not_yours' as const };
      }
      const closed = action.status !== 'pending' && action.status !== 'claimed' && action.status !== 'expired';
      if (action.reportedAt || closed) return { kind: 'already' as const, action };
      this.database.prepare(`
        UPDATE device_actions SET status = ?, code = ?, result_json = ?, reported_at = ?, claimed_by = COALESCE(claimed_by, ?)
        WHERE action_id = ? AND reported_at IS NULL
      `).run(report.status, report.code ?? null, report.result ? JSON.stringify(report.result) : null, at, deviceId, id);
      return { kind: 'accepted' as const, action: this.get(scopeKey, id)! };
    });
  }

  /** Closes what nobody took in time, and what was taken but never reported (outcome unknown). */
  expire(scopeKey: string, at: string): number {
    const grace = new Date(Date.parse(at) - CLAIM_GRACE_MILLISECONDS).toISOString();
    return Number(this.database.prepare(`
      UPDATE device_actions SET status = 'expired' WHERE scope_key = ? AND reported_at IS NULL
        AND ((status = 'pending' AND expires_at <= ?) OR (status = 'claimed' AND expires_at <= ?))
    `).run(scopeKey, at, grace).changes);
  }

  /** The conversation already told her this outcome: her next turns are not told it again. */
  markTold(scopeKey: string, id: string): void {
    this.database.prepare('UPDATE device_actions SET told = 1 WHERE scope_key = ? AND action_id = ?').run(scopeKey, id);
  }

  /** Actions requested at or after `since`, newest first. */
  recent(scopeKey: string, since: string, limit = 8): readonly StoredDeviceAction[] {
    const rows = this.database.prepare('SELECT * FROM device_actions WHERE scope_key = ? AND requested_at >= ? ORDER BY requested_at DESC LIMIT ?')
      .all(scopeKey, since, limit) as unknown as ActionRow[];
    return rows.map(stored);
  }

  /** One play outcome the device saw; kept as data for a later reward of her music choices. */
  recordPlay(scopeKey: string, deviceId: string, play: MusicPlayReport, at: string): void {
    this.database.prepare(`
      INSERT INTO device_music_plays (scope_key, device_id, action_id, item_id, title, artist, outcome, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, deviceId, play.actionId ?? null, play.itemId, play.title, play.artist ?? null, play.outcome, at);
  }

  plays(scopeKey: string, limit = 20): ReadonlyArray<MusicPlayReport & { reportedAt: string }> {
    const rows = this.database.prepare('SELECT * FROM device_music_plays WHERE scope_key = ? ORDER BY play_id DESC LIMIT ?')
      .all(scopeKey, limit) as Array<Record<string, string | null>>;
    return rows.map(row => ({ itemId: row.item_id!, title: row.title!, outcome: row.outcome as MusicPlayReport['outcome'], reportedAt: row.reported_at!,
      ...(row.action_id ? { actionId: row.action_id } : {}), ...(row.artist ? { artist: row.artist } : {}) }));
  }

  /** Drops what is older than `before` and closed; open actions are never dropped. */
  prune(before: string): number {
    const actions = this.database.prepare(`DELETE FROM device_actions WHERE requested_at < ? AND status NOT IN ('pending', 'claimed')`).run(before).changes;
    const plays = this.database.prepare('DELETE FROM device_music_plays WHERE reported_at < ?').run(before).changes;
    return Number(actions) + Number(plays);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
