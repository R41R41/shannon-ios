/** Her withheld actions' store, wired (Syzygy ADR-0008 §14; split out of `withheldWiring.ts` in stage 3 so that the world worker, which only records what the proactive gate held, loads the store alone). */
import { DatabaseSync } from 'node:sqlite';
import { WithheldActions } from '../mind/inhibition/withheldActions.js';
import { skillRoutingSwitches } from '@shannon/learning';

/**
 * Wiring of Syzygy ADR-0008 §14 (`contracts/withheldActionContract.ts`): her withheld actions. Null with `SHANNON_ADR8_STAGE2=off`:
 * then no table, no record, and every prompt is what it was.
 *
 * - The API process creates `shannon_withheld_actions` and writes what her tools' gate stopped in conversations (and what its
 *   own gate decisions did not allow); the activity loop writes what her own time's gate, her tool steps and a session's budget
 *   stopped, once the table exists, and shows her next thought the most recent ones (never while anyone else may be present,
 *   like her value facts).
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';

export function configuredWithheldActions(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { databasePath: string | null; createsSchema: boolean; database?: DatabaseSync; defer?: (task: () => void) => void; log?: (line: string) => void },
): { withheld: WithheldActions; close(): void } | null {
  if (!skillRoutingSwitches(environment).stage2 || (!parts.database && !parts.databasePath)) return null;
  const database = parts.database ?? new DatabaseSync(parts.databasePath!);
  if (!parts.database) database.exec(PRAGMAS);
  const withheld = new WithheldActions({ database, createsSchema: parts.createsSchema, ...(parts.defer ? { defer: parts.defer } : {}), ...(parts.log ? { log: parts.log } : {}) });
  return { withheld, close: () => { if (!parts.database && database.isOpen) database.close(); } };
}
