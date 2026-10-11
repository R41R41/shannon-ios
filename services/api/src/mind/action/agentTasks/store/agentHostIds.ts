import type { DatabaseSync } from 'node:sqlite';

/** The ids of the Agent Hosts that ever registered (`agent_hosts`); none while the table does not exist yet. Read-only. */
export function knownAgentHostIds(db: DatabaseSync): string[] {
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'agent_hosts'").get();
  if (!table) return [];
  const rows = db.prepare('SELECT host_id FROM agent_hosts ORDER BY host_id').all();
  return rows.map(row => String(row.host_id));
}
