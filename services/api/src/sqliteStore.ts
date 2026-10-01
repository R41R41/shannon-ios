import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompanionClock, CompanionStateEvent, CompanionStateSnapshot, CompanionStateStore } from '@shannon/cognition';
import type { BackgroundJobStore, ClaimedBackgroundJob, DailyUserMessage } from './backgroundJobStore.js';
import type { ShannonConversationItem } from './chatModel.js';
import type {
  ConversationStore,
  ConversationThread,
  PlatformTurnPersistenceInput,
  ShannonExperience,
  StoredConversationMessage,
  TurnPersistenceContext,
} from './conversationStore.js';
import type { SleepConsolidationOutcome } from './sleepConsolidation.js';
import type { ActivityItem } from './memoryService.js';
import type { LlmUsageEvent, LlmUsageStore } from './llmUsage.js';
import type {
  RealtimeVoiceAllowanceStatus,
  RealtimeVoiceReservationStore,
  RealtimeVoiceSessionReservation,
  RealtimeVoiceSessionReservationRequest,
} from './realtimeVoice.js';
import type { KnowledgeAnswer, KnowledgeRevision, KnowledgeSource, KnowledgeStore, PersonalityProfile } from './knowledgeStore.js';
import { SQLiteBackgroundJobRepository } from './sqliteBackgroundJobRepository.js';
import { SQLiteCompanionRepository } from './sqliteCompanionRepository.js';
import { SQLiteConversationRepository } from './sqliteConversationRepository.js';
import { SQLiteStoreContext, secureDatabaseFiles } from './sqliteStoreContext.js';
import { SQLiteStoreMigrator } from './sqliteMigrations.js';
import { SQLiteMemorySearchRepository, type MemorySearchHit } from './sqliteMemorySearch.js';
import { SQLiteShannonKnowledgeStore, type ShannonKnowledgeStore } from './sqliteShannonKnowledge.js';
import type { KnowledgeDraft } from '@shannon/cognition';
import { SQLiteMemoryEmbeddingIndex, type MemoryEmbeddingIndex, type PendingEmbeddingSource } from './sqliteMemoryEmbeddings.js';
import { ensureTurnCaptureSchema, type TurnCaptureRecord } from './turnCaptures.js';

const DEFAULT_DATABASE_PATH = resolve(fileURLToPath(new URL('../../../data/shannon.sqlite', import.meta.url)));

export interface PersistedExperienceEvent { sequence: number; id: string; scopeKey: string; type: string; observedAt: string; payload: unknown; }
export interface SQLiteShannonStoreOptions { path: string; now: CompanionClock; maximumModelConversationItems?: number; maximumDisplayedConversationItems?: number; maximumExperiences?: number; }

export class SQLiteShannonStore implements CompanionStateStore, ConversationStore, BackgroundJobStore, KnowledgeStore, LlmUsageStore, RealtimeVoiceReservationStore, MemoryEmbeddingIndex, ShannonKnowledgeStore {
  private readonly context: SQLiteStoreContext;
  private readonly companion: SQLiteCompanionRepository;
  private readonly conversations: SQLiteConversationRepository;
  private readonly jobs: SQLiteBackgroundJobRepository;
  private readonly memorySearch: SQLiteMemorySearchRepository;
  private readonly embeddings: SQLiteMemoryEmbeddingIndex;
  private readonly shannonKnowledge: SQLiteShannonKnowledgeStore;

  constructor(options: SQLiteShannonStoreOptions) {
    this.context = new SQLiteStoreContext(options);
    this.companion = new SQLiteCompanionRepository(this.context);
    this.conversations = new SQLiteConversationRepository(this.context);
    this.jobs = new SQLiteBackgroundJobRepository(this.context, this.companion);
    new SQLiteStoreMigrator(this.context, this.companion).migrate();
    ensureTurnCaptureSchema(this.context.database);
    this.memorySearch = new SQLiteMemorySearchRepository(this.context.database);
    this.embeddings = new SQLiteMemoryEmbeddingIndex(this.context.database);
    this.shannonKnowledge = new SQLiteShannonKnowledgeStore(this.context.database, operation => this.context.transaction(operation));
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
  recordLlmUsage(event: LlmUsageEvent) { return this.companion.recordLlmUsage(event); }
  backgroundLlmCostUsd(monthKey: string) { return this.companion.backgroundLlmCostUsd(monthKey); }
  backgroundLlmCostUsdForDay(dayKey: string) { return this.companion.backgroundLlmCostUsdForDay(dayKey); }
  voiceLlmCostUsdForDay(scopeKey: string, dayKey: string) { return this.companion.voiceLlmCostUsdForDay(scopeKey, dayKey); }
  reserveRealtimeVoiceSession(request: RealtimeVoiceSessionReservationRequest): RealtimeVoiceSessionReservation | null { return this.companion.reserveRealtimeVoiceSession(request); }
  releaseRealtimeVoiceSessionReservation(reservationId: string) { return this.companion.releaseRealtimeVoiceSessionReservation(reservationId); }
  realtimeVoiceReservedSecondsForDay(scopeKey: string, dayKey: string) { return this.companion.realtimeVoiceReservedSecondsForDay(scopeKey, dayKey); }
  realtimeVoiceAllowanceStatus(scopeKey: string, dayKey: string, baseAllowanceSeconds: number, maximumAllowanceSeconds?: number): RealtimeVoiceAllowanceStatus {
    return this.companion.realtimeVoiceAllowanceStatus(scopeKey, dayKey, baseAllowanceSeconds, maximumAllowanceSeconds);
  }
  extendRealtimeVoiceAllowance(scopeKey: string, dayKey: string, baseAllowanceSeconds: number, additionalSeconds: number, maximumAllowanceSeconds: number, updatedAt: string): RealtimeVoiceAllowanceStatus | null {
    return this.companion.extendRealtimeVoiceAllowance(
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
