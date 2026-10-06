import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompanionClock, CompanionStateEvent, CompanionStateSnapshot, CompanionStateStore, ShannonEmotionTiming } from '@shannon/cognition';
import type { BackgroundJobStore, ClaimedBackgroundJob, DailyUserMessage } from '../../mind/sleep/store/backgroundJobStore.js';
import type { ShannonConversationItem } from '../../chatModel.js';
import type {
  ConversationStore,
  ConversationThread,
  PlatformTurnPersistenceInput,
  ShannonExperience,
  StoredConversationMessage,
  TurnPersistenceContext,
} from '../../mind/memory/store/conversationStore.js';
import type { SleepConsolidationOutcome } from '../../mind/sleep/sleepConsolidation.js';
import type { ActivityItem } from '../../mind/memory/memoryService.js';
import type { LlmUsageEvent, LlmUsageStore } from '../../llmUsage.js';
import type {
  RealtimeVoiceAllowanceStatus,
  RealtimeVoiceReservationStore,
  RealtimeVoiceSessionReservation,
  RealtimeVoiceSessionReservationRequest,
} from '../../realtimeVoice.js';
import type { KnowledgeAnswer, KnowledgeRevision, KnowledgeSource, KnowledgeStore, LayeredIdentityPrompt, PersonalityProfile } from '../../mind/memory/store/knowledgeStore.js';
import { SQLiteBackgroundJobRepository } from './sqliteBackgroundJobRepository.js';
import { SQLiteCompanionRepository } from './sqliteCompanionRepository.js';
import { ensureSummaryLineageSchema, SQLiteConversationRepository } from './sqliteConversationRepository.js';
import { SQLiteStoreContext, secureDatabaseFiles } from './sqliteStoreContext.js';
import { SQLiteStoreMigrator } from './sqliteMigrations.js';
import { SQLiteMemorySearchRepository, type MemorySearchHit } from '../../mind/memory/store/sqliteMemorySearch.js';
import { SQLiteShannonKnowledgeStore, type ShannonKnowledgeStore } from '../../mind/memory/store/sqliteShannonKnowledge.js';
import type { KnowledgeDraft } from '@shannon/cognition';
import { SQLiteMemoryEmbeddingIndex, type MemoryEmbeddingIndex, type PendingEmbeddingSource } from '../../mind/memory/store/sqliteMemoryEmbeddings.js';
import { ensureTurnCaptureSchema, type TurnCaptureRecord } from '../../mind/memory/store/turnCaptures.js';
import { ensureReplaySummarySchema, selectRecentMessages, selectReplaySummary, selectThreadOfTurn, upsertReplaySummary } from '../../mind/memory/store/sqliteReplaySummary.js';
import { deleteToolTraces, ensureToolTraceSchema, insertToolTrace, pruneToolTraces, selectToolTraceScopes, selectToolTraces, toolTraceRetentionBoundary } from '../../sqliteToolTraces.js';
import type { ToolTraceRecord } from '../../shannonToolTrace.js';
import type { ReplaySummaryRecord } from '../../mind/memory/store/conversationStore.js';
import { SQLiteImpressionStore } from '../../mind/memory/store/sqliteImpressions.js';
import { ensureMoodHistorySchema, pruneMoodHistory, recordMoodPoint } from '../../mind/emotion/store/moodHistory.js';
import { SQLiteRealtimeVoiceRepository } from './sqliteRealtimeVoiceRepository.js';
import { moodHistoryRecording, type MoodHistoryRecording } from '../../contracts/moodHistoryContract.js';
import { PredictionShadow, predictionShadowEnabled } from '../../mind/prediction/predictionShadow.js';

const DEFAULT_DATABASE_PATH = resolve(fileURLToPath(new URL('../../../../../data/shannon.sqlite', import.meta.url)));

