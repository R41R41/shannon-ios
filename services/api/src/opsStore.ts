import { DatabaseSync } from 'node:sqlite';
import { OpsCommandStore } from './opsCommandStore.js';
import type { OpsSnapshot } from './opsContract.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

export interface StoredOpsSnapshot {
  snapshot: OpsSnapshot;
  receivedAt: string;
}

/**
 * The latest operational snapshot of the legacy runtime, one row per scope, replaced on
 * every report. The table is additive. Only the ops routes (`serverOpsRoutes.ts`) hold
 * this store: it is never given to the API kernel, a worker, or a prompt builder.
 */
export class SQLiteOpsStore {
  private readonly database: DatabaseSync;
  /** Stage 2: the record of commands, on the same connection and with the same single holder. */
  readonly commands: OpsCommandStore;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ops_snapshots (
        scope_key TEXT NOT NULL PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        reported_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
    `);
    this.commands = new OpsCommandStore(this.database);
    secureDatabaseFiles(path);
  }

  replace(scopeKey: string, schemaVersion: number, snapshot: OpsSnapshot, receivedAt: string): void {
    this.database.prepare(`
      INSERT INTO ops_snapshots (scope_key, schema_version, reported_at, received_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET
        schema_version = excluded.schema_version, reported_at = excluded.reported_at,
        received_at = excluded.received_at, snapshot_json = excluded.snapshot_json
    `).run(scopeKey, schemaVersion, snapshot.reportedAt, receivedAt, JSON.stringify(snapshot));
  }

  latest(scopeKey: string): StoredOpsSnapshot | null {
    const row = this.database.prepare('SELECT received_at, snapshot_json FROM ops_snapshots WHERE scope_key = ?')
      .get(scopeKey) as { received_at: string; snapshot_json: string } | undefined;
    if (!row) return null;
    try {
      return { snapshot: JSON.parse(row.snapshot_json) as OpsSnapshot, receivedAt: row.received_at };
    } catch {
      return null;
    }
  }

  count(): number {
    return Number((this.database.prepare('SELECT COUNT(*) AS total FROM ops_snapshots').get() as { total: number }).total);
  }

  close(): void {
    this.database.close();
  }
}
