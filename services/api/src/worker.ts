import { setTimeout as delay } from 'node:timers/promises';
import { ShannonBackgroundWorker } from './mind/sleep/backgroundWorker.js';
import { createConfiguredSleepMemoryAnalyzer } from './mind/sleep/sleepConsolidation.js';
import { configuredDatabasePath, SQLiteShannonStore } from './infra/sqlite/sqliteStore.js';
import { MemoryEmbeddingWorker } from './mind/memory/memoryEmbeddingWorker.js';
import { configuredMemoryModelGateway } from './mind/recall/turnMemoryRecall.js';
import { createConfiguredKnowledgeAnalyzer, ShannonKnowledgeConsolidator } from './mind/sleep/knowledgeConsolidation.js';
import { usableKnowledgeFor } from './mind/recall/turnKnowledgeRecall.js';
import { SQLitePeopleMemoryStore } from './mind/memory/store/peopleMemoryStore.js';
import { PlatformPeople } from './mind/memory/platformPeople.js';
import { createConfiguredPlatformSummaryWriter, PlatformConversationSummarizer } from './surfaces/platform/platformPeopleSummaries.js';
import { ConversationReplaySummarizer, createConfiguredReplaySummaryWriter } from './mind/memory/conversationReplaySummary.js';
import { createConfiguredImpressionAnalyzer, ImpressionUpdater } from './mind/memory/impressionUpdater.js';
import { valueNightSchedule, valueSleep } from './mind/sleep/valueSleep.js';
import { memoryWriterOf } from './wiring/memoryOutboxWiring.js';
import { replayCompaction } from './wiring/compactionWiring.js';
import { peopleFactReaders } from './wiring/peopleFactsWiring.js';
import { stage5InterestNightSchedule, stage5MemoryReaders, stage5MemoryStoreOptions } from './wiring/stage5MemoryWiring.js';
import { createConfiguredPersonFactJudge } from './mind/memory/personFacts.js';
import { configuredJevIdentityChooser } from './infra/models/jev/jevIdentity.js';
import { configuredSkillExport, configuredSkillMemory, skillSleepConsolidator } from './wiring/skillMemoryWiring.js';
import { configuredWorkerFeedback } from './wiring/configuredWorkerFeedback.js';
import { configuredOwnerScope } from './infra/config/ownerScope.js';

// Syzygy ADR-0008 stage 3 (F5): with SHANNON_MEMORY_OUTBOX on, this process's memory writers propose, and the one writer applies.
const store = new SQLiteShannonStore({ path: configuredDatabasePath(), now: () => new Date().toISOString(), ...stage5MemoryStoreOptions(process.env) });
const feedback = configuredWorkerFeedback(process.env, { path: configuredDatabasePath(), store,
  ownerScope: configuredOwnerScope(process.env), now: () => new Date().toISOString() });