export interface PersistedExperienceEvent { sequence: number; id: string; scopeKey: string; type: string; observedAt: string; payload: unknown; }
export interface SQLiteShannonStoreOptions {
  path: string; now: CompanionClock; /** Absent: this process's `emotionTiming()`. */ emotionTiming?: ShannonEmotionTiming; maximumModelConversationItems?: number; maximumDisplayedConversationItems?: number; maximumExperiences?: number;
  /** Whose mood is recorded beside each committed state write (`moodHistory.ts`); `null` records nothing. Absent: `SHANNON_MOOD_HISTORY` and the owner scope of this process. */
  moodHistory?: MoodHistoryRecording | null;
  /**
   * A store of a process that only reads through it (the activity loop's owner context, `autonomyOwnerContextWiring.ts`):
   * it neither creates, prunes nor records the mood history. That table stays the API's.
   */
  leavesMoodHistory?: true;
  /** The prediction shadow beside each committed state write (Syzygy ADR-0006 stage 1). Absent: `SHANNON_PREDICTION_SHADOW`; never with `leavesMoodHistory`. */
  predictionShadow?: boolean;
  /** When the shadow's work runs. Absent: `setImmediate`. Tests may pass one that runs at once. */
  predictionShadowDefer?: (task: () => void) => void;
}

export class SQLiteShannonStore implements CompanionStateStore, ConversationStore, BackgroundJobStore, KnowledgeStore, LlmUsageStore, RealtimeVoiceReservationStore, MemoryEmbeddingIndex, ShannonKnowledgeStore {
  private readonly context: SQLiteStoreContext;
  private readonly companion: SQLiteCompanionRepository;
  private readonly realtimeVoice: SQLiteRealtimeVoiceRepository;
  private readonly conversations: SQLiteConversationRepository;
  private readonly jobs: SQLiteBackgroundJobRepository;
  private readonly memorySearch: SQLiteMemorySearchRepository;
  private readonly embeddings: SQLiteMemoryEmbeddingIndex;
  private readonly shannonKnowledge: SQLiteShannonKnowledgeStore;
  private readonly personImpressions: SQLiteImpressionStore;
  private readonly shadow: PredictionShadow | null;

  constructor(options: SQLiteShannonStoreOptions) {
    this.context = new SQLiteStoreContext(options);
    const moodHistory = options.leavesMoodHistory ? null : options.moodHistory === undefined ? moodHistoryRecording(process.env) : options.moodHistory;
    // After each write of her state, a point of her mood from the state as written, at the instant it was reduced at, and the
    // prediction shadow's tap on the same write (ADR-0006 stage 1); neither changes the state.
    const shadowOn = !options.leavesMoodHistory && (options.predictionShadow ?? predictionShadowEnabled(process.env));
    this.shadow = shadowOn ? new PredictionShadow({
      database: this.context.database, createsSchema: true, timing: () => this.context.emotionTiming(),
      // After the response and after the caller's transaction: no turn, touch or worker waits for the shadow.
      defer: options.predictionShadowDefer ?? (task => { setImmediate(task); }),
    }) : null;
    this.companion = new SQLiteCompanionRepository(this.context, (scopeKey, state, at, event) => {
      recordMoodPoint(this.context.database, moodHistory, scopeKey, state, at, this.context.emotionTiming());
      this.shadow?.stateWritten(scopeKey, state, at, event);
    });
    this.realtimeVoice = new SQLiteRealtimeVoiceRepository(this.context);
    this.conversations = new SQLiteConversationRepository(this.context);
    this.jobs = new SQLiteBackgroundJobRepository(this.context, this.companion);
    new SQLiteStoreMigrator(this.context, this.companion).migrate();
    ensureTurnCaptureSchema(this.context.database);
    ensureSummaryLineageSchema(this.context.database);
    ensureReplaySummarySchema(this.context.database);
    ensureToolTraceSchema(this.context.database);
    // What her tools did is kept 30 days: older traces go at every open too, in every scope.
    const traceBoundary = toolTraceRetentionBoundary(this.context.now());
    if (traceBoundary) pruneToolTraces(this.context.database, traceBoundary);
    if (!options.leavesMoodHistory) {
      ensureMoodHistorySchema(this.context.database);
      // Retention holds also while nothing is recorded (the switch is off, or no write for weeks): old points go at every start.
      pruneMoodHistory(this.context.database, this.context.now());
    }
    this.memorySearch = new SQLiteMemorySearchRepository(this.context.database);
    this.embeddings = new SQLiteMemoryEmbeddingIndex(this.context.database);
    this.shannonKnowledge = new SQLiteShannonKnowledgeStore(this.context.database, operation => this.context.transaction(operation));
    this.personImpressions = new SQLiteImpressionStore(this.context.database, operation => this.context.transaction(operation));
    secureDatabaseFiles(options.path);
  }

