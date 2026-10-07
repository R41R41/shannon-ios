import { DatabaseSync } from 'node:sqlite';
import { skillRoutingSwitches } from '@shannon/learning';
import { withheldOfDecision, type AutonomyConfig, type GateRefusalObserver } from '../mind/inhibition/inhibitionPorts.js';
import { WithheldActions } from '../mind/inhibition/withheldActions.js';

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

/** What her own time's gate is handed: each decision that did not allow a step, written as withheld. */
export function gateRefusals(withheld: WithheldActions, config: Pick<AutonomyConfig, 'timeZone'>): GateRefusalObserver {
  return (scopeKey, request, decision, at) => {
    const draft = withheldOfDecision(request, decision, at, config);
    if (draft) withheld.sink(scopeKey, draft, at);
  };
}

/** Her thought's 「止められたこと」, or null while anyone else may see or hear her (what the server knows of her body). */
export function withheldFactsReader(
  withheld: WithheldActions, body: (scopeKey: string, at: string) => { others: boolean }, clock: (at: string) => string,
): (scopeKey: string, at: string) => string | null {
  return (scopeKey, at) => (body(scopeKey, at).others ? null : withheld.facts(scopeKey, at, clock));
}
