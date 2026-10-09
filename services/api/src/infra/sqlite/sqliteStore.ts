import { SQLiteTaskExperiences } from '../../mind/memory/store/taskExperiences.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { CompanionClock, CompanionStateEvent, CompanionStateSnapshot, CompanionStateStore, ShannonEmotionTiming, MemoryAudience } from '@shannon/cognition';
import type { FcaAffectEvidence } from '../../mind/emotion/emotionPorts.js';
import { ownerSpoke } from '@shannon/cognition';
import type { BackgroundJobStore, ClaimedBackgroundJob, DailyUserMessage } from '../../mind/sleep/store/backgroundJobStore.js';
import type { ShannonConversationItem } from '../models/chatModel.js';
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
import type { LlmUsageEvent, LlmUsageStore } from '../models/llmUsage.js';
import type {
  RealtimeVoiceAllowanceStatus,
  RealtimeVoiceReservationStore,
  RealtimeVoiceSessionReservation,
  RealtimeVoiceSessionReservationRequest,
} from '../../surfaces/voice/realtimeVoice.js';
import type { KnowledgeAnswer, KnowledgeRevision, KnowledgeSource, KnowledgeStore, PersonalityProfile } from '../../mind/memory/store/knowledgeStore.js';
import type { LayeredIdentityPrompt } from '../../mind/memory/identityPrompt.js';
import { SQLiteBackgroundJobRepository } from './sqliteBackgroundJobRepository.js';
import { SQLiteCompanionRepository } from './sqliteCompanionRepository.js';
import { ensureSummaryLineageSchema, SQLiteConversationRepository } from './sqliteConversationRepository.js';
import { SQLiteStoreContext, secureDatabaseFiles } from './sqliteStoreContext.js';
import { SQLiteStoreMigrator } from './sqliteMigrations.js';
import { SQLiteMemorySearchRepository, type MemorySearchHit, type MemorySearchOptions } from '../../mind/memory/store/sqliteMemorySearch.js';
import { SQLiteShannonKnowledgeStore, type ShannonKnowledgeStore } from '../../mind/memory/store/sqliteShannonKnowledge.js';
import type { KnowledgeDraft } from '@shannon/cognition';
import { SQLiteMemoryEmbeddingIndex, type MemoryEmbeddingIndex, type PendingEmbeddingSource } from '../../mind/memory/store/sqliteMemoryEmbeddings.js';
import { ensureTurnCaptureSchema, type TurnCaptureRecord } from '../../mind/memory/store/turnCaptures.js';
import { ensureReplaySummarySchema, ensureReplaySummaryTemplateColumns, selectRecentMessages, selectReplaySummary, selectThreadOfTurn, upsertReplaySummary } from '../../mind/memory/store/sqliteReplaySummary.js';
import { deleteToolTraces, ensureToolTraceSchema, insertToolTrace, pruneToolTraces, selectToolTraceScopes, selectToolTraces, toolTraceRetentionBoundary } from '../../mind/tools/store/sqliteToolTraces.js';
import type { ToolTraceRecord } from '../../mind/tools/shannonToolTrace.js';
import type { ReplaySummaryRecord } from '../../mind/memory/store/conversationStore.js';
import { SQLiteImpressionStore } from '../../mind/memory/store/sqliteImpressions.js';
import { ensureMoodHistorySchema, pruneMoodHistory, recordMoodPoint } from '../../mind/emotion/store/moodHistory.js';
import { SQLiteRealtimeVoiceRepository } from './sqliteRealtimeVoiceRepository.js';
import { moodHistoryRecording, type MoodHistoryRecording } from '../../contracts/moodHistoryContract.js';
import { PredictionShadow, predictionShadowEnabled } from '../../mind/prediction/store/predictionShadow.js';
import { DecisionTraces, decisionTracesEnabled } from '../../mind/inhibition/decisionTraces.js';
import { jevUsageRow } from '../models/jev/jevUsage.js';
import { configuredSkillBudgetUsd } from '../models/llmUsage.js';
import { skillSleepUsageRow } from '../../mind/memory/store/sqliteSkillSleepUsage.js';
import { PredictionLedger, predictionLedgerEnabled } from '../../mind/learning/predictionLedger.js';
import { ChoiceLedger, choiceLedgerEnabled } from '../../mind/learning/choiceLedger.js';
import { ValueVersions } from '../../mind/learning/valueTable.js';
import { serverEnvironment } from '../config/serverEnvironment.js';
import type { SQLiteMemoryOutbox } from '../../mind/memory/store/memoryOutboxStore.js';
import type { MemoryProposer } from '../../mind/memory/memoryProposer.js';
import { SQLitePeopleMemoryStore } from '../../mind/memory/store/peopleMemoryStore.js';
import type { SQLitePersonFacts } from '../../mind/memory/store/personFactsStore.js';
import type { SQLiteTrustLedger } from '../../mind/memory/store/trustLedgerStore.js';
import type { StoreMemoryParts } from './storeMemoryParts.js';
import { scrubOutboxFor } from '../../mind/memory/store/outboxScrub.js';
import type { SelfInterestMemory } from '../../mind/self/selfPorts.js';

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
  /** Decision traces (Syzygy ADR-0008 stage 1). Absent: `SHANNON_DECISION_TRACES`; never with `leavesMoodHistory`. */
  decisionTraces?: boolean;
  /** The prediction ledger (Syzygy ADR-0008 stage 1). Absent: `SHANNON_PREDICTION_LEDGER` and its implications; never with `leavesMoodHistory`. */
  predictionLedger?: boolean;
  /** The choice ledger (Syzygy ADR-0008 stage 1). Absent: `SHANNON_CHOICE_LEDGER`; never with `leavesMoodHistory`. */
  choiceLedger?: boolean;
  /** When the cognition ledger's writes run (traces, predictions). Absent: `setImmediate`. Tests may pass one that runs at once. */
  cognitionDefer?: (task: () => void) => void;
  /**
   * The memory outbox on this connection (Syzygy ADR-0008 stage 3, F5): its tables, the proposals of this store's own writers
   * (the sleep batch) and the writer's targets. Absent or false: nothing of it, every table as it was (the entries pass
   * `mindSwitches(environment).memoryOutbox`).
   */
  memoryOutbox?: boolean;
  /** Told after each proposal of this connection (the in-process writer drains then). */
  memoryNotify?: () => void;
  /**
   * Structured compaction (Syzygy ADR-0008 stage 3, F7): the replay summary keeps its template and the raw range it covers in
   * three additive columns. Absent or false: the table as it was (the entries pass `mindSwitches(environment).structuredCompaction`).
   */
  structuredCompaction?: boolean;
  /**
   * People facts (Syzygy ADR-0008 stage 3, F6): `temporal` adds the validity columns of `person_memory_items` (with their
   * backfill) and her impressions' temporal fields; `identity` the identity suggestions and the turns' speakers. Absent: nothing.
   */
  peopleFacts?: { temporal: boolean; identity: boolean };
  /** The trust ledger's table (F6; inert: its parameters are unset). Absent or false: no table. */
  trustLedger?: boolean;
  /**
   * The modules of those parts (`storeMemoryParts.ts`), handed by wiring with any of them switched on, so that this store does
   * not load them otherwise. A part switched on without them is refused.
   */
  memoryParts?: StoreMemoryParts;
  /** Stage 5 self interests share the existing memory writer; false/absent opens no supplementary-self schema. */
  stage5?: boolean;
}