  snapshot(scopeKey: string) { return this.companion.snapshot(scopeKey); }
  apply(scopeKey: string, event: CompanionStateEvent) { return this.companion.apply(scopeKey, event); }
  synchronizeFact(scopeKey: string, fact: CompanionStateSnapshot['userFacts'][number], source: KnowledgeSource) { return this.companion.synchronizeFact(scopeKey, fact, source); }
  correctKnowledge(scopeKey: string, answerId: string, answer: string, observedAt: string) { return this.companion.correctKnowledge(scopeKey, answerId, answer, observedAt); }
  knowledgeAnswers(scopeKey: string): readonly KnowledgeAnswer[] { return this.companion.knowledgeAnswers(scopeKey); }
  knowledgeRevisions(scopeKey: string, answerId?: string): readonly KnowledgeRevision[] { return this.companion.knowledgeRevisions(scopeKey, answerId); }
  personalityProfile(scopeKey: string): PersonalityProfile | null { return this.companion.personalityProfile(scopeKey); }
  promptProjection(scopeKey: string): string | null { return this.companion.promptProjection(scopeKey); }
  promptProjectionParts(scopeKey: string): LayeredIdentityPrompt | null { return this.companion.promptProjectionParts(scopeKey); }
  recordLlmUsage(event: LlmUsageEvent) { return this.companion.recordLlmUsage(event); }
  backgroundLlmCostUsd(monthKey: string) { return this.companion.backgroundLlmCostUsd(monthKey); }
  backgroundLlmCostUsdForDay(dayKey: string) { return this.companion.backgroundLlmCostUsdForDay(dayKey); }
  voiceLlmCostUsdForDay(scopeKey: string, dayKey: string) { return this.companion.voiceLlmCostUsdForDay(scopeKey, dayKey); }
  reserveRealtimeVoiceSession(request: RealtimeVoiceSessionReservationRequest): RealtimeVoiceSessionReservation | null { return this.realtimeVoice.reserveRealtimeVoiceSession(request); }
  releaseRealtimeVoiceSessionReservation(reservationId: string) { return this.realtimeVoice.releaseRealtimeVoiceSessionReservation(reservationId); }
  realtimeVoiceReservedSecondsForDay(scopeKey: string, dayKey: string) { return this.realtimeVoice.realtimeVoiceReservedSecondsForDay(scopeKey, dayKey); }
  realtimeVoiceAllowanceStatus(scopeKey: string, dayKey: string, baseAllowanceSeconds: number, maximumAllowanceSeconds?: number): RealtimeVoiceAllowanceStatus {
    return this.realtimeVoice.realtimeVoiceAllowanceStatus(scopeKey, dayKey, baseAllowanceSeconds, maximumAllowanceSeconds);
  }
  extendRealtimeVoiceAllowance(scopeKey: string, dayKey: string, baseAllowanceSeconds: number, additionalSeconds: number, maximumAllowanceSeconds: number, updatedAt: string): RealtimeVoiceAllowanceStatus | null {
    return this.realtimeVoice.extendRealtimeVoiceAllowance(
      scopeKey, dayKey, baseAllowanceSeconds, additionalSeconds, maximumAllowanceSeconds, updatedAt,
    );
  }
  llmUsageSummary(scopeKey: string, monthKey: string) { return this.companion.llmUsageSummary(scopeKey, monthKey); }

