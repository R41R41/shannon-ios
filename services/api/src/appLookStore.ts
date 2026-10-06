import { DatabaseSync } from 'node:sqlite';
import type { AppLookCamera, AppLookClient, AppLookCode } from './contracts/appLookContract.js';
import type { BodyLookOutcome } from './bodyLookStore.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

/**
 * One row per look through an app's camera: who was asked, when, with which camera, and how it ended.
 * Identifiers, timestamps, an outcome and a code, as `body_looks` has them; there is no column for a
 * frame, a description, or any text, so the table cannot hold what she saw. Its own table, so that the
 * limits and the open look of her body are never counted against the app or the other way round.
 * The table is additive.
 */
export type AppLookOutcome = Exclude<BodyLookOutcome, 'discarded'>;

export interface StoredAppLook {
  id: string;
  scopeKey: string;
  deviceId: string;
  threadId: string;
  camera: AppLookCamera;
  platform: AppLookClient['platform'];
  requestedAt: string;
  expiresAt: string;
  /** She was asked to look, or said that she would: a look that did not happen is answered with one line. */
  announced: boolean;
  /** Opened in a turn other people could hear: the model that sees the frame is given no line of the owner's Talk. */
  guarded: boolean;
  outcome: AppLookOutcome;
  code?: AppLookCode;
}

interface LookRow {
  look_id: string; scope_key: string; device_id: string; thread_id: string; camera: string; platform: string;
  requested_at: string; expires_at: string; announced: number; guarded: number; outcome: string; code: string | null;
}

const stored = (row: LookRow): StoredAppLook => ({
  id: row.look_id, scopeKey: row.scope_key, deviceId: row.device_id, threadId: row.thread_id,
  camera: row.camera === 'front' ? 'front' : 'back', platform: row.platform === 'macos' ? 'macos' : 'ios',
  requestedAt: row.requested_at, expiresAt: row.expires_at, announced: Number(row.announced) === 1, guarded: Number(row.guarded) === 1,
  outcome: row.outcome as AppLookOutcome, ...(row.code ? { code: row.code as AppLookCode } : {}),
});

export class SQLiteAppLookStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS app_looks (
        look_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        camera TEXT NOT NULL CHECK (camera IN ('back', 'front')),
        platform TEXT NOT NULL DEFAULT 'ios',
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        announced INTEGER NOT NULL DEFAULT 0 CHECK (announced IN (0, 1)),
        guarded INTEGER NOT NULL DEFAULT 0 CHECK (guarded IN (0, 1)),
        outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'seeing', 'seen', 'refused', 'expired', 'failed')),
        code TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS app_looks_scope_time ON app_looks (scope_key, requested_at DESC);
    `);
    secureDatabaseFiles(path);
  }

  /**
   * Opens a look unless one is already open for the scope, or one was opened at or after `notSince` (the loop
   * guard, which therefore holds across a restart). Returns whether it was opened.
   */
  open(look: Omit<StoredAppLook, 'outcome' | 'code'>, notSince: string): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const blocked = this.blocked(look.scopeKey, notSince);
      if (!blocked) {
        this.database.prepare(`
          INSERT INTO app_looks (look_id, scope_key, device_id, thread_id, camera, platform, requested_at, expires_at, announced, guarded, outcome)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(look.id, look.scopeKey, look.deviceId, look.threadId, look.camera, look.platform, look.requestedAt, look.expiresAt, look.announced ? 1 : 0, look.guarded ? 1 : 0);
      }
      this.database.exec('COMMIT');
      return !blocked;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** A look is open for the scope, or one was opened at or after `notSince`. */
  blocked(scopeKey: string, notSince: string): boolean {
    return this.database.prepare(`
      SELECT 1 AS found FROM app_looks WHERE scope_key = ? AND (outcome IN ('pending', 'seeing') OR requested_at >= ?) LIMIT 1
    `).get(scopeKey, notSince) !== undefined;
  }

  get(scopeKey: string, id: string): StoredAppLook | null {
    const row = this.database.prepare('SELECT * FROM app_looks WHERE scope_key = ? AND look_id = ?').get(scopeKey, id) as unknown as LookRow | undefined;
    return row ? stored(row) : null;
  }

  /** Looks waiting for the app (`pending`) or for the model (`seeing`), expired or not. At most one in normal operation. */
  waiting(scopeKey: string): readonly StoredAppLook[] {
    const rows = this.database.prepare(`SELECT * FROM app_looks WHERE scope_key = ? AND outcome IN ('pending', 'seeing') ORDER BY requested_at DESC`)
      .all(scopeKey) as unknown as LookRow[];
    return rows.map(stored);
  }

  /** Moves a look from one state to the next, once. Returns false when it was no longer in `from`: a repeated answer loses to the first. */
  advance(scopeKey: string, id: string, from: AppLookOutcome, to: AppLookOutcome, at: string, code?: AppLookCode): boolean {
    const result = this.database.prepare(`
      UPDATE app_looks SET outcome = ?, code = COALESCE(?, code), completed_at = COALESCE(completed_at, ?)
      WHERE scope_key = ? AND look_id = ? AND outcome = ?
    `).run(to, code ?? null, to === 'seeing' ? null : at, scopeKey, id, from);
    return Number(result.changes) > 0;
  }

  /** Rows are kept for 30 days: long enough for answering a late repeat. */
  prune(scopeKey: string, requestedBefore: string): number {
    return Number(this.database.prepare(`DELETE FROM app_looks WHERE scope_key = ? AND requested_at < ? AND outcome NOT IN ('pending', 'seeing')`)
      .run(scopeKey, requestedBefore).changes);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
