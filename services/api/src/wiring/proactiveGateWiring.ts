import { DatabaseSync } from 'node:sqlite';
import { createProactiveGate, mindSwitches, type ProactiveDeliveryGate, type ProactiveGateDependencies } from '../mind/attention/attentionPorts.js';
import { SQLiteProactiveTopics } from '../mind/attention/store/proactiveTopicsStore.js';

/**
 * Wiring of Syzygy ADR-0008 stage 3's proactive gate (owner answer 2, `docs/mind-workspace-contract.md`): the gate every message she
 * starts on her own passes where it is written (`SQLiteReachOutSpeaker`, `IncomingCallRequests`, `SQLiteInitiativeStore`), in the
 * process that writes it (her own time's worker, the world worker). Its own connection creates and writes `proactive_topics` only;
 * a hold goes to the withheld actions and the mind's inbox through the functions it is handed. Null with
 * `SHANNON_ADR8_STAGE3=off` or `SHANNON_PROACTIVE_GATE=off`: no table, no check, every message as it was.
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';

export function configuredProactiveGate(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { databasePath: string } & Omit<ProactiveGateDependencies, 'topics'>,
): { gate: ProactiveDeliveryGate; close(): void } | null {
  if (!mindSwitches(environment).proactiveGate) return null;
  const database = new DatabaseSync(parts.databasePath);
  database.exec(PRAGMAS);
  const { databasePath: _path, ...dependencies } = parts;
  const gate = createProactiveGate({ ...dependencies, topics: new SQLiteProactiveTopics(database, { createSchema: true }) });
  return { gate, close: () => { if (database.isOpen) database.close(); } };
}