  listThreads(scopeKey: string): readonly ConversationThread[] { return this.conversations.listThreads(scopeKey); }
  threadId(scopeKey: string, threadId?: string) { return this.conversations.threadId(scopeKey, threadId); }
  createThread(scopeKey: string, title?: string) { return this.conversations.createThread(scopeKey, title); }
  renameThread(scopeKey: string, threadId: string, title: string) { return this.conversations.renameThread(scopeKey, threadId, title); }
  needsAutomaticThreadTitle(scopeKey: string, threadId: string) { return this.conversations.needsAutomaticThreadTitle(scopeKey, threadId); }
  archiveThread(scopeKey: string, threadId: string) { return this.conversations.archiveThread(scopeKey, threadId); }
  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[] { return this.conversations.history(scopeKey, threadId); }
  threadSummary(scopeKey: string, threadId: string) { return this.conversations.threadSummary(scopeKey, threadId); }
  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[] { return this.conversations.conversationHistory(scopeKey, threadId); }
  experienceCandidates(scopeKey: string): readonly ShannonExperience[] { return this.conversations.experienceCandidates(scopeKey); }
  searchMemory(scopeKey: string, text: string, limit?: number): readonly MemorySearchHit[] { return this.memorySearch.searchMemory(scopeKey, text, limit); }
  embeddingScopes() { return this.embeddings.embeddingScopes(); }
  pendingEmbeddingSources(scopeKey: string, model: string, stateVersion: number, limit: number) { return this.embeddings.pendingEmbeddingSources(scopeKey, model, stateVersion, limit); }
  storeEmbedding(source: PendingEmbeddingSource, model: string, vector: Float32Array, stateVersion: number, updatedAt: string) { this.embeddings.storeEmbedding(source, model, vector, stateVersion, updatedAt); }
  withholdEmbedding(source: PendingEmbeddingSource, model: string, stateVersion: number, updatedAt: string) { this.embeddings.withholdEmbedding(source, model, stateVersion, updatedAt); }
  embeddingCandidates(scopeKey: string, model: string, limit: number) { return this.embeddings.embeddingCandidates(scopeKey, model, limit); }
  listShannonKnowledge(scopeKey: string, options?: { includeRetired?: boolean }) { return this.shannonKnowledge.listShannonKnowledge(scopeKey, options); }
  createShannonKnowledge(scopeKey: string, draft: KnowledgeDraft, at: string, reason: string) { return this.shannonKnowledge.createShannonKnowledge(scopeKey, draft, at, reason); }
  updateShannonKnowledge(scopeKey: string, id: string, expectedVersion: number, draft: KnowledgeDraft, at: string, reason: string) { return this.shannonKnowledge.updateShannonKnowledge(scopeKey, id, expectedVersion, draft, at, reason); }
  retireShannonKnowledge(scopeKey: string, id: string, reason: string, at: string, evidence?: readonly string[]) { return this.shannonKnowledge.retireShannonKnowledge(scopeKey, id, reason, at, evidence); }
  experienceObservedAt(scopeKey: string, ids: readonly string[]) { return this.shannonKnowledge.experienceObservedAt(scopeKey, ids); }
  appendTurn(scopeKey: string, threadId: string, userMessage: string, shannonReply: string, observedAt: string, context?: TurnPersistenceContext) { return this.conversations.appendTurn(scopeKey, threadId, userMessage, shannonReply, observedAt, context); }
  ingestPlatformTurn(input: PlatformTurnPersistenceInput) { return this.conversations.ingestPlatformTurn(input); }
  appendNote(scopeKey: string, threadId: string, content: string, observedAt: string, noteKind: string) { return this.conversations.appendNote(scopeKey, threadId, content, observedAt, noteKind); }
  recordTurnCaptures(scopeKey: string, captures: readonly TurnCaptureRecord[]) { return this.conversations.recordTurnCaptures(scopeKey, captures); }
  turnCaptures(scopeKey: string, turnIds: readonly string[]) { return this.conversations.turnCaptures(scopeKey, turnIds); }
  threadSummaryLineage(scopeKey: string, threadId: string) { return this.conversations.threadSummaryLineage(scopeKey, threadId); }
  experiencesById(scopeKey: string, experienceIds: readonly string[]) { return this.conversations.experiencesById(scopeKey, experienceIds); }
  recentMessages(scopeKey: string, threadId: string, limit: number) { return selectRecentMessages(this.context.database, scopeKey, this.conversations.threadId(scopeKey, threadId), limit); }
  replaySummary(scopeKey: string, threadId: string) { return selectReplaySummary(this.context.database, scopeKey, threadId); }
  saveReplaySummary(scopeKey: string, threadId: string, record: ReplaySummaryRecord) { this.context.transaction(() => upsertReplaySummary(this.context.database, scopeKey, threadId, record)); }
  threadOfTurn(scopeKey: string, experienceId: string) { return selectThreadOfTurn(this.context.database, scopeKey, experienceId); }
  saveToolTrace(scopeKey: string, record: ToolTraceRecord) { this.context.transaction(() => insertToolTrace(this.context.database, scopeKey, record)); }
  toolTraces(scopeKey: string, threadId: string | null, query: { turnIds?: readonly string[]; since?: string }) { return selectToolTraces(this.context.database, scopeKey, threadId, query); }
  deleteToolTraces(scopeKey: string, turnIds: readonly string[]) { if (turnIds.length) this.context.transaction(() => deleteToolTraces(this.context.database, scopeKey, turnIds)); }
  toolTraceScopes() { return selectToolTraceScopes(this.context.database); }
  pruneToolTraces(before: string) { this.context.transaction(() => pruneToolTraces(this.context.database, before)); }
  impressionStore() { return this.personImpressions; }
  /** The prediction shadow on this store's connection, or null while it is switched off. */
  predictionShadow(): PredictionShadow | null { return this.shadow; }
  events(scopeKey: string): readonly PersistedExperienceEvent[] { return this.conversations.events(scopeKey); }
  activityTimeline(scopeKey: string): readonly ActivityItem[] { return this.conversations.activityTimeline(scopeKey); }

