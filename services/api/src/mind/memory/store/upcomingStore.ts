import { DatabaseSync } from 'node:sqlite';
import { CALENDAR_LIMITS, type CalendarEvent, type CalendarSnapshot } from '../../../contracts/calendarContract.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';

/**
 * What is coming up for the owner, as the server was told: one calendar snapshot per
 * device, and one snapshot of dated tasks per outside source. Both tables are additive.
 *
 * A device's snapshot replaces its previous one whole, so an event the owner deleted on
 * that device is gone here after its next send. Reading merges the devices.
 *
 * A device that was unpaired, or whose pairing ran out, cannot take its snapshot away
 * itself. Its snapshot is therefore not read from that moment on, and is deleted the next
 * time this store is opened or written.
 */
/** A fixed-token caller has no paired device and no pairing that could end. */
const LOCAL_DEVICE = 'local';
export interface UpcomingTask {
  id: string;
  title: string;
  /** Canonical ISO 8601 (UTC). */
  dueAt: string;
}

export class SQLiteUpcomingStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS calendar_device_snapshots (
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        events_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, device_id)
      );
      CREATE TABLE IF NOT EXISTS upcoming_task_snapshots (
        scope_key TEXT NOT NULL,
        source TEXT NOT NULL,
        tasks_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, source)
      );
    `);
    this.pruneUnpaired(Date.now());
    secureDatabaseFiles(path);
  }

  /** Replaces the device's snapshot. A snapshot without events is kept: it says the device shares and has nothing coming up. */
  replaceCalendar(scopeKey: string, deviceId: string, snapshot: CalendarSnapshot, receivedAt: string): number {
    this.database.prepare(`
      INSERT INTO calendar_device_snapshots
        (scope_key, device_id, generated_at, time_zone, window_start, window_end, events_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET
        generated_at = excluded.generated_at, time_zone = excluded.time_zone, window_start = excluded.window_start,
        window_end = excluded.window_end, events_json = excluded.events_json, received_at = excluded.received_at
    `).run(scopeKey, deviceId, snapshot.generatedAt, snapshot.timeZone, snapshot.windowStart, snapshot.windowEnd,
      JSON.stringify(snapshot.events), receivedAt);
    this.pruneUnpaired(Date.parse(receivedAt));
    return snapshot.events.length;
  }

  /** The owner switched sharing off on this device. */
  removeCalendar(scopeKey: string, deviceId: string): boolean {
    return Number(this.database.prepare('DELETE FROM calendar_device_snapshots WHERE scope_key = ? AND device_id = ?').run(scopeKey, deviceId).changes) > 0;
  }

  /** Devices whose snapshot is still fresh enough to be used. */
  sharingDevices(scopeKey: string, at: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM calendar_device_snapshots WHERE scope_key = ? AND received_at >= ? ${this.paired(at)}`)
      .get(scopeKey, this.freshSince(at)) as unknown as { count: number };
    return Number(row.count);
  }

  /**
   * Events that are under way at `from` or begin before `until`, from every device with a
   * fresh snapshot, earliest first. The same title, start and end from two devices is one event.
   */
  calendarEvents(scopeKey: string, from: string, until: string): readonly (CalendarEvent & { timeZone: string })[] {
    const rows = this.database.prepare(`
      SELECT time_zone, events_json FROM calendar_device_snapshots WHERE scope_key = ? AND received_at >= ? ${this.paired(from)} ORDER BY received_at DESC, device_id ASC
    `).all(scopeKey, this.freshSince(from)) as unknown as Array<{ time_zone: string; events_json: string }>;
    const seen = new Set<string>();
    const events: (CalendarEvent & { timeZone: string })[] = [];
    for (const row of rows) {
      for (const event of parsed<CalendarEvent[]>(row.events_json, [])) {
        if (Date.parse(event.end) <= Date.parse(from) || Date.parse(event.start) >= Date.parse(until)) continue;
        const key = JSON.stringify([event.title, event.start, event.end]);
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({ ...event, timeZone: row.time_zone });
      }
    }
    return events.sort((left, right) => left.start.localeCompare(right.start) || left.title.localeCompare(right.title));
  }

  /** Replaces what one outside source last reported. */
  replaceTasks(scopeKey: string, source: string, tasks: readonly UpcomingTask[], fetchedAt: string): void {
    this.database.prepare(`
      INSERT INTO upcoming_task_snapshots (scope_key, source, tasks_json, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope_key, source) DO UPDATE SET tasks_json = excluded.tasks_json, fetched_at = excluded.fetched_at
    `).run(scopeKey, source, JSON.stringify(tasks.slice(0, 50)), fetchedAt);
  }

  /** Tasks of one source that are due in `[from, until)`, when its snapshot is at most `maximumAgeMilliseconds` old. */
  tasks(scopeKey: string, source: string, from: string, until: string, maximumAgeMilliseconds: number): readonly UpcomingTask[] {
    const row = this.database.prepare('SELECT tasks_json, fetched_at FROM upcoming_task_snapshots WHERE scope_key = ? AND source = ?')
      .get(scopeKey, source) as unknown as { tasks_json: string; fetched_at: string } | undefined;
    if (!row || Date.parse(from) - Date.parse(row.fetched_at) > maximumAgeMilliseconds) return [];
    return parsed<UpcomingTask[]>(row.tasks_json, []).filter(task => task.dueAt >= from && task.dueAt < until)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  /**
   * Deletes the snapshots of devices that are no longer paired. Returns how many were deleted.
   * Without the pairing table (a fixed-token or in-memory server) nothing is deleted.
   */
  pruneUnpaired(nowMilliseconds: number): number {
    if (!this.hasPairingTable() || !Number.isFinite(nowMilliseconds)) return 0;
    return Number(this.database.prepare(`
      DELETE FROM calendar_device_snapshots WHERE device_id <> '${LOCAL_DEVICE}' AND NOT EXISTS (
        SELECT 1 FROM device_tokens token WHERE token.device_id = calendar_device_snapshots.device_id
          AND token.scope_key = calendar_device_snapshots.scope_key AND token.revoked_at IS NULL AND token.expires_at > ?)
    `).run(Math.trunc(nowMilliseconds)).changes);
  }

  /** The condition that a snapshot's device is still paired at `at`; empty while there is no pairing table. */
  private paired(at: string): string {
    const time = Date.parse(at);
    if (!this.hasPairingTable() || !Number.isFinite(time)) return '';
    return `AND (device_id = '${LOCAL_DEVICE}' OR EXISTS (
      SELECT 1 FROM device_tokens token WHERE token.device_id = calendar_device_snapshots.device_id
        AND token.scope_key = calendar_device_snapshots.scope_key AND token.revoked_at IS NULL AND token.expires_at > ${Math.trunc(time)}))`;
  }

  private hasPairingTable(): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'device_tokens'`).get());
  }

  private freshSince(at: string): string {
    return new Date(Date.parse(at) - CALENDAR_LIMITS.snapshotMaximumAgeMilliseconds).toISOString();
  }
}

function parsed<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
