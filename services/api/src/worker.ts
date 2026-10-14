import { setTimeout as delay } from 'node:timers/promises';
import { ShannonBackgroundWorker } from './mind/sleep/backgroundWorker.js';
import { configuredDatabasePath, SQLiteShannonStore } from './infra/sqlite/sqliteStore.js';
import { MemoryEmbeddingWorker } from './mind/memory/memoryEmbeddingWorker.js';
import { configuredMemoryModelGateway } from './mind/recall/turnMemoryRecall.js';
import { usableKnowledgeFor } from './mind/recall/turnKnowledgeRecall.js';
import { SQLitePeopleMemoryStore } from './mind/memory/store/peopleMemoryStore.js';
import { ConversationReplaySummarizer, createConfiguredReplaySummaryWriter } from './mind/memory/conversationReplaySummary.js';
import { VoiceHistorySummarizer, createConfiguredVoiceSummaryWriter } from './mind/memory/voiceHistorySummary.js';
import { createConfiguredImpressionAnalyzer, ImpressionUpdater } from './mind/memory/impressionUpdater.js';
import { valueNightSchedule, valueSleep } from './mind/sleep/valueSleep.js';
import { stage5InterestNightSchedule, stage5MemoryReaders, stage5MemoryStoreOptions } from './wiring/stage5MemoryWiring.js';
import { memoryWriterOf } from './wiring/memoryOutboxWiring.js';
import { replayCompaction } from './wiring/compactionWiring.js';
import { createConfiguredPersonFactJudge } from './mind/memory/personFacts.js';
import { configuredJevIdentityChooser } from './infra/models/jev/jevIdentity.js';
import { configuredWorkerFeedback } from './wiring/configuredWorkerFeedback.js';
import { configuredOwnerScope } from './infra/config/ownerScope.js';
import { startObserverPublisher } from './infra/observer/store/observerStore.js';

// Syzygy ADR-0008 stage 3 (F5): with SHANNON_MEMORY_OUTBOX on, this process's memory writers propose, and the one writer applies.
const store = new SQLiteShannonStore({ path: configuredDatabasePath(), now: () => new Date().toISOString(), ...stage5MemoryStoreOptions(process.env) });
const observation = startObserverPublisher(configuredDatabasePath());
const feedback = configuredWorkerFeedback(process.env, { path: configuredDatabasePath(), store,
  ownerScope: configuredOwnerScope(process.env), now: () => new Date().toISOString() });
const interestNightly = stage5InterestNightSchedule(store, { now: () => new Date().toISOString(),
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo', sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3) });
const memory = store.memoryProposals();
const peopleStore = new SQLitePeopleMemoryStore(configuredDatabasePath());
// Her impressions of people: one bounded call after a turn (the owner); after a night, the common runtime's sleep task.
const impressions = new ImpressionUpdater(store, store, store.impressionStore(), createConfiguredImpressionAnalyzer(process.env, store), store,
  { people: peopleStore, timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo', memory });
const replayWriter = createConfiguredReplaySummaryWriter(process.env, store);
// Syzygy ADR-0008 stage 3 (F7): with SHANNON_STRUCTURED_COMPACTION on, the summary is the template rendered by code.
const replaySummarizer = new ConversationReplaySummarizer(store, store, replayWriter, store, { memory, compaction: replayCompaction(process.env, store) });
// The voice history's summary (owner decision 2026-10-14, SHANNON_VOICE_HISTORY_SUMMARY): Haiku without thinking, after a turn.
const voiceSummarizer = new VoiceHistorySummarizer(store, store, createConfiguredVoiceSummaryWriter(process.env, store), store, { environment: process.env });
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
// Turn refinement, and the owner's nights scheduled for the common runtime's sleep task (Syzygy ADR-0009 S9: no sleep runs here).
const worker = new ShannonBackgroundWorker(store, store, store, {
  sleepScope: configuredOwnerScope(process.env),
  timeZone: process.env.SHANNON_SLEEP_TIMEZONE?.trim() || 'Asia/Tokyo',
  sleepHour: parseInteger(process.env.SHANNON_SLEEP_HOUR, 3),
  // What left a thread's replay window is summarized here, after the turn's refinement, inside the shared background budget.
  replaySummarizer,
  voiceSummarizer,
  impressionUpdater: impressions,
  memoryProposals: memory,
  // Stage 5: what a turn teaches is read against her self interests (`stage5MemoryReaders`), as before.
  stage5: stage5MemoryReaders(store).stage5 === true,
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
  feedback?.close();
  observation?.close();
  store.close();
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error('SHANNON_WORKER_ENV_INVALID');
  return parsed;
}
