import { setTimeout as delay } from 'node:timers/promises';
import { ShannonBackgroundWorker } from './backgroundWorker.js';
import { createConfiguredSleepMemoryAnalyzer } from './sleepConsolidation.js';
import { configuredDatabasePath, SQLiteShannonStore } from './sqliteStore.js';
import { MemoryEmbeddingWorker } from './memoryEmbeddingWorker.js';
import { configuredMemoryModelGateway } from './turnMemoryRecall.js';

const store = new SQLiteShannonStore({ path: configuredDatabasePath(), now: () => new Date().toISOString() });
const worker = new ShannonBackgroundWorker(store, store, store, createConfiguredSleepMemoryAnalyzer(process.env, store), {
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo',
  sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3),
  minimumSleepMessages: parseInteger(process.env.SHANNON_SLEEP_MIN_MESSAGES, 3),
});
const embeddingWorker = new MemoryEmbeddingWorker(store, store, configuredMemoryModelGateway(process.env, store), store);
const embeddingIntervalMilliseconds = Math.max(5_000, parseInteger(process.env.SHANNON_MEMORY_EMBEDDING_INTERVAL_MS, 30_000));
let nextEmbeddingAt = 0;
const once = process.argv.includes('--once');
let stopping = false;

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

console.log(`Shannon background worker started (${worker.workerId})`);
try {
  do {
    const result = await worker.runOnce();
    // Embeddings never block turn refinement or sleep; they run only between idle polls.
    if (result === 'idle' && Date.now() >= nextEmbeddingAt) {
      const embedding = await embeddingWorker.runOnce();
      nextEmbeddingAt = embedding === 'worked' ? 0 : Date.now() + embeddingIntervalMilliseconds;
    }
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
