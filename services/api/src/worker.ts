import { setTimeout as delay } from 'node:timers/promises';
import { ShannonBackgroundWorker } from './backgroundWorker.js';
import { createConfiguredSleepMemoryAnalyzer } from './sleepConsolidation.js';
import { configuredDatabasePath, SQLiteShannonStore } from './sqliteStore.js';
import { MemoryEmbeddingWorker } from './memoryEmbeddingWorker.js';
import { configuredMemoryModelGateway } from './turnMemoryRecall.js';
import { createConfiguredKnowledgeAnalyzer, ShannonKnowledgeConsolidator } from './knowledgeConsolidation.js';
import { usableKnowledgeFor } from './turnKnowledgeRecall.js';
import { SQLitePeopleMemoryStore } from './peopleMemoryStore.js';
import { PlatformPeople } from './platformPeople.js';
import { createConfiguredPlatformSummaryWriter, PlatformConversationSummarizer } from './platformPeopleSummaries.js';
import { ConversationReplaySummarizer, createConfiguredReplaySummaryWriter } from './conversationReplaySummary.js';
import { createConfiguredImpressionAnalyzer, ImpressionUpdater } from './impressionUpdater.js';

const store = new SQLiteShannonStore({ path: configuredDatabasePath(), now: () => new Date().toISOString() });
const knowledge = new ShannonKnowledgeConsolidator(store, store, store, createConfiguredKnowledgeAnalyzer(process.env, store), store);
const peopleStore = new SQLitePeopleMemoryStore(configuredDatabasePath());
const platformSummaries = new PlatformConversationSummarizer(peopleStore, new PlatformPeople(peopleStore, store),
  createConfiguredPlatformSummaryWriter(process.env, store), store);
// Her impressions of people: one bounded call after a turn (the owner) and after the sleep batch (people met on a platform).
const impressions = new ImpressionUpdater(store, store, store.impressionStore(), createConfiguredImpressionAnalyzer(process.env, store), store,
  { people: peopleStore, timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo' });
const worker = new ShannonBackgroundWorker(store, store, store, createConfiguredSleepMemoryAnalyzer(process.env, store), {
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo',
  sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3),
  minimumSleepMessages: parseInteger(process.env.SHANNON_SLEEP_MIN_MESSAGES, 3),
  // What left a thread's replay window is summarized here, after the turn's refinement, inside the shared background budget.
  replaySummarizer: new ConversationReplaySummarizer(store, store, createConfiguredReplaySummaryWriter(process.env, store), store),
  impressionUpdater: impressions,
  // All run after a completed sleep batch, inside the shared background budget; none can fail the batch.
  knowledgeConsolidator: { consolidate: async (scopeKey, startAt, endAt) => {
    try { await knowledge.consolidate(scopeKey, startAt, endAt); } finally {
      try { await platformSummaries.consolidate(scopeKey, startAt, endAt); } finally { await impressions.observePlatformPeople(scopeKey, startAt, endAt); }
    }
  } },
});
const embeddingWorker = new MemoryEmbeddingWorker(store, store, configuredMemoryModelGateway(process.env, store), store, {
  // Knowledge derived from a forgotten experience is never embedded.
  isSourceEligible: (scopeKey, source) => source.kind !== 'knowledge'
    || usableKnowledgeFor(store, scopeKey, store.snapshot(scopeKey)).some(document => document.id === source.sourceId),
});
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
  peopleStore.close();
  store.close();
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('SHANNON_WORKER_ENV_INVALID');
  return parsed;
}
