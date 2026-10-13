import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import type { TracedOperationOutcomes } from '../mind/tools/toolTracePorts.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { BODY_LIMITS } from '../contracts/bodyContract.js';
import type { SQLiteBodyStore } from '../surfaces/body/store/bodyStore.js';
import { configuredLifecycleOutcomeTelling, type LifecycleOutcomeTeller } from './lifecycleOutcomeTellingWiring.js';

/**
 * How her accepted Minecraft lifecycle operations ended, for the tool traces a later turn of the same Talk replays (the
 * 2026-10-14 incident: a login accepted in a voice turn completed two seconds later, and her next turn read only 「受け付けた」
 * beside a failed first try, and told the owner it had not worked). Read through the lease reader (the one reader of the
 * action table), on a read-only connection opened at the first read; a read that fails answers null (the trace then says only
 * 「受け付けた」).
 */
export function configuredOperationOutcomes(databasePath: string, telling?: {
  env: Readonly<Record<string, string | undefined>>; usageStore: LlmUsageStore; now: () => string;
  /** Whether anyone else may see or hear her body (a stream included), as the body reported it. */
  body: Pick<SQLiteBodyStore, 'othersPresent'>;
}): { read: TracedOperationOutcomes; tell?: LifecycleOutcomeTeller; close(): void } {
  // With `telling`, how such an operation ended is also told to the owner in her words when it ends (owner decision 2026-10-14).
  const others = (scopeKey: string, at: string) => telling!.body.othersPresent(scopeKey, at, BODY_LIMITS.audienceFreshMilliseconds,
    BODY_LIMITS.audienceEventWindowMilliseconds);
  const told = telling ? configuredLifecycleOutcomeTelling(telling.env, { databasePath, usageStore: telling.usageStore, now: telling.now, others }) : null;
  let opened: { database: DatabaseSync; reader: ActionLeaseReader } | null = null, closed = false;
  const reader = (): ActionLeaseReader => {
    if (closed) throw new Error('OPERATION_OUTCOMES_CLOSED');
    if (!opened) {
      const database = openDatabase(databasePath, 'readOnly');
      opened = { database, reader: new ActionLeaseReader(database) };
    }
    return opened.reader;
  };
  return {
    ...(told ? { tell: told.tell } : {}),
    read(scopeKey, operationIds) {
      try {
        return reader().lifecycleOutcomes(scopeKey, operationIds);
      } catch {
        return null;
      }
    },
    close() {
      closed = true;
      told?.close();
      const closing = opened;
      opened = null;
      try {
        closing?.database.close();
      } catch { /* closing */ }
    },
  };
}
