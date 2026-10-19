import type { DatabaseSync } from 'node:sqlite';

/**
 * The owner's 「新しいワールドで始める」 switch, one row per scope (`docs/ops-contract.md`). A scope with no row is off, and so is
 * a row that cannot be read: the switch asks for a world to be deleted, so every doubt is "off" (fail closed). The table is
 * additive and shares the connection of the ops snapshot store, which creates it. Only the ops route writes it; the lifecycle admission only reads it.
 */
export class OpsWorldPolicyStore {
  constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ops_minecraft_world_policy (
        scope_key TEXT NOT NULL PRIMARY KEY,
        fresh_world INTEGER NOT NULL,
        changed_at TEXT NOT NULL
      );
    `);
  }

  /** Whether the switch is on. Off for a scope never set, and off whenever the row cannot be read. */
  freshWorld(scopeKey: string): boolean {
    try {
      const row = this.database.prepare('SELECT fresh_world FROM ops_minecraft_world_policy WHERE scope_key = ?')
        .get(scopeKey) as { fresh_world?: unknown } | undefined;
      return row?.fresh_world === 1;
    } catch {
      return false;
    }
  }

  set(scopeKey: string, freshWorld: boolean, at: string): void {
    this.database.prepare(`
      INSERT INTO ops_minecraft_world_policy (scope_key, fresh_world, changed_at) VALUES (?, ?, ?)
      ON CONFLICT (scope_key) DO UPDATE SET fresh_world = excluded.fresh_world, changed_at = excluded.changed_at
    `).run(scopeKey, freshWorld ? 1 : 0, at);
  }
}