function wiredParts(options: SQLiteShannonStoreOptions): StoreMemoryParts {
  if (!options.memoryParts) throw new Error('SQLiteShannonStore: a stage 3 memory part is switched on without memoryParts (stage3StoreOptions)');
  return options.memoryParts;
}

export class SQLiteShannonStore implements CompanionStateStore, ConversationStore, BackgroundJobStore, KnowledgeStore, LlmUsageStore, RealtimeVoiceReservationStore, MemoryEmbeddingIndex, ShannonKnowledgeStore {
  readSourceVisible?: ConversationStore['readSourceVisible'];
  /** Borrowed by the common Task Hub so admission/proposals share one SQLite transaction. Never close separately. */
  fcaDatabase(): DatabaseSync { return this.context.database; }
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
  private readonly traces: DecisionTraces | null;
  private readonly ledger: PredictionLedger | null;
  private readonly choices: ChoiceLedger | null;
  private readonly values: ValueVersions | null;
  private readonly outbox: SQLiteMemoryOutbox | null;
  private proposer: MemoryProposer | null = null;
  private sharedPeople: SQLitePeopleMemoryStore | null = null;
  private readonly facts: SQLitePersonFacts | null;
  private readonly trust: SQLiteTrustLedger | null;
  private readonly interestMemory: SelfInterestMemory | null;

