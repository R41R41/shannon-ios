import { DatabaseSync } from 'node:sqlite';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import type { VoiceDecisionGateway } from '../contracts/voiceDecisionContract.js';
import { countedJevFetch } from '../infra/models/jev/jevClient.js';
import { jevUsdPerCall } from '../infra/models/jev/jevUsage.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { DecisionTraces, decisionTracesEnabled } from '../mind/inhibition/decisionTraces.js';
import { TracedVoiceDecisionGateway } from '../mind/inhibition/tracedVoiceDecision.js';
import { ChoiceLedger, choiceLedgerEnabled } from '../mind/learning/choiceLedger.js';
import { PredictionLedger, predictionLedgerEnabled } from '../mind/learning/predictionLedger.js';
import { ValueVersions } from '../mind/learning/valueTable.js';
import { createConfiguredVoiceDecisionGateway } from '../mind/selectors/voiceDecision.js';

/**
 * Wiring of Syzygy ADR-0008 stage 1 (`docs/cognition-ledger-contract.md`): the connections the activity loop's process opens
 * for the cognition ledger, and the voice turn's traced gateway. The parts are handed connections and writer functions here
 * and nowhere else; each reads its switch from the environment it is given.
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';

/** For a process that holds no store of the API (the activity loop): its own connection, or null under the switches. */
export function configuredDecisionTraces(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string,
): { traces: DecisionTraces; close(): void } | null {
  if (!decisionTracesEnabled(environment)) return null;
  const database = new DatabaseSync(databasePath);
  database.exec(PRAGMAS);
  const traces = new DecisionTraces({ database, createsSchema: false });
  return { traces, close: () => { traces.flushLockWaits(); if (database.isOpen) database.close(); } };
}

/** For a process that holds no store of the API (the activity loop): its own connection, or null under the switches. */
export function configuredPredictionLedger(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string,
): { ledger: PredictionLedger; choices: ChoiceLedger | null; values: ValueVersions | null; close(): void } | null {
  if (!predictionLedgerEnabled(environment)) return null;
  const database = new DatabaseSync(databasePath);
  database.exec(PRAGMAS);
  const ledger = new PredictionLedger({ database, createsSchema: false });
  // Her choices share the connection and the queue: a prediction settled before a report is seen by its settlement.
  const choices = choiceLedgerEnabled(environment) ? new ChoiceLedger({ database, createsSchema: false }) : null;
  // V at choice time is read from the value table's active version on the same connection.
  const values = choices ? new ValueVersions({ database, createsSchema: false }) : null;
  if (choices && values) choices.readValuesFrom(values.reader);
  return { ledger, choices, values, close: () => { ledger.flushLockWaits(); choices?.flushLockWaits(); if (database.isOpen) database.close(); } };
}

/**
 * The gateway of the voice turn. With a trace writer, the configured one with a counting Jev fetch, wrapped; without one
 * (`SHANNON_DECISION_TRACES=off`), exactly `createConfiguredVoiceDecisionGateway(environment, usageStore)`.
 */
export function configuredVoiceDecision(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore | undefined, write: DecisionTraceWriter | null,
): VoiceDecisionGateway {
  if (!write) return createConfiguredVoiceDecisionGateway(environment, usageStore);
  const inner = createConfiguredVoiceDecisionGateway(environment, usageStore, countedJevFetch());
  return new TracedVoiceDecisionGateway(inner, write, { usdPerJevCall: jevUsdPerCall(environment) });
}
