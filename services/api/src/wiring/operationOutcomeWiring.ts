import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import type { TracedOperationOutcomes } from '../mind/tools/toolTracePorts.js';

/**
 * How her accepted Minecraft lifecycle operations ended, for the tool traces a later turn of the same Talk replays (the
 * 2026-10-14 incident: a login accepted in a voice turn completed two seconds later, and her next turn read only 「受け付けた」
 * beside a failed first try, and told the owner it had not worked). Read through the lease reader (the one reader of the
 * action table), on a read-only connection opened at the first read; a read that fails answers nothing (the trace then says
 * 「受け付けた」 as it did before).
 */
export function configuredOperationOutcomes(databasePath: string): { read: TracedOperationOutcomes; close(): void } {
  let opened: { database: DatabaseSync; reader: ActionLeaseReader } | null = null;
  const reader = (): ActionLeaseReader => {
    if (!opened) {
      const database = openDatabase(databasePath, 'readOnly');
      opened = { database, reader: new ActionLeaseReader(database) };
    }
    return opened.reader;
  };
  return {
    read(scopeKey, operationIds) {
      try {
        return reader().lifecycleOutcomes(scopeKey, operationIds);
      } catch {
        return new Map();
      }
    },
    close() {
      const closing = opened;
      opened = null;
      try {
        closing?.database.close();
      } catch { /* closing */ }
    },
  };
}
