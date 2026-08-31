import { setTimeout as delay } from 'node:timers/promises';
import { ShannonBackgroundWorker } from './backgroundWorker.js';
import { createConfiguredSleepMemoryAnalyzer } from './sleepConsolidation.js';
import { configuredDatabasePath, SQLiteShannonStore } from './sqliteStore.js';

const store = new SQLiteShannonStore({ path: configuredDatabasePath(), now: () => new Date().toISOString() });
const worker = new ShannonBackgroundWorker(store, store, store, createConfiguredSleepMemoryAnalyzer(), {
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo',
  sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3),
});
const once = process.argv.includes('--once');
let stopping = false;

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

console.log(`Shannon background worker started (${worker.workerId})`);
try {
  do {
    const result = await worker.runOnce();
    if (once) break;
    if (result === 'idle') await delay(1_000);
  } while (!stopping);
} finally {
  store.close();
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('SHANNON_WORKER_ENV_INVALID');
  return parsed;
}
