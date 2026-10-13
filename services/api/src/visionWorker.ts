import { configuredDatabasePath } from './infra/sqlite/sqliteStore.js';
import { startObserverPublisher } from './infra/observer/store/observerStore.js';
import { isSqliteBusy, throttledLog } from './infra/sqlite/sqliteBusy.js';
import { visionWorkerEnabled } from './infra/config/visionConfig.js';
import { configuredVisionWorker } from './wiring/visionWorkerWiring.js';

// Syzygy ADR-0011 stage 1: the vision worker (option C). Its own process, so that no frame, decision or reflex loop runs on the
// API's event loop. Off unless SHANNON_VISION_WORKER is on (the systemd unit then exits successfully at once).
// A busy database is transient; anything else is fatal with a closed name only (never a request body), so systemd restarts it.
const busyLog = throttledLog(line => console.error(line));
const unexpected = (kind: string) => (error: unknown) => {
  if (isSqliteBusy(error)) {
    busyLog(`Shannon vision worker ${kind}: database busy, continuing`);
    return;
  }
  const code = error instanceof Error ? /^[A-Z0-9_:-]{1,120}$/u.test(error.message) ? error.message : error.name : 'unknown';
  console.error(`Shannon vision worker fatal ${kind}: ${code}`);
  process.exit(1);
};
process.on('uncaughtException', unexpected('exception'));
process.on('unhandledRejection', unexpected('rejection'));
if (!visionWorkerEnabled(process.env)) {
  console.log('Shannon vision worker off (SHANNON_VISION_WORKER)');
  process.exit(0);
}
const databasePath = configuredDatabasePath();
const observation = startObserverPublisher(databasePath);
const worker = await configuredVisionWorker(process.env, databasePath, { log: line => console.log(line) });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await worker.close(); } finally { observation?.close(); }
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
