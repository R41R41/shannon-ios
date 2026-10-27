import { DatabaseSync } from 'node:sqlite';
import type { BodyLookCode, BodyLookSource } from '../../../contracts/bodyLookContract.js';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';

/**
 * One row per look: who was asked, when, and how it ended. Identifiers, timestamps, an
 * outcome and a code. There is no column for a frame, a description, or any text, so the
 * table cannot hold what she saw (`source` says only whether the frame was of the room or of the owner's screen).
 * The table is additive.
 */
export type BodyLookOutcome = 'pending' | 'seeing' | 'seen' | 'refused' | 'discarded' | 'expired' | 'failed';

export interface StoredBodyLook {
  id: string;
  scopeKey: string;
  deviceId: string;
  threadId: string;
  requestedAt: string;
  expiresAt: string;
  /** The owner asked her to look, so a look that did not happen is answered with one line. */
  ownerAsked: boolean;
  outcome: BodyLookOutcome;
  code?: BodyLookCode;
  /** When a frame arrived, whether or not it was shown to the model. Counted by the limits. */
  frameReceivedAt?: string;
  completedAt?: string;
  /** What the frame is of: the room through the camera, or the owner's screen. */
  source: BodyLookSource;
}

interface LookRow {
  look_id: string; scope_key: string; device_id: string; thread_id: string; requested_at: string; expires_at: string;
  owner_asked: number; outcome: string; code: string | null; frame_received_at: string | null; completed_at: string | null;
  source: string | null;
}

const stored = (row: LookRow): StoredBodyLook => ({
  id: row.look_id, scopeKey: row.scope_key, deviceId: row.device_id, threadId: row.thread_id,
  requestedAt: row.requested_at, expiresAt: row.expires_at, ownerAsked: Number(row.owner_asked) === 1,
  outcome: row.outcome as BodyLookOutcome,
  ...(row.code ? { code: row.code as BodyLookCode } : {}),
  ...(row.frame_received_at ? { frameReceivedAt: row.frame_received_at } : {}),
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  source: row.source === 'screen' ? 'screen' : 'camera',
});

export class SQLiteBodyLookStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS body_looks (
        look_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        day_key TEXT NOT NULL,
        owner_asked INTEGER NOT NULL DEFAULT 0 CHECK (owner_asked IN (0, 1)),
        outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'seeing', 'seen', 'refused', 'discarded', 'expired', 'failed')),
        code TEXT,
        frame_received_at TEXT,
        completed_at TEXT,
        source TEXT NOT NULL DEFAULT 'camera' CHECK (source IN ('camera', 'screen'))
      );
      CREATE INDEX IF NOT EXISTS body_looks_scope_time ON body_looks (scope_key, requested_at DESC);
      CREATE INDEX IF NOT EXISTS body_looks_scope_day ON body_looks (scope_key, day_key);
    `);
    // A table made before looks had a source gets the column (the API and the activity loop both open this table).
    const columns = this.database.prepare("PRAGMA table_info('body_looks')").all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'source')) {
      try {
        this.database.exec("ALTER TABLE body_looks ADD COLUMN source TEXT NOT NULL DEFAULT 'camera' CHECK (source IN ('camera', 'screen'))");
      } catch (error) {
        // The other process added it first.
        const again = this.database.prepare("PRAGMA table_info('body_looks')").all() as unknown as Array<{ name: string }>;
        if (!again.some(column => column.name === 'source')) throw error;
      }
    }
    secureDatabaseFiles(path);
  }

  /** Opens a look unless one is already open for the scope. Returns whether it was opened. */
  open(look: Pick<StoredBodyLook, 'id' | 'scopeKey' | 'deviceId' | 'threadId' | 'requestedAt' | 'expiresAt' | 'ownerAsked'> & { source?: BodyLookSource }, dayKey: string): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const busy = this.database.prepare(`SELECT 1 AS found FROM body_looks WHERE scope_key = ? AND outcome IN ('pending', 'seeing') LIMIT 1`).get(look.scopeKey);
      if (!busy) {
        this.database.prepare(`
          INSERT INTO body_looks (look_id, scope_key, device_id, thread_id, requested_at, expires_at, day_key, owner_asked, outcome, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(look.id, look.scopeKey, look.deviceId, look.threadId, look.requestedAt, look.expiresAt, dayKey, look.ownerAsked ? 1 : 0, look.source ?? 'camera');
      }
      this.database.exec('COMMIT');
      return !busy;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(scopeKey: string, id: string): StoredBodyLook | null {
    const row = this.database.prepare('SELECT * FROM body_looks WHERE scope_key = ? AND look_id = ?').get(scopeKey, id) as unknown as LookRow | undefined;
    return row ? stored(row) : null;
  }

  /** Looks waiting for the body (`pending`) or for the model (`seeing`), expired or not. At most one in normal operation. */
  waiting(scopeKey: string): readonly StoredBodyLook[] {
    const rows = this.database.prepare(`SELECT * FROM body_looks WHERE scope_key = ? AND outcome IN ('pending', 'seeing') ORDER BY requested_at DESC`)
      .all(scopeKey) as unknown as LookRow[];
    return rows.map(stored);
  }

  /**
   * Moves a look from one state to the next, once. Returns false when it was no longer in
   * `from`, which is how a repeated answer loses to the first one.
   */
  advance(scopeKey: string, id: string, from: BodyLookOutcome, to: BodyLookOutcome, at: string, change: { code?: BodyLookCode; frameReceived?: boolean } = {}): boolean {
    const finished = to !== 'seeing';
    const result = this.database.prepare(`
      UPDATE body_looks SET outcome = ?, code = COALESCE(?, code),
        frame_received_at = COALESCE(frame_received_at, ?), completed_at = COALESCE(completed_at, ?)
      WHERE scope_key = ? AND look_id = ? AND outcome = ?
    `).run(to, change.code ?? null, change.frameReceived ? at : null, finished ? at : null, scopeKey, id, from);
    return Number(result.changes) > 0;
  }

  /** Looks that used the camera (a frame arrived) or may still use it (waiting), since an instant. */
  usedSince(scopeKey: string, since: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM body_looks
      WHERE scope_key = ? AND requested_at >= ? AND (frame_received_at IS NOT NULL OR outcome IN ('pending', 'seeing'))
    `).get(scopeKey, since) as unknown as { count: number };
    return Number(row.count);
  }

  usedOnDay(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM body_looks
      WHERE scope_key = ? AND day_key = ? AND (frame_received_at IS NOT NULL OR outcome IN ('pending', 'seeing'))
    `).get(scopeKey, dayKey) as unknown as { count: number };
    return Number(row.count);
  }

  /** Rows are kept for 30 days: long enough for the limits and for answering a late repeat. */
  prune(scopeKey: string, requestedBefore: string): number {
    return Number(this.database.prepare(`DELETE FROM body_looks WHERE scope_key = ? AND requested_at < ? AND outcome NOT IN ('pending', 'seeing')`)
      .run(scopeKey, requestedBefore).changes);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
