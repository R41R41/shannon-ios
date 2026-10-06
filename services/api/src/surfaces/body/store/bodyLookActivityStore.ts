import { DatabaseSync } from 'node:sqlite';
import { secureDatabaseFiles } from '../../../infra/sqlite/sqliteStoreContext.js';

/**
 * The hand-off of a look she takes in her own time (stage 2) between two processes.
 *
 * Her activity loop runs apart from the API. The loop opens the look; the body's answer
 * arrives at the API, which shows the frame to the model and leaves here only what the
 * loop needs to finish its step: her short text about what she saw, and the tokens the
 * call used. The loop takes the text once and it is erased in the same statement, so it
 * rests here for seconds. There is no column for a frame.
 *
 * The second table is when a body with its camera on last read presence. The loop cannot
 * see the API's memory, and "her window is showing" is the condition for planning a look.
 * It is written only while stage 2 is on, and holds one timestamp per device.
 */
export interface ActivityLookUsage { inputTokens: number; outputTokens: number }

export interface ActivityLookHandOff {
  /** The model the gate priced; the API calls this one and no other. */
  model: string;
  /** Her text about the look, until the loop takes it. */
  note: string | null;
  usage: ActivityLookUsage | null;
}

interface HandOffRow { model: string; note: string | null; input_tokens: number | null; output_tokens: number | null }

export class SQLiteBodyLookActivityStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS body_look_activity (
        look_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        taken_at TEXT
      );
      CREATE TABLE IF NOT EXISTS body_look_presence (
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, device_id)
      );
    `);
    secureDatabaseFiles(path);
  }

  // MARK: Presence (written by the API process, read by the loop)

  markPresence(scopeKey: string, deviceId: string, at: string): void {
    this.database.prepare(`
      INSERT INTO body_look_presence (scope_key, device_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET read_at = excluded.read_at
    `).run(scopeKey, deviceId, at);
  }

  /** Devices that read presence in `[since, until]`, the most recent first. */
  presentDevices(scopeKey: string, since: string, until: string): readonly string[] {
    const rows = this.database.prepare(`
      SELECT device_id FROM body_look_presence WHERE scope_key = ? AND read_at >= ? AND read_at <= ? ORDER BY read_at DESC
    `).all(scopeKey, since, until) as unknown as Array<{ device_id: string }>;
    return rows.map(row => row.device_id);
  }

  // MARK: Hand-off (begun and taken by the loop, filled by the API process)

  begin(scopeKey: string, lookId: string, model: string, at: string): void {
    this.database.prepare(`
      INSERT INTO body_look_activity (look_id, scope_key, model, created_at) VALUES (?, ?, ?, ?)
    `).run(lookId, scopeKey, model, at);
  }

  /** Removes a hand-off whose look was never opened. */
  discard(scopeKey: string, lookId: string): void {
    this.database.prepare('DELETE FROM body_look_activity WHERE scope_key = ? AND look_id = ? AND note IS NULL AND input_tokens IS NULL').run(scopeKey, lookId);
  }

  get(scopeKey: string, lookId: string): ActivityLookHandOff | null {
    const row = this.database.prepare(`
      SELECT model, note, input_tokens, output_tokens FROM body_look_activity WHERE scope_key = ? AND look_id = ?
    `).get(scopeKey, lookId) as unknown as HandOffRow | undefined;
    return row ? handOff(row) : null;
  }

  /** What the provider counted for the one call of this look. Written before the text, so a call that produced no text is still paid for. */
  recordUsage(scopeKey: string, lookId: string, usage: ActivityLookUsage): void {
    this.database.prepare(`
      UPDATE body_look_activity SET input_tokens = ?, output_tokens = ? WHERE scope_key = ? AND look_id = ? AND taken_at IS NULL
    `).run(count(usage.inputTokens), count(usage.outputTokens), scopeKey, lookId);
  }

  /** Her text about the look. False when the loop has already closed the hand-off; the text is then not kept. */
  keepNote(scopeKey: string, lookId: string, note: string): boolean {
    return Number(this.database.prepare(`
      UPDATE body_look_activity SET note = ? WHERE scope_key = ? AND look_id = ? AND taken_at IS NULL AND note IS NULL
    `).run(note, scopeKey, lookId).changes) > 0;
  }

  /** The loop takes the hand-off once: the text is erased from the row in the same statement that returns it. */
  take(scopeKey: string, lookId: string, at: string): ActivityLookHandOff | null {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare(`
        SELECT model, note, input_tokens, output_tokens FROM body_look_activity WHERE scope_key = ? AND look_id = ? AND taken_at IS NULL
      `).get(scopeKey, lookId) as unknown as HandOffRow | undefined;
      if (row) this.database.prepare('UPDATE body_look_activity SET note = NULL, taken_at = ? WHERE scope_key = ? AND look_id = ?').run(at, scopeKey, lookId);
      this.database.exec('COMMIT');
      return row ? handOff(row) : null;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** A text nobody took (the loop stopped mid-step) is erased, and old rows are dropped. */
  prune(scopeKey: string, untakenBefore: string, createdBefore: string): void {
    this.database.prepare('UPDATE body_look_activity SET note = NULL WHERE scope_key = ? AND note IS NOT NULL AND created_at < ?').run(scopeKey, untakenBefore);
    this.database.prepare('DELETE FROM body_look_activity WHERE scope_key = ? AND created_at < ?').run(scopeKey, createdBefore);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}

function handOff(row: HandOffRow): ActivityLookHandOff {
  return {
    model: row.model, note: row.note,
    usage: row.input_tokens === null || row.output_tokens === null ? null : { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) },
  };
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
