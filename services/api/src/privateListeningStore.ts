import { DatabaseSync } from 'node:sqlite';
import { PRIVATE_LISTENING_KINDS, PRIVATE_LISTENING_LIMITS, type PrivateListeningKind } from './privateListeningContract.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

/**
 * Which of the owner's apps say that only he can hear them now (`privateListeningContract.ts`).
 *
 * One row per device: its kind, since when it has been privately listening without a gap, when it
 * last said so, and when the owner last used it. A row counts only while its last report is fresh,
 * so an app that was terminated, lost its network, or was restarted with the server stops counting
 * by itself. Nothing here is text: a closed kind, identifiers of paired devices, and timestamps.
 */
export interface PrivateListener {
  deviceId: string;
  kind: PrivateListeningKind;
  /** The first report of the current unbroken run. */
  since: string;
  seenAt: string;
  ownerActiveAt: string | null;
  /** The app would say a message of hers aloud now. */
  speaks: boolean;
}

interface Row { device_id: string; kind: string; since: string; seen_at: string; owner_active_at: string | null; speaks: number | null }

export class SQLitePrivateListeningStore {
  protected readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS private_listening (
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('mac', 'iphone')),
        since TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        owner_active_at TEXT,
        PRIMARY KEY (scope_key, device_id)
      );
    `);
    // Added after the table first shipped. Two processes may start at once: the loser of the race finds the column there.
    const columns = this.database.prepare(`PRAGMA table_info('private_listening')`).all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'speaks')) {
      try { this.database.exec('ALTER TABLE private_listening ADD COLUMN speaks INTEGER NOT NULL DEFAULT 0'); } catch (error) {
        if (!(error instanceof Error && /duplicate column/iu.test(error.message))) throw error;
      }
    }
    secureDatabaseFiles(path);
  }

  /**
   * One report that the device is privately listening. `since` is kept while the reports follow each other
   * without a gap and the kind is the same; otherwise the run starts now.
   */
  report(scopeKey: string, deviceId: string, input: { kind: PrivateListeningKind; speaks?: boolean; ownerActiveAt?: string }, at: string): PrivateListener {
    const time = Date.parse(at);
    const known = this.row(scopeKey, deviceId);
    const continues = known && known.kind === input.kind && fresh(known.seen_at, time);
    const since = continues ? known.since : at;
    // What the app says about the owner's last use is never later than now, and never moves backwards within a run.
    const reported = input.ownerActiveAt ? new Date(Math.min(Date.parse(input.ownerActiveAt), time)).toISOString() : null;
    const earlier = continues ? known.owner_active_at : null;
    const ownerActiveAt = reported && earlier ? (reported > earlier ? reported : earlier) : reported ?? earlier;
    const speaks = input.speaks === true;
    this.database.prepare(`
      INSERT INTO private_listening (scope_key, device_id, kind, since, seen_at, owner_active_at, speaks) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET kind = excluded.kind, since = excluded.since, seen_at = excluded.seen_at,
        owner_active_at = excluded.owner_active_at, speaks = excluded.speaks
    `).run(scopeKey, deviceId, input.kind, since, at, ownerActiveAt, speaks ? 1 : 0);
    this.database.prepare('DELETE FROM private_listening WHERE seen_at < ?')
      .run(new Date(time - PRIVATE_LISTENING_LIMITS.retentionMilliseconds).toISOString());
    return { deviceId, kind: input.kind, since, seenAt: at, ownerActiveAt, speaks };
  }

  /** The device says it is no longer privately listening (the route changed, the app is closing, the owner switched it off). */
  clear(scopeKey: string, deviceId: string): boolean {
    return Number(this.database.prepare('DELETE FROM private_listening WHERE scope_key = ? AND device_id = ?').run(scopeKey, deviceId).changes) > 0;
  }

  /** The devices that are privately listening at the instant: only rows whose last report is fresh. */
  listeners(scopeKey: string, at: string): readonly PrivateListener[] {
    const time = Date.parse(at);
    const rows = this.database.prepare(`
      SELECT device_id, kind, since, seen_at, owner_active_at, speaks FROM private_listening WHERE scope_key = ? AND seen_at >= ? AND seen_at <= ?
    `).all(scopeKey, new Date(time - PRIVATE_LISTENING_LIMITS.freshMilliseconds).toISOString(), at) as unknown as Row[];
    return rows.flatMap(row => {
      const kind = PRIVATE_LISTENING_KINDS.find(value => value === row.kind);
      return kind ? [{ deviceId: row.device_id, kind, since: row.since, seenAt: row.seen_at, ownerActiveAt: row.owner_active_at, speaks: Number(row.speaks) === 1 }] : [];
    });
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private row(scopeKey: string, deviceId: string): Row | undefined {
    return this.database.prepare(`
      SELECT device_id, kind, since, seen_at, owner_active_at, speaks FROM private_listening WHERE scope_key = ? AND device_id = ?
    `).get(scopeKey, deviceId) as unknown as Row | undefined;
  }
}

function fresh(seenAt: string, time: number): boolean {
  const age = time - Date.parse(seenAt);
  return age >= 0 && age <= PRIVATE_LISTENING_LIMITS.freshMilliseconds;
}