  enqueueTurnRefinement(scopeKey: string, experienceId: string, userMessage: string, observedAt: string, timeZone?: string) { return this.jobs.enqueueTurnRefinement(scopeKey, experienceId, userMessage, observedAt, timeZone); }
  recoverUnqueuedTurnRefinements(nowIso: string) { return this.jobs.recoverUnqueuedTurnRefinements(nowIso); }
  enqueueSleepConsolidations(dayKey: string, startAt: string, endAt: string, nowIso: string) { return this.jobs.enqueueSleepConsolidations(dayKey, startAt, endAt, nowIso); }
  claimNextBackgroundJob(workerId: string, nowIso: string, leaseUntilIso: string) { return this.jobs.claimNextBackgroundJob(workerId, nowIso, leaseUntilIso); }
  completeClaimedBackgroundJob(job: ClaimedBackgroundJob, workerId: string, completedAt: string, operation: () => void) { return this.jobs.completeClaimedBackgroundJob(job, workerId, completedAt, operation); }
  failClaimedBackgroundJob(job: ClaimedBackgroundJob, workerId: string, nowIso: string, errorCode: string) { return this.jobs.failClaimedBackgroundJob(job, workerId, nowIso, errorCode); }
  dailyUserMessages(scopeKey: string, startAt: string, endAt: string): readonly DailyUserMessage[] { return this.jobs.dailyUserMessages(scopeKey, startAt, endAt); }
  applySleepOutcome(job: ClaimedBackgroundJob, workerId: string, completedAt: string, outcome: SleepConsolidationOutcome) { return this.jobs.applySleepOutcome(job, workerId, completedAt, outcome); }
  pendingBackgroundJobCount() { return this.jobs.pendingBackgroundJobCount(); }
  close() { this.context.close(); }
}

export function configuredDatabasePath(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return environment.SHANNON_DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}