  constructor(options: SQLiteShannonStoreOptions) {
    this.context = new SQLiteStoreContext(options);
    const moodHistory = options.leavesMoodHistory ? null : options.moodHistory === undefined ? moodHistoryRecording(serverEnvironment()) : options.moodHistory;
    // After each write of her state, a point of her mood from the state as written, at the instant it was reduced at, and the
    // prediction shadow's tap on the same write (ADR-0006 stage 1); neither changes the state.
    const shadowOn = !options.leavesMoodHistory && (options.predictionShadow ?? predictionShadowEnabled(serverEnvironment()));
    // Syzygy ADR-0008 stage 1: the prediction ledger, its daily maintenance and its forgetting after each committed state write.
    const ledgerOn = !options.leavesMoodHistory && (options.predictionLedger ?? predictionLedgerEnabled(serverEnvironment()));
    this.shadow = shadowOn ? new PredictionShadow({
      database: this.context.database, createsSchema: true, timing: () => this.context.emotionTiming(),
      // After the response and after the caller's transaction: no turn, touch or worker waits for the shadow.
      defer: options.predictionShadowDefer ?? (task => { setImmediate(task); }),
    }) : null;
    this.ledger = ledgerOn ? new PredictionLedger({
      database: this.context.database, createsSchema: true, ...(options.cognitionDefer ? { defer: options.cognitionDefer } : {}),
    }) : null;
    const choicesOn = !options.leavesMoodHistory && (options.choiceLedger ?? choiceLedgerEnabled(serverEnvironment()));
    this.choices = choicesOn ? new ChoiceLedger({
      database: this.context.database, createsSchema: true, ...(options.cognitionDefer ? { defer: options.cognitionDefer } : {}),
    }) : null;
    // The value table: a choice reads V from its active version (step 5).
    this.values = choicesOn ? new ValueVersions({ database: this.context.database, createsSchema: true }) : null;
    if (this.values) this.choices!.readValuesFrom(this.values.reader);
    this.companion = new SQLiteCompanionRepository(this.context, (scopeKey, state, at, event) => {
      recordMoodPoint(this.context.database, moodHistory, scopeKey, state, at, this.context.emotionTiming());
      this.shadow?.stateWritten(scopeKey, state, at, event);
      this.ledger?.stateWritten(scopeKey, state, at, event);
    });
    this.realtimeVoice = new SQLiteRealtimeVoiceRepository(this.context);
    this.conversations = new SQLiteConversationRepository(this.context);
    this.jobs = new SQLiteBackgroundJobRepository(this.context, this.companion, () => this.memoryProposals());
    new SQLiteStoreMigrator(this.context, this.companion).migrate();
    ensureTurnCaptureSchema(this.context.database);
    ensureSummaryLineageSchema(this.context.database);
    ensureReplaySummarySchema(this.context.database);
    if (options.structuredCompaction) ensureReplaySummaryTemplateColumns(this.context.database);
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
    // Syzygy ADR-0008 stage 1: one content-free trace per decision, kept 30 days; switched off, no table and no row.
    const tracesOn = !options.leavesMoodHistory && (options.decisionTraces ?? decisionTracesEnabled(serverEnvironment()));
    this.traces = tracesOn ? new DecisionTraces({
      database: this.context.database, createsSchema: true, now: () => this.context.now(), ...(options.cognitionDefer ? { defer: options.cognitionDefer } : {}),
    }) : null;
    // Syzygy ADR-0008 stage 3 (F5): the memory outbox, only while it is switched on.
    this.outbox = options.memoryOutbox ? wiredParts(options).outbox(this.context.database) : null;
    // F6: people facts on the people tables of this connection (made here first), and the inert trust ledger; only while switched on.
    const facts = options.peopleFacts && (options.peopleFacts.temporal || options.peopleFacts.identity) ? options.peopleFacts : null;
    if (facts) this.peopleMemoryOnConnection();
    this.facts = facts ? wiredParts(options).facts(this.context.database, facts) : null;
    this.trust = options.trustLedger ? wiredParts(options).trust(this.context.database) : null;
    const interestFactory = options.stage5 && this.outbox ? wiredParts(options).selfInterests : null;
    if (options.stage5 && this.outbox && !interestFactory) throw new Error('SELF_INTEREST_PARTS_REQUIRED');
    this.interestMemory = interestFactory ? interestFactory(this.context.database, {
      snapshot: scope => this.snapshot(scope),
      evidence: (scope, refs) => this.experiencesById(scope, refs).map(row => ({ id: row.id, text: row.userMessage,
        disclosure: row.disclosure, owner: ownerSpoke(row.disclosure) })),
    }) : null;
    secureDatabaseFiles(options.path);
  }

