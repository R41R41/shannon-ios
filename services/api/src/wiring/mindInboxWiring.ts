import { DatabaseSync } from 'node:sqlite';
import { mindSwitches } from '@shannon/mind';
import { SQLiteMindInbox } from '../mind/workspace/store/mindInboxStore.js';
import type { EmitMindEvent } from '../contracts/mindInboxContract.js';

/**
 * Wiring of the mind's inbox for another process (Syzygy ADR-0008 stage 3): her own time's worker and the world worker are handed
 * one function and load the inbox's store and its contract, nothing else of the mind (no host, no perception, no workspace; the
 * pre-deploy review's closure test, `entryClosures.test.ts`).
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';

/**
 * What another process (her own time) is handed of the mind: one function that writes a row of closed fields into `mind_inbox`,
 * once the API process has created it. Null unless the workspace is on. It never throws and never delays her step.
 */
export function configuredMindInbox(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { databasePath: string; log?: (line: string) => void },
): { emit: EmitMindEvent; close(): void } | null {
  if (!mindSwitches(environment).workspace) return null;
  const database = new DatabaseSync(parts.databasePath);
  database.exec(PRAGMAS);
  const inbox = new SQLiteMindInbox(database, { createSchema: false });
  return {
    emit: (scopeKey, draft, at) => {
      try { inbox.append(scopeKey, draft, at); } catch (error) {
        try { parts.log?.(`mind_inbox write failed: ${error instanceof Error ? error.message : 'unknown'}`); } catch { /* the log is optional */ }
      }
    },
    close: () => { if (database.isOpen) database.close(); },
  };
}