const interestNightly = stage5InterestNightSchedule(store, { now: () => new Date().toISOString(),
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo', sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3) });
const memory = store.memoryProposals();
const knowledge = new ShannonKnowledgeConsolidator(store, store, store, createConfiguredKnowledgeAnalyzer(process.env, store), store, { memory });
// Syzygy ADR-0008 stage 2, step 6: her skills are built after her knowledge, in the same budget; the API process creates their tables.
const skillMemory = configuredSkillMemory(process.env, { databasePath: configuredDatabasePath(), createsSchema: false });
const skills = skillMemory ? skillSleepConsolidator(process.env, { memory: skillMemory.memory, store, choices: store.choiceLedger() }) : null;
// Step 7: their readable copies in Aether's シャノン用フォルダ, and the owner's edits of them adopted; off without Aether.
const skillExport = skillMemory ? configuredSkillExport(process.env, { memory: skillMemory.memory, store }) : null;
const peopleStore = new SQLitePeopleMemoryStore(configuredDatabasePath());
// F6 (review M4): with temporal facts on, the facts the rules closed are left out of what a summary reads, as in a conversation.
const platformSummaries = new PlatformConversationSummarizer(peopleStore, new PlatformPeople(peopleStore, store, undefined, memory, peopleFactReaders(store, () => new Date().toISOString())),
  createConfiguredPlatformSummaryWriter(process.env, store), store);
// Her impressions of people: one bounded call after a turn (the owner) and after the sleep batch (people met on a platform).
const impressions = new ImpressionUpdater(store, store, store.impressionStore(), createConfiguredImpressionAnalyzer(process.env, store), store,
  { people: peopleStore, timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo', memory });
const replayWriter = createConfiguredReplaySummaryWriter(process.env, store);
// Syzygy ADR-0008 stage 3 (F7): with SHANNON_STRUCTURED_COMPACTION on, the summary is the template rendered by code.
const replaySummarizer = new ConversationReplaySummarizer(store, store, replayWriter, store, { memory, compaction: replayCompaction(process.env, store) });
// Syzygy ADR-0008 stage 1: after each sleep batch, the ledgers' nightly pass (expiry, delayed credit, retention); never fails the batch.
const valueNight = valueSleep({ predictions: store.predictionLedger(), choices: store.choiceLedger(), values: store.valueVersions() });
// Its own daily trigger at the sleep hour, whether or not a conversation's sleep job ran or succeeded (idempotent per day).
const valueNightly = valueNightSchedule({
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo', sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3),
  scopes: () => {
    const scopes = new Set<string>();
    try { for (const scopeKey of store.choiceLedger()?.store.scopes() ?? []) scopes.add(scopeKey); } catch { /* the table may not exist yet */ }
    try { for (const scopeKey of store.predictionLedger()?.store.scopes() ?? []) scopes.add(scopeKey); } catch { /* the table may not exist yet */ }
    return [...scopes];
  },
  run: (scopeKey, at, notBefore) => valueNight(scopeKey, at, () => store.snapshot(scopeKey), notBefore),
});
const worker = new ShannonBackgroundWorker(store, store, store, createConfiguredSleepMemoryAnalyzer(process.env, store), {
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo',
  sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3),
  minimumSleepMessages: parseInteger(process.env.SHANNON_SLEEP_MIN_MESSAGES, 3),
  // What left a thread's replay window is summarized here, after the turn's refinement, inside the shared background budget.
  replaySummarizer,
  impressionUpdater: impressions,
  memoryProposals: memory,
  ...stage5MemoryReaders(store),
  // All run after a completed sleep batch, inside the shared background budget; none can fail the batch.
  knowledgeConsolidator: { consolidate: async (scopeKey, startAt, endAt) => {
    try { await knowledge.consolidate(scopeKey, startAt, endAt); } finally {
      // Her skills after her knowledge (they may be built from it); a failure is logged by code and never fails the rest.
      try { await skills?.consolidate(scopeKey, startAt, endAt); } catch (error) { console.error('Shannon skill sleep failed', error instanceof Error ? error.name : 'unknown'); }
      try { await skillExport?.(scopeKey, new Date().toISOString()); } catch (error) { console.error('Shannon skill export failed', error instanceof Error ? error.name : 'unknown'); }
      try { await platformSummaries.consolidate(scopeKey, startAt, endAt); } finally { await impressions.observePlatformPeople(scopeKey, startAt, endAt); }
    }
  } },
});
// The one memory writer, on this process's connection, under its lease (null while the outbox is switched off).
const memoryWriter = memoryWriterOf(store, { now: () => new Date().toISOString(), owner: `memory-${worker.workerId}`,
  replaySummaries: replaySummarizer, impressions,
  // F6: luna's contradiction and duplicate step (40 calls a day, then the rule) and tier 4's Jev chooser, in the background only.
  judge: createConfiguredPersonFactJudge(process.env, store), chooser: configuredJevIdentityChooser(process.env) });
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

// The memory writer on its own loop (stage 3 review M6): it applies what was proposed every 1.5 seconds, whatever a long sleep job
// or refinement of the main loop is doing (a failure is logged by code by `drain` and never stops the worker).
const MEMORY_WRITER_INTERVAL_MILLISECONDS = 1_500;
const memoryLoop = memoryWriter && !once ? (async () => {
  while (!stopping) {
    await memoryWriter.drain();
    await delay(MEMORY_WRITER_INTERVAL_MILLISECONDS);
  }
})() : null;

console.log(`Shannon background worker started (${worker.workerId})`);
try {
  do {
    valueNightly(new Date().toISOString());
    interestNightly?.(new Date().toISOString());
    const result = await worker.runOnce();
    // `--once`: the writer's one run follows the main loop's, as before.
    if (once && memoryWriter) await memoryWriter.runOnce().catch(error => { console.error('Shannon memory writer failed', error instanceof Error ? error.name : 'unknown'); });
    // Embeddings never block turn refinement or sleep; they run only between idle polls.
    if (result === 'idle' && Date.now() >= nextEmbeddingAt) {
      const embedding = await embeddingWorker.runOnce();
      nextEmbeddingAt = embedding === 'worked' ? 0 : Date.now() + embeddingIntervalMilliseconds;
    }
    if (once) break;
    if (result === 'idle') await delay(1_000);
  } while (!stopping);
} finally {
  await memoryLoop;
  try { memoryWriter?.releaseLease(); } catch { /* the next writer takes it when it expires */ }
  peopleStore.close();
  skillMemory?.close();
  feedback?.close();
  store.close();
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('SHANNON_WORKER_ENV_INVALID');
  return parsed;
}