  /** The memory outbox on this connection (ADR-0008 stage 3), or null while it is switched off. */
  memoryOutbox(): SQLiteMemoryOutbox | null { return this.outbox; }
  /** Supplementary self on the memory writer's connection; no separate write authority. */
  selfInterests(): SelfInterestMemory | null { return this.interestMemory; }
  selfInterestProjection(scope: string, audience: MemoryAudience, openOnly=false): string { return this.interestMemory?.projection(scope,audience,openOnly) ?? ''; }
  /** Wiring composes the learning service on this connection; it owns no additional connection or writer. */
  composeLearning<T>(compose: (connection: DatabaseSync) => T): T { return compose(this.context.database); }
  /** Proposals appended on this connection (so a proposal inside this store's transaction is part of it), or null while off. */
  memoryProposals(): MemoryProposer | null {
    if (!this.outbox) return null;
    this.proposer ??= wiredParts(this.context.options).proposer(this.outbox, { now: () => this.context.now(), notify: () => this.context.options.memoryNotify?.(), log: line => console.log(line) });
    return this.proposer;
  }
  /** People memory on this connection (the memory writer's targets and people facts share it); made when first asked for. */
  peopleMemoryOnConnection(): SQLitePeopleMemoryStore {
    this.sharedPeople ??= new SQLitePeopleMemoryStore(this.context.database);
    return this.sharedPeople;
  }
  /** People facts with time, identity suggestions and the turns' speakers (F6), or null while they are switched off. */
  personFacts(): SQLitePersonFacts | null { return this.facts; }
  /** The inert trust ledger (F6), or null while it is switched off. */
  trustLedger(): SQLiteTrustLedger | null { return this.trust; }
  /** The owner's profile and its prompt written again from the state as it is (what the sleep batch does after it learned). */
  refreshProfile(scopeKey: string): void {
    this.context.transaction(() => {
      this.companion.writePersonalityProfile(scopeKey, this.companion.snapshot(scopeKey), this.context.now());
      this.companion.writePromptProjection(scopeKey, this.companion.snapshot(scopeKey));
    });
  }

  snapshot(scopeKey: string) { return this.companion.snapshot(scopeKey); }
  applyFcaAffectEvidence(scope: string, evidence: FcaAffectEvidence, visible: () => boolean) { return this.companion.applyFcaAffectEvidence(scope, evidence, visible); }
  fcaAffectReceipts(scope: string, eventIds?: readonly string[]) { return this.companion.fcaAffectReceipts(scope, eventIds); }
  apply(scopeKey: string, event: CompanionStateEvent) {
    const result = this.companion.apply(scopeKey, event);
    // Syzygy ADR-0008 stage 3 (review H2): what the owner forgot leaves nothing in the memory outbox (only while it is on).
    if (this.outbox) {
      const forgotten = (event.type === 'memory-transaction' ? event.events : [event]).flatMap(item =>
        item.type === 'memory-control-upserted' && item.control.status !== 'active' ? [item.control.memoryId] : []);
      if (forgotten.length) scrubOutboxFor(this.context.database, scopeKey, { memoryIds: forgotten }, 'forgotten', this.context.now());
    }
    return result;
  }
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
  llmUsageSummary(scopeKey: string, monthKey: string) {
    // Jev's calls come from the decision traces, never from `llm_usage_events` (the transcription cap counts its `voice` lane).
    const jev = this.traces ? jevUsageRow(this.traces.jevMonth(scopeKey, monthKey)) : null;
    const rows = this.companion.llmUsageSummary(scopeKey, monthKey);
    // Review R2: the skill sleep's own spend (every scope, read-only), month to date against its own budget.
    const skills = skillSleepUsageRow(this.context.database, monthKey, configuredSkillBudgetUsd());
    return jev || skills ? Object.freeze([...rows, ...(jev ? [jev] : []), ...(skills ? [skills] : [])]) : rows;
  }

  listThreads(scopeKey: string): readonly ConversationThread[] { return this.conversations.listThreads(scopeKey); }
  threadId(scopeKey: string, threadId?: string) { return this.conversations.threadId(scopeKey, threadId); }
  createThread(scopeKey: string, title?: string) { return this.conversations.createThread(scopeKey, title); }
  renameThread(scopeKey: string, threadId: string, title: string) { return this.conversations.renameThread(scopeKey, threadId, title); }
  needsAutomaticThreadTitle(scopeKey: string, threadId: string) { return this.conversations.needsAutomaticThreadTitle(scopeKey, threadId); }
  archiveThread(scopeKey: string, threadId: string) { return this.conversations.archiveThread(scopeKey, threadId); }
  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[] { return this.conversations.history(scopeKey, threadId); }
  threadSummary(scopeKey: string, threadId: string) { return this.conversations.threadSummary(scopeKey, threadId); }
  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[] { return this.conversations.conversationHistory(scopeKey, threadId); }
  assistantMessage(scopeKey: string, threadId: string, sourceOrMessageId: string) { return this.conversations.assistantMessage(scopeKey,threadId,sourceOrMessageId); }
  appendNoteOnce(scopeKey: string, threadId: string, messageId: string, content: string, observedAt: string, noteKind: string, ownerAlone?: boolean) { return this.conversations.appendNoteOnce(scopeKey,threadId,messageId,content,observedAt,noteKind,ownerAlone); }
  taskExperiences(): SQLiteTaskExperiences { return new SQLiteTaskExperiences(this.context.database); }
  experienceCandidates(scopeKey: string): readonly ShannonExperience[] { return this.conversations.experienceCandidates(scopeKey); }
  searchMemory(scopeKey: string, text: string, limit?: number, options?: MemorySearchOptions): readonly MemorySearchHit[] { return this.memorySearch.searchMemory(scopeKey, text, limit, options); }
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
  hasReadSourceProvenance(scopeKey: string) { return this.conversations.hasReadSourceProvenance(scopeKey); }
  recentMessages(scopeKey: string, threadId: string, limit: number) { return selectRecentMessages(this.context.database, scopeKey, this.conversations.threadId(scopeKey, threadId), limit); }
  replaySummary(scopeKey: string, threadId: string) { return selectReplaySummary(this.context.database, scopeKey, threadId, this.context.options.structuredCompaction === true); }
  saveReplaySummary(scopeKey: string, threadId: string, record: ReplaySummaryRecord) {
    this.context.transaction(() => upsertReplaySummary(this.context.database, scopeKey, threadId, record, this.context.options.structuredCompaction === true));
  }
  threadOfTurn(scopeKey: string, experienceId: string) { return selectThreadOfTurn(this.context.database, scopeKey, experienceId); }
  saveToolTrace(scopeKey: string, record: ToolTraceRecord) { this.context.transaction(() => insertToolTrace(this.context.database, scopeKey, record)); }
  toolTraces(scopeKey: string, threadId: string | null, query: { turnIds?: readonly string[]; since?: string }) { return selectToolTraces(this.context.database, scopeKey, threadId, query); }
  deleteToolTraces(scopeKey: string, turnIds: readonly string[]) { if (turnIds.length) this.context.transaction(() => deleteToolTraces(this.context.database, scopeKey, turnIds)); }
  toolTraceScopes() { return selectToolTraceScopes(this.context.database); }
  pruneToolTraces(before: string) { this.context.transaction(() => pruneToolTraces(this.context.database, before)); }
  impressionStore() { return this.personImpressions; }
  /** The value table's versions on this store's connection (Syzygy ADR-0008), or null while the choice ledger is switched off. */
  valueVersions(): ValueVersions | null { return this.values; }
  /** The choice ledger on this store's connection (Syzygy ADR-0008), or null while it is switched off. */
  choiceLedger(): ChoiceLedger | null { return this.choices; }
  /** The prediction ledger on this store's connection (Syzygy ADR-0008), or null while it is switched off. */
  predictionLedger(): PredictionLedger | null { return this.ledger; }
  /** Decision traces on this store's connection (Syzygy ADR-0008), or null while they are switched off. */
  decisionTraces(): DecisionTraces | null { return this.traces; }
  /** The prediction shadow on this store's connection, or null while it is switched off. */
  predictionShadow(): PredictionShadow | null { return this.shadow; }
  events(scopeKey: string): readonly PersistedExperienceEvent[] { return this.conversations.events(scopeKey); }
  activityTimeline(scopeKey: string): readonly ActivityItem[] { return this.conversations.activityTimeline(scopeKey); }

  enqueueTurnRefinement(scopeKey: string, experienceId: string, userMessage: string, observedAt: string, timeZone?: string) { return this.jobs.enqueueTurnRefinement(scopeKey, experienceId, userMessage, observedAt, timeZone); }
  recoverUnqueuedTurnRefinements(nowIso: string) { return this.jobs.recoverUnqueuedTurnRefinements(nowIso); }
  enqueueSleepConsolidations(dayKey: string, startAt: string, endAt: string, nowIso: string) { return this.jobs.enqueueSleepConsolidations(dayKey, startAt, endAt, nowIso); }
  claimNextBackgroundJob(workerId: string, nowIso: string, leaseUntilIso: string, excludedSleepScope?: string) { return this.jobs.claimNextBackgroundJob(workerId, nowIso, leaseUntilIso, excludedSleepScope); }
  completeClaimedBackgroundJob(job: ClaimedBackgroundJob, workerId: string, completedAt: string, operation: () => void) { return this.jobs.completeClaimedBackgroundJob(job, workerId, completedAt, operation); }
  failClaimedBackgroundJob(job: ClaimedBackgroundJob, workerId: string, nowIso: string, errorCode: string) { return this.jobs.failClaimedBackgroundJob(job, workerId, nowIso, errorCode); }
  dailyUserMessages(scopeKey: string, startAt: string, endAt: string): readonly DailyUserMessage[] { return this.jobs.dailyUserMessages(scopeKey, startAt, endAt); }
  applySleepOutcome(job: ClaimedBackgroundJob, workerId: string, completedAt: string, outcome: SleepConsolidationOutcome, finishJob = true) { return this.jobs.applySleepOutcome(job, workerId, completedAt, outcome, finishJob); }
  pendingBackgroundJobCount() { return this.jobs.pendingBackgroundJobCount(); }
  close() { this.outbox?.meter?.flush(); this.traces?.flushLockWaits(); this.ledger?.flushLockWaits(); this.choices?.flushLockWaits(); this.values?.flushLockWaits(); this.context.close(); }
}

export function configuredDatabasePath(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): string {
  return environment.SHANNON_DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}
