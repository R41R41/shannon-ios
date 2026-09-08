import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createInitialCompanionState,
  assembleShannonSystemPrompt,
  reduceCompanionState,
  restoreCompanionState,
  type CompanionClock,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type ShannonMessageEmotion,
} from '@shannon/cognition';
import type {
  BackgroundJobPayload,
  BackgroundJobStore,
  ClaimedBackgroundJob,
  DailyUserMessage,
} from './backgroundJobStore.js';
import type { ShannonConversationItem, ShannonGeneratedArtifact } from './chatModel.js';
import type { ShannonTaskDecision } from './chatModel.js';
import type {
  ConversationStore,
  ConversationThread,
  ShannonExperience,
  StoredConversationMessage,
  TurnPersistenceContext,
} from './conversationStore.js';
import type { SleepConsolidationOutcome } from './sleepConsolidation.js';
import type { ActivityItem } from './memoryService.js';
import type { LlmUsageEvent, LlmUsageStore } from './llmUsage.js';
import {
  DEFAULT_QUESTION_DEFINITIONS,
  classifyQuestion,
  type KnowledgeAnswer,
  type KnowledgeRevision,
  type KnowledgeSource,
  type KnowledgeStore,
  type PersonalityProfile,
} from './knowledgeStore.js';
import { migrateAgentTasks } from './agentTaskStore.js';
import { DEFAULT_THREAD_TITLE, initialThreadTitle } from './threadTitle.js';

const SCHEMA_VERSION = 9;
const DEFAULT_DATABASE_PATH = resolve(fileURLToPath(new URL('../../../data/shannon.sqlite', import.meta.url)));

interface StateRow {
  snapshot_json: string;
}

interface MessageRow {
  message_id: string;
  thread_id: string;
  role: string;
  content: string;
  observed_at: string;
  metadata_json: string | null;
}

interface EventRow {
  sequence: number;
  event_id: string;
  scope_key: string;
  event_type: string;
  observed_at: string;
  payload_json: string;
}

interface BackgroundJobRow {
  job_id: string;
  scope_key: string;
  payload_json: string;
  attempts: number;
}

interface TurnPayload {
  userMessage: string;
  shannonReply: string;
  summary: string;
  capturedStateVersion?: number;
  messageEmotion?: ShannonMessageEmotion;
  taskDecision?: ShannonTaskDecision;
}

interface MessageMetadata {
  stateVersion?: number;
  messageEmotion?: ShannonMessageEmotion;
  taskDecision?: ShannonTaskDecision;
  artifacts?: readonly ShannonGeneratedArtifact[];
}

interface ThreadRow {
  thread_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface KnowledgeAnswerRow {
  answer_id: string;
  question_key: string;
  category: string;
  question: string;
  answer: string;
  confidence: number;
  source: KnowledgeSource;
  confirmed: number;
  updated_at: string;
}

interface KnowledgeEvidenceRow {
  answer_id: string;
  quote: string;
  source: KnowledgeSource;
  observed_at: string;
}

interface KnowledgeRevisionRow {
  revision_id: string;
  answer_id: string;
  previous_answer: string | null;
  next_answer: string;
  reason: string;
  observed_at: string;
}

export interface PersistedExperienceEvent {
  sequence: number;
  id: string;
  scopeKey: string;
  type: string;
  observedAt: string;
  payload: unknown;
}

export interface SQLiteShannonStoreOptions {
  path: string;
  now: CompanionClock;
  maximumModelConversationItems?: number;
  maximumDisplayedConversationItems?: number;
  maximumExperiences?: number;
}

/**
 * Durable adapter only. Cognition remains in packages/cognition; this class
 * stores immutable snapshots, conversation messages, and append-only events.
 */
export class SQLiteShannonStore implements CompanionStateStore, ConversationStore, BackgroundJobStore, KnowledgeStore, LlmUsageStore {
  private readonly database: DatabaseSync;
  private readonly maximumModelConversationItems: number;
  private readonly maximumDisplayedConversationItems: number;
  private readonly maximumExperiences: number;
  private readonly defaultThreadCache = new Map<string, string>();

  constructor(private readonly options: SQLiteShannonStoreOptions) {
    if (!options.path.trim()) throw new Error('SHANNON_DATABASE_PATH is required');
    this.maximumModelConversationItems = positiveInteger(options.maximumModelConversationItems ?? 20, 200);
    this.maximumDisplayedConversationItems = positiveInteger(options.maximumDisplayedConversationItems ?? 200, 2_000);
    this.maximumExperiences = positiveInteger(options.maximumExperiences ?? 1_000, 10_000);
    prepareDatabaseLocation(options.path);
    this.database = new DatabaseSync(options.path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
    secureDatabaseFiles(options.path);
  }

  snapshot(scopeKey: string): CompanionStateSnapshot {
    const row = this.database.prepare(`
      SELECT snapshot_json
      FROM companion_states
      WHERE scope_key = ?
    `).get(scopeKey) as unknown as StateRow | undefined;
    if (row) return parseSnapshot(row.snapshot_json, scopeKey, this.options.now());

    const initial = createInitialCompanionState(scopeKey, this.options.now());
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO companion_states (scope_key, version, updated_at, snapshot_json)
        VALUES (?, ?, ?, ?)
      `).run(scopeKey, initial.version, initial.updatedAt, JSON.stringify(initial));
      this.insertEvent(scopeKey, 'state.initialized', initial.updatedAt, {
        toVersion: initial.version,
      });
    });
    return initial;
  }

  apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot {
    const current = this.snapshot(scopeKey);
    const next = reduceCompanionState(current, event, this.options.now());
    if (next === current) return current;
    this.transaction(() => {
      this.database.prepare(`
        UPDATE companion_states
        SET version = ?, updated_at = ?, snapshot_json = ?
        WHERE scope_key = ?
      `).run(next.version, next.updatedAt, JSON.stringify(next), scopeKey);
      this.insertEvent(scopeKey, `state.${event.type}`, next.updatedAt, {
        event,
        fromVersion: current.version,
        toVersion: next.version,
      });
      if (event.type === 'user-fact-upserted') {
        this.synchronizeFact(scopeKey, event.fact, event.source ?? 'inference');
        this.insertActivity(scopeKey, 'knowledge', '知識を更新', event.fact.statement, next.updatedAt);
      }
      this.writePromptProjection(scopeKey, next);
    });
    return next;
  }

  synchronizeFact(scopeKey: string, fact: CompanionStateSnapshot['userFacts'][number], source: KnowledgeSource): void {
    const definition = classifyQuestion(fact.statement, fact.id);
    const existing = this.database.prepare(`
      SELECT answer FROM knowledge_answers WHERE answer_id = ? AND scope_key = ?
    `).get(fact.id, scopeKey) as unknown as { answer: string } | undefined;
    this.database.prepare(`
      INSERT INTO question_definitions (question_key, category, question, display_order, allows_multiple, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(question_key) DO UPDATE SET
        category = excluded.category,
        question = excluded.question,
        display_order = excluded.display_order
    `).run(definition.key, definition.category, definition.question, definition.order, fact.observedAt);
    if (existing && existing.answer !== fact.statement) {
      this.database.prepare(`
        INSERT INTO knowledge_revisions
          (revision_id, scope_key, answer_id, previous_answer, next_answer, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), scopeKey, fact.id, existing.answer, fact.statement, `${source}から更新`, fact.observedAt);
    }
    this.database.prepare(`
      INSERT INTO knowledge_answers
        (answer_id, scope_key, question_key, answer, confidence, source, confirmed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, answer_id) DO UPDATE SET
        question_key = excluded.question_key,
        answer = excluded.answer,
        confidence = excluded.confidence,
        source = excluded.source,
        confirmed = excluded.confirmed,
        updated_at = excluded.updated_at
      WHERE knowledge_answers.scope_key = excluded.scope_key
    `).run(
      fact.id,
      scopeKey,
      definition.key,
      fact.statement,
      fact.confidence,
      source,
      source === 'user' || source === 'conversation' ? 1 : 0,
      fact.observedAt,
    );
    if (fact.evidence) {
      this.database.prepare(`
        INSERT OR IGNORE INTO knowledge_evidence
          (evidence_id, scope_key, answer_id, quote, source, observed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), scopeKey, fact.id, fact.evidence, source, fact.observedAt);
    }
  }

  correctKnowledge(scopeKey: string, answerId: string, answer: string, observedAt: string): void {
    const current = this.database.prepare(`
      SELECT answer FROM knowledge_answers WHERE scope_key = ? AND answer_id = ?
    `).get(scopeKey, answerId) as unknown as { answer: string } | undefined;
    if (!current) return;
    if (current.answer !== answer) {
      this.database.prepare(`
        INSERT INTO knowledge_revisions
          (revision_id, scope_key, answer_id, previous_answer, next_answer, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, 'ユーザーが手動で訂正', ?)
      `).run(randomUUID(), scopeKey, answerId, current.answer, answer, observedAt);
    }
    this.database.prepare(`
      UPDATE knowledge_answers
      SET answer = ?, confidence = 1, source = 'user', confirmed = 1, updated_at = ?
      WHERE scope_key = ? AND answer_id = ?
    `).run(answer, observedAt, scopeKey, answerId);
    this.database.prepare(`
      INSERT INTO knowledge_evidence
        (evidence_id, scope_key, answer_id, quote, source, observed_at)
      VALUES (?, ?, ?, ?, 'user', ?)
    `).run(randomUUID(), scopeKey, answerId, answer, observedAt);
    this.insertActivity(scopeKey, 'knowledge', '知識を手動訂正', answer, observedAt, { answerId });
    this.writePromptProjection(scopeKey, this.snapshot(scopeKey));
  }

  knowledgeAnswers(scopeKey: string): readonly KnowledgeAnswer[] {
    const rows = this.database.prepare(`
      SELECT a.answer_id, a.question_key, q.category, q.question, a.answer,
             a.confidence, a.source, a.confirmed, a.updated_at
      FROM knowledge_answers a
      JOIN question_definitions q ON q.question_key = a.question_key
      WHERE a.scope_key = ?
      ORDER BY q.display_order ASC, a.updated_at DESC
    `).all(scopeKey) as unknown as KnowledgeAnswerRow[];
    const evidenceRows = this.database.prepare(`
      SELECT answer_id, quote, source, observed_at
      FROM knowledge_evidence WHERE scope_key = ? ORDER BY observed_at DESC
    `).all(scopeKey) as unknown as KnowledgeEvidenceRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      answerId: row.answer_id,
      questionKey: row.question_key,
      category: row.category,
      question: row.question,
      answer: row.answer,
      confidence: Number(row.confidence),
      source: row.source,
      confirmed: Boolean(row.confirmed),
      updatedAt: row.updated_at,
      evidence: Object.freeze(evidenceRows.filter(item => item.answer_id === row.answer_id).map(item => Object.freeze({
        quote: item.quote,
        source: item.source,
        observedAt: item.observed_at,
      }))),
    })));
  }

  knowledgeRevisions(scopeKey: string, answerId?: string): readonly KnowledgeRevision[] {
    const rows = (answerId
      ? this.database.prepare(`
          SELECT revision_id, answer_id, previous_answer, next_answer, reason, observed_at
          FROM knowledge_revisions WHERE scope_key = ? AND answer_id = ? ORDER BY observed_at DESC
        `).all(scopeKey, answerId)
      : this.database.prepare(`
          SELECT revision_id, answer_id, previous_answer, next_answer, reason, observed_at
          FROM knowledge_revisions WHERE scope_key = ? ORDER BY observed_at DESC
        `).all(scopeKey)) as unknown as KnowledgeRevisionRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      revisionId: row.revision_id,
      answerId: row.answer_id,
      previousAnswer: row.previous_answer,
      nextAnswer: row.next_answer,
      reason: row.reason,
      observedAt: row.observed_at,
    })));
  }

  personalityProfile(scopeKey: string): PersonalityProfile | null {
    const row = this.database.prepare(`
      SELECT version, analysis, created_at
      FROM personality_profiles
      WHERE scope_key = ? AND active = 1
      ORDER BY version DESC LIMIT 1
    `).get(scopeKey) as unknown as { version: number; analysis: string; created_at: string } | undefined;
    return row ? Object.freeze({ version: Number(row.version), analysis: row.analysis, createdAt: row.created_at }) : null;
  }

  promptProjection(scopeKey: string): string | null {
    const row = this.database.prepare(`
      SELECT content FROM prompt_projections WHERE scope_key = ?
    `).get(scopeKey) as unknown as { content: string } | undefined;
    return row?.content ?? null;
  }

  recordLlmUsage(event: LlmUsageEvent): void {
    this.database.prepare(`
      INSERT INTO llm_usage_events
        (usage_id, scope_key, lane, model, input_tokens, cached_input_tokens,
         output_tokens, total_tokens, estimated_cost_usd, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), event.scopeKey, event.lane, event.model,
      event.inputTokens, event.cachedInputTokens, event.outputTokens,
      event.totalTokens, event.estimatedCostUsd, event.occurredAt,
    );
  }

  backgroundLlmCostUsd(monthKey: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM llm_usage_events
      WHERE lane = 'sleep' AND substr(occurred_at, 1, 7) = ?
    `).get(monthKey) as unknown as { cost: number };
    return Number(row.cost);
  }

  backgroundLlmCostUsdForDay(dayKey: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM llm_usage_events
      WHERE lane = 'sleep' AND date(datetime(occurred_at, '+9 hours')) = ?
    `).get(dayKey) as unknown as { cost: number };
    return Number(row.cost);
  }

  voiceLlmCostUsdForDay(scopeKey: string, dayKey: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM llm_usage_events
      WHERE scope_key = ? AND lane = 'voice'
        AND date(datetime(occurred_at, '+9 hours')) = ?
    `).get(scopeKey, dayKey) as unknown as { cost: number };
    return Number(row.cost);
  }

  llmUsageSummary(scopeKey: string, monthKey: string): readonly {
    lane: LlmUsageEvent['lane']; calls: number; inputTokens: number; cachedInputTokens: number;
    outputTokens: number; totalTokens: number; estimatedCostUsd: number;
  }[] {
    const rows = this.database.prepare(`
      SELECT lane, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
      FROM llm_usage_events
      WHERE scope_key = ? AND substr(occurred_at, 1, 7) = ?
      GROUP BY lane ORDER BY lane
    `).all(scopeKey, monthKey) as unknown as Array<Record<string, unknown>>;
    return Object.freeze(rows.map(row => Object.freeze({
      lane: String(row.lane) as LlmUsageEvent['lane'], calls: Number(row.calls),
      inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens),
      estimatedCostUsd: Number(row.estimated_cost_usd),
    })));
  }

  private writePromptProjection(scopeKey: string, state: CompanionStateSnapshot): void {
    const personality = this.personalityProfile(scopeKey);
    const knowledge = this.knowledgeAnswers(scopeKey).slice(0, 80);
    const sections = [assembleShannonSystemPrompt(state)];
    if (knowledge.length) {
      sections.push(`[User knowledge]\n${knowledge.map(item => `- ${item.question}: ${item.answer} (confidence ${item.confidence.toFixed(2)}, source ${item.source})`).join('\n')}`);
    }
    if (personality) sections.push(`[Personality analysis v${personality.version}]\n${personality.analysis}`);
    const content = sections.join('\n\n');
    this.database.prepare(`
      INSERT INTO prompt_projections (scope_key, state_version, content, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        state_version = excluded.state_version,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(scopeKey, state.version, content, state.updatedAt);
  }

  private insertActivity(
    scopeKey: string,
    type: string,
    title: string,
    detail: string | null,
    occurredAt: string,
    metadata: unknown = {},
  ): void {
    this.database.prepare(`
      INSERT INTO activity_events
        (activity_id, scope_key, activity_type, title, detail, occurred_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scopeKey, type, title, detail, occurredAt, JSON.stringify(metadata));
  }

  private writePersonalityProfile(scopeKey: string, state: CompanionStateSnapshot, createdAt: string): void {
    const previous = this.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM personality_profiles WHERE scope_key = ?
    `).get(scopeKey) as unknown as { version: number };
    const facts = state.userFacts.slice(0, 6).map(item => item.statement);
    const relationships = state.relationships.slice(0, 4).map(item => item.statement);
    const analysis = [
      facts.length ? `把握している特徴: ${facts.join('、')}` : '本人について断定できる特徴はまだ少ない。',
      relationships.length ? `好む関わり方: ${relationships.join('、')}` : '好む関わり方はまだ観察中。',
      state.interests.length ? `最近の関心: ${state.interests.slice(0, 8).join('、')}` : '最近の関心はまだ定まっていない。',
    ].join('\n');
    this.database.prepare(`UPDATE personality_profiles SET active = 0 WHERE scope_key = ?`).run(scopeKey);
    this.database.prepare(`
      INSERT INTO personality_profiles
        (profile_id, scope_key, version, analysis, active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(randomUUID(), scopeKey, Number(previous.version) + 1, analysis, createdAt);
  }

  listThreads(scopeKey: string): readonly ConversationThread[] {
    const rows = this.database.prepare(`
      SELECT thread_id, title, created_at, updated_at,
        (SELECT COUNT(*) FROM conversation_messages cm WHERE cm.scope_key = ct.scope_key AND cm.thread_id = ct.thread_id) AS message_count
      FROM conversation_threads ct
      WHERE ct.scope_key = ? AND ct.archived_at IS NULL
      ORDER BY ct.updated_at DESC, ct.created_at DESC
    `).all(scopeKey) as unknown as ThreadRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      threadId: row.thread_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: Number(row.message_count),
    })));
  }

  threadId(scopeKey: string, threadId?: string): string {
    const preferred = threadId?.trim();
    if (preferred) {
      this.ensureThread(scopeKey, preferred, null);
      this.defaultThreadCache.set(scopeKey, preferred);
      return preferred;
    }
    const cached = this.defaultThreadCache.get(scopeKey);
    if (cached) return cached;

    const threads = this.listThreads(scopeKey);
    if (threads[0]) {
      this.defaultThreadCache.set(scopeKey, threads[0].threadId);
      return threads[0].threadId;
    }
    const created = this.createThread(scopeKey);
    this.defaultThreadCache.set(scopeKey, created);
    return created;
  }

  private ensureThread(scopeKey: string, threadId: string, title: string | null): void {
    const now = this.options.now();
    this.database.prepare(`
      INSERT INTO conversation_threads (thread_id, scope_key, title, title_origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO NOTHING
    `).run(threadId, scopeKey, title?.trim() || DEFAULT_THREAD_TITLE, title?.trim() ? 'manual' : 'pending', now, now);
  }

  createThread(scopeKey: string, title?: string): string {
    const threadId = randomUUID();
    this.ensureThread(scopeKey, threadId, title ?? null);
    return threadId;
  }

  renameThread(scopeKey: string, threadId: string, title: string): boolean {
    const result = this.database.prepare(`
      UPDATE conversation_threads
      SET title = ?, title_origin = 'manual', updated_at = ?
      WHERE scope_key = ? AND thread_id = ? AND archived_at IS NULL
    `).run(title, this.options.now(), scopeKey, threadId);
    return Number(result.changes) > 0;
  }

  needsAutomaticThreadTitle(scopeKey: string, threadId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM conversation_threads
      WHERE scope_key = ? AND thread_id = ? AND title_origin = 'pending' AND archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation_messages WHERE scope_key = ? AND thread_id = ? AND role = 'user'
        )
    `).get(scopeKey, threadId, scopeKey, threadId));
  }

  archiveThread(scopeKey: string, threadId: string): boolean {
    const result = this.database.prepare(`
      UPDATE conversation_threads SET archived_at = ?
      WHERE scope_key = ? AND thread_id = ? AND archived_at IS NULL
    `).run(this.options.now(), scopeKey, threadId);
    if (Number(result.changes) > 0 && this.defaultThreadCache.get(scopeKey) === threadId) {
      this.defaultThreadCache.delete(scopeKey);
    }
    return Number(result.changes) > 0;
  }

  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[] {
    return Object.freeze(this.conversationHistory(scopeKey, threadId)
      .slice(-this.maximumModelConversationItems)
      .map(item => Object.freeze({ role: item.role, content: item.content })));
  }

  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[] {
    const effectiveThreadId = this.threadId(scopeKey, threadId);
    const rows = this.database.prepare(`
      SELECT message_id, thread_id, role, content, observed_at, metadata_json
      FROM (
        SELECT sequence, message_id, thread_id, role, content, observed_at, metadata_json
        FROM conversation_messages
        WHERE scope_key = ? AND thread_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence ASC
    `).all(scopeKey, effectiveThreadId, this.maximumDisplayedConversationItems) as unknown as MessageRow[];
    return Object.freeze(rows.map(row => freezeStoredMessage(row)));
  }

  experienceCandidates(scopeKey: string): readonly ShannonExperience[] {
    const rows = this.database.prepare(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
      FROM experience_events
      WHERE scope_key = ? AND event_type = 'turn.completed'
      ORDER BY sequence DESC
      LIMIT ?
    `).all(scopeKey, this.maximumExperiences) as unknown as EventRow[];
    return Object.freeze(rows.reverse().flatMap(row => {
      const payload = parseTurnPayload(row.payload_json);
      if (!payload) return [];
      return [Object.freeze({
        id: row.event_id,
        userMessage: payload.userMessage,
        shannonReply: payload.shannonReply,
        summary: payload.summary,
        observedAt: row.observed_at,
      })];
    }));
  }

  appendTurn(
    scopeKey: string,
    threadId: string,
    userMessage: string,
    shannonReply: string,
    observedAt: string,
    context?: TurnPersistenceContext,
  ): ShannonExperience {
    const turnId = randomUUID();
    const effectiveThreadId = this.threadId(scopeKey, threadId);
    this.ensureThread(scopeKey, effectiveThreadId, null);
    const summary = summarizeExperience(userMessage, shannonReply);
    const payload: TurnPayload = {
      userMessage,
      shannonReply,
      summary,
      ...(context ? {
        capturedStateVersion: context.capturedStateVersion,
        messageEmotion: context.messageEmotion,
        ...(context.taskDecision ? { taskDecision: context.taskDecision } : {}),
      } : {}),
    };
    this.transaction(() => {
      // Recheck after the model await: a manual edit or another completed turn wins.
      if (this.needsAutomaticThreadTitle(scopeKey, effectiveThreadId)) {
        this.database.prepare(`
          UPDATE conversation_threads SET title = ?, title_origin = 'automatic'
          WHERE scope_key = ? AND thread_id = ? AND title_origin = 'pending' AND archived_at IS NULL
        `).run(initialThreadTitle(context?.threadTitle, userMessage), scopeKey, effectiveThreadId);
      }
      this.database.prepare(`
        UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?
      `).run(observedAt, scopeKey, effectiveThreadId);
      const insert = this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(randomUUID(), scopeKey, effectiveThreadId, turnId, 0, 'user', userMessage, observedAt, null);
      insert.run(
        randomUUID(),
        scopeKey,
        effectiveThreadId,
        turnId,
        1,
        'assistant',
        shannonReply,
        observedAt,
        context ? JSON.stringify({
          stateVersion: context.capturedStateVersion,
          messageEmotion: context.messageEmotion,
          ...(context.taskDecision ? { taskDecision: context.taskDecision } : {}),
          ...(context.artifacts?.length ? { artifacts: context.artifacts } : {}),
        } satisfies MessageMetadata) : null,
      );
      this.insertEvent(scopeKey, 'turn.completed', observedAt, payload, turnId);
      this.insertActivity(scopeKey, 'conversation', 'トーク', summary, observedAt, { threadId: effectiveThreadId });
    });
    return Object.freeze({ id: turnId, userMessage, shannonReply, summary, observedAt });
  }

  events(scopeKey: string): readonly PersistedExperienceEvent[] {
    const rows = this.database.prepare(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
      FROM experience_events
      WHERE scope_key = ?
      ORDER BY sequence ASC
    `).all(scopeKey) as unknown as EventRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      sequence: Number(row.sequence),
      id: row.event_id,
      scopeKey: row.scope_key,
      type: row.event_type,
      observedAt: row.observed_at,
      payload: parseJson(row.payload_json),
    })));
  }

  activityTimeline(scopeKey: string): readonly ActivityItem[] {
    const rows = this.database.prepare(`
      SELECT activity_id, activity_type, title, detail, occurred_at
      FROM activity_events WHERE scope_key = ?
      ORDER BY occurred_at DESC LIMIT 100
    `).all(scopeKey) as unknown as Array<{
      activity_id: string; activity_type: string; title: string; detail: string | null; occurred_at: string;
    }>;
    return Object.freeze(rows.map(row => Object.freeze({
      id: row.activity_id,
      type: row.activity_type,
      title: row.title,
      ...(row.detail ? { detail: row.detail } : {}),
      occurredAt: row.occurred_at,
    })));
  }

  enqueueTurnRefinement(
    scopeKey: string,
    experienceId: string,
    userMessage: string,
    observedAt: string,
  ): void {
    const payload: BackgroundJobPayload = { kind: 'turn-refinement', experienceId, userMessage };
    this.database.prepare(`
      INSERT OR IGNORE INTO background_jobs
        (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at)
      VALUES (?, ?, ?, 'turn-refinement', ?, 'pending', ?, 0, ?)
    `).run(randomUUID(), `turn:${experienceId}`, scopeKey, JSON.stringify(payload), observedAt, observedAt);
  }

  recoverUnqueuedTurnRefinements(nowIso: string): number {
    const rows = this.database.prepare(`
      SELECT event_id, scope_key, observed_at, payload_json
      FROM experience_events
      WHERE event_type = 'turn.completed'
        AND NOT EXISTS (
          SELECT 1 FROM background_jobs WHERE dedupe_key = 'turn:' || experience_events.event_id
        )
      ORDER BY sequence ASC
      LIMIT 500
    `).all() as unknown as EventRow[];
    let recovered = 0;
    this.transaction(() => {
      for (const row of rows) {
        const turn = parseTurnPayload(row.payload_json);
        if (!turn) continue;
        const payload: BackgroundJobPayload = {
          kind: 'turn-refinement',
          experienceId: row.event_id,
          userMessage: turn.userMessage,
        };
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO background_jobs
            (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at)
          VALUES (?, ?, ?, 'turn-refinement', ?, 'pending', ?, 0, ?)
        `).run(
          randomUUID(),
          `turn:${row.event_id}`,
          row.scope_key,
          JSON.stringify(payload),
          nowIso,
          row.observed_at,
        );
        recovered += Number(result.changes);
      }
    });
    return recovered;
  }

  enqueueSleepConsolidations(dayKey: string, startAt: string, endAt: string, nowIso: string): number {
    const scopes = this.database.prepare(`
      SELECT DISTINCT scope_key
      FROM conversation_messages
      WHERE role = 'user' AND observed_at >= ? AND observed_at < ?
    `).all(startAt, endAt) as unknown as Array<{ scope_key: string }>;
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO background_jobs
        (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at)
      VALUES (?, ?, ?, 'sleep-consolidation', ?, 'pending', ?, 0, ?)
    `);
    let inserted = 0;
    this.transaction(() => {
      for (const row of scopes) {
        const payload: BackgroundJobPayload = { kind: 'sleep-consolidation', dayKey, startAt, endAt };
        const result = insert.run(
          randomUUID(),
          `sleep:${row.scope_key}:${dayKey}`,
          row.scope_key,
          JSON.stringify(payload),
          nowIso,
          nowIso,
        );
        inserted += Number(result.changes);
      }
    });
    return inserted;
  }

  claimNextBackgroundJob(workerId: string, nowIso: string, leaseUntilIso: string): ClaimedBackgroundJob | null {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT job_id, scope_key, payload_json, attempts
        FROM background_jobs
        WHERE ((status = 'pending' AND available_at <= ?)
           OR (status = 'leased' AND lease_until <= ?))
          AND NOT EXISTS (
            SELECT 1 FROM background_jobs AS active
            WHERE active.scope_key = background_jobs.scope_key
              AND active.status = 'leased'
              AND active.lease_until > ?
          )
        ORDER BY sequence ASC
        LIMIT 1
      `).get(nowIso, nowIso, nowIso) as unknown as BackgroundJobRow | undefined;
      if (!row) return null;
      const changed = this.database.prepare(`
        UPDATE background_jobs
        SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE job_id = ? AND ((status = 'pending' AND available_at <= ?) OR (status = 'leased' AND lease_until <= ?))
      `).run(workerId, leaseUntilIso, row.job_id, nowIso, nowIso);
      if (Number(changed.changes) !== 1) return null;
      return Object.freeze({
        id: row.job_id,
        scopeKey: row.scope_key,
        payload: parseBackgroundJobPayload(row.payload_json),
        attempts: Number(row.attempts) + 1,
      });
    });
  }

  completeClaimedBackgroundJob(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    operation: () => void,
  ): void {
    this.transaction(() => {
      this.assertJobLease(job.id, workerId);
      operation();
      this.markJobCompleted(job.id, workerId, completedAt);
    });
  }

  failClaimedBackgroundJob(
    job: ClaimedBackgroundJob,
    workerId: string,
    nowIso: string,
    errorCode: string,
  ): void {
    const permanent = job.attempts >= 5;
    const retryAt = new Date(Date.parse(nowIso) + Math.min(300, 2 ** job.attempts) * 1_000).toISOString();
    this.database.prepare(`
      UPDATE background_jobs
      SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
          completed_at = ?, last_error = ?
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(
      permanent ? 'failed' : 'pending',
      retryAt,
      permanent ? nowIso : null,
      errorCode.slice(0, 120),
      job.id,
      workerId,
    );
  }

  dailyUserMessages(scopeKey: string, startAt: string, endAt: string): readonly DailyUserMessage[] {
    const rows = this.database.prepare(`
      SELECT content, observed_at
      FROM conversation_messages
      WHERE scope_key = ? AND role = 'user' AND observed_at >= ? AND observed_at < ?
      ORDER BY sequence ASC
      LIMIT 200
    `).all(scopeKey, startAt, endAt) as unknown as Array<{ content: string; observed_at: string }>;
    return Object.freeze(rows.map(row => Object.freeze({ content: row.content, observedAt: row.observed_at })));
  }

  applySleepOutcome(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    outcome: SleepConsolidationOutcome,
  ): void {
    this.completeClaimedBackgroundJob(job, workerId, completedAt, () => {
      for (const fact of outcome.facts) {
        this.apply(job.scopeKey, { type: 'user-fact-upserted', fact, source: 'sleep' });
      }
      for (const relationship of outcome.relationships) {
        this.apply(job.scopeKey, { type: 'relationship-upserted', relationship, source: 'sleep' });
      }
      for (const interest of outcome.interests) {
        this.apply(job.scopeKey, { type: 'interest-observed', interest, source: 'sleep' });
      }
      this.insertEvent(job.scopeKey, 'sleep.completed', completedAt, {
        dayKey: job.payload.kind === 'sleep-consolidation' ? job.payload.dayKey : null,
        appliedFactIds: outcome.facts.map(fact => fact.id),
        appliedRelationshipIds: outcome.relationships.map(relationship => relationship.id),
        appliedInterests: outcome.interests,
        ...outcome.report,
      });
      const dayKey = job.payload.kind === 'sleep-consolidation' ? job.payload.dayKey : completedAt.slice(0, 10);
      this.database.prepare(`
        INSERT INTO sleep_runs
          (sleep_run_id, scope_key, day_key, status, summary_json, started_at, completed_at)
        VALUES (?, ?, ?, 'completed', ?, ?, ?)
        ON CONFLICT(scope_key, day_key) DO UPDATE SET
          status = 'completed', summary_json = excluded.summary_json, completed_at = excluded.completed_at
      `).run(job.id, job.scopeKey, dayKey, JSON.stringify(outcome.report), completedAt, completedAt);
      this.writePersonalityProfile(job.scopeKey, this.snapshot(job.scopeKey), completedAt);
      this.writePromptProjection(job.scopeKey, this.snapshot(job.scopeKey));
      this.insertActivity(job.scopeKey, 'sleep', '睡眠バッチ', dayKey, completedAt, outcome.report);
    });
  }

  pendingBackgroundJobCount(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM background_jobs WHERE status IN ('pending', 'leased')
    `).get() as unknown as { count: number };
    return Number(row.count);
  }

  close(): void {
    if (!this.database.isOpen) return;
    this.database.exec('PRAGMA wal_checkpoint(PASSIVE)');
    secureDatabaseFiles(this.options.path);
    this.database.close();
  }

  private migrate(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    const previousVersion = Number(version.user_version);
    if (previousVersion > SCHEMA_VERSION) {
      throw new Error(`SHANNON_DATABASE_SCHEMA_TOO_NEW:${version.user_version}`);
    }
    if (previousVersion === SCHEMA_VERSION) return;
    this.transaction(() => {
      if (previousVersion < 1) this.database.exec(`
        CREATE TABLE IF NOT EXISTS companion_states (
          scope_key TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 0),
          updated_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          metadata_json TEXT,
          UNIQUE (scope_key, turn_id, ordinal)
        );

        CREATE INDEX IF NOT EXISTS conversation_messages_scope_sequence
          ON conversation_messages (scope_key, sequence);

        CREATE TABLE IF NOT EXISTS experience_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS experience_events_scope_sequence
          ON experience_events (scope_key, sequence);
        CREATE INDEX IF NOT EXISTS experience_events_scope_type_sequence
          ON experience_events (scope_key, event_type, sequence);

      `);
      if (previousVersion < 2) this.database.exec(`
        CREATE TABLE IF NOT EXISTS background_jobs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL UNIQUE,
          dedupe_key TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          job_kind TEXT NOT NULL CHECK (job_kind IN ('turn-refinement', 'sleep-consolidation')),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
          available_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_until TEXT,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          created_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS background_jobs_claim
          ON background_jobs (status, available_at, sequence);
      `);
      if (previousVersion === 1) {
        const historicalTurns = this.database.prepare(`
          SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
          FROM experience_events
          WHERE event_type = 'turn.completed'
          ORDER BY sequence ASC
        `).all() as unknown as EventRow[];
        const markHistorical = this.database.prepare(`
          INSERT OR IGNORE INTO background_jobs
            (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at, completed_at)
          VALUES (?, ?, ?, 'turn-refinement', ?, 'completed', ?, 0, ?, ?)
        `);
        for (const row of historicalTurns) {
          const turn = parseTurnPayload(row.payload_json);
          if (!turn) continue;
          const payload: BackgroundJobPayload = {
            kind: 'turn-refinement',
            experienceId: row.event_id,
            userMessage: turn.userMessage,
          };
          markHistorical.run(
            randomUUID(),
            `turn:${row.event_id}`,
            row.scope_key,
            JSON.stringify(payload),
            row.observed_at,
            row.observed_at,
            row.observed_at,
          );
        }
      }
      if (previousVersion < 3) this.migrateThreadedConversations();
      if (previousVersion < 4) this.migrateKnowledgeCore();
      if (previousVersion < 5) this.migrateThreadArchive();
      if (previousVersion < 6) this.migrateLlmUsage();
      if (previousVersion < 7) migrateAgentTasks(this.database);
      if (previousVersion < 8) this.migrateThreadTitleOrigin();
      if (previousVersion < 9) this.migrateVoiceUsageLane();
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
  }

  private migrateThreadTitleOrigin(): void {
    const columns = this.database.prepare("PRAGMA table_info('conversation_threads')").all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'title_origin')) {
      // Legacy titles have no edit provenance; preserve even manually chosen default titles.
      this.database.exec("ALTER TABLE conversation_threads ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'manual';");
    }
  }

  private migrateThreadedConversations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        thread_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_threads_scope
        ON conversation_threads (scope_key, updated_at DESC);
    `);

    const columns = this.database.prepare("PRAGMA table_info('conversation_messages')").all() as unknown as Array<{ name: string }>;
    const hasThreadId = columns.some(column => column.name === 'thread_id');

    if (!hasThreadId) {
      const now = this.options.now();
      this.database.exec('ALTER TABLE conversation_messages ADD COLUMN thread_id TEXT;');

      const scopes = this.database.prepare(`
        SELECT DISTINCT scope_key
        FROM conversation_messages
      `).all() as unknown as Array<{ scope_key: string }>;

      const createThread = this.database.prepare(`
        INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const seedFirstMessage = this.database.prepare(`
        SELECT content, observed_at
        FROM conversation_messages
        WHERE scope_key = ?
        ORDER BY sequence ASC
        LIMIT 1
      `);
      const assignThread = this.database.prepare(`
        UPDATE conversation_messages
        SET thread_id = ?
        WHERE scope_key = ?
      `);

      for (const row of scopes) {
        const threadId = `legacy:${row.scope_key}`;
        const seed = seedFirstMessage.get(row.scope_key) as { content: string; observed_at: string } | undefined;
        const title = seed ? conciseThreadTitle(seed.content) : '新しいトーク';
        createThread.run(threadId, row.scope_key, title, seed?.observed_at ?? now, seed?.observed_at ?? now);
        assignThread.run(threadId, row.scope_key);
      }
    }

    const missing = this.database.prepare(`
      SELECT scope_key, message_id
      FROM conversation_messages
      WHERE thread_id IS NULL
      LIMIT 1
    `).get();
    if (missing) {
      const now = this.options.now();
      const createThread = this.database.prepare(`
        INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at)
        VALUES (?, ?, '新しいトーク', ?, ?)
      `);
      const assignMissing = this.database.prepare(`
        UPDATE conversation_messages
        SET thread_id = ?
        WHERE scope_key = ? AND thread_id IS NULL
      `);
      const rows = this.database.prepare(`
        SELECT DISTINCT scope_key
        FROM conversation_messages
        WHERE thread_id IS NULL
      `).all() as unknown as Array<{ scope_key: string }>;
      for (const row of rows) {
        const threadId = randomUUID();
        createThread.run(threadId, row.scope_key, '新しいトーク', now, now);
        assignMissing.run(threadId, row.scope_key);
      }
    }

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_messages_scope_thread
        ON conversation_messages (scope_key, thread_id, sequence);
    `);

    const conversationThreads = this.database.prepare(`
      SELECT COUNT(*) AS count FROM conversation_threads
    `).get() as unknown as { count: number };
    if (conversationThreads.count === 0) return;

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_messages_thread_scope_sequence
        ON conversation_messages (thread_id, scope_key, sequence);
    `);
  }

  private migrateThreadArchive(): void {
    const columns = this.database.prepare("PRAGMA table_info('conversation_threads')").all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'archived_at')) {
      this.database.exec('ALTER TABLE conversation_threads ADD COLUMN archived_at TEXT;');
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_threads_active_scope
        ON conversation_threads (scope_key, archived_at, updated_at DESC);
    `);
  }

  private migrateLlmUsage(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS llm_usage_events (
        usage_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('chat', 'sleep', 'voice')),
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
        estimated_cost_usd REAL NOT NULL CHECK (estimated_cost_usd >= 0),
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS llm_usage_events_month_lane
        ON llm_usage_events (occurred_at, lane);
    `);
  }

  private migrateVoiceUsageLane(): void {
    const row = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'
    `).get() as unknown as { sql?: string } | undefined;
    if (row?.sql?.includes("'voice'")) return;

    this.database.exec(`
      ALTER TABLE llm_usage_events RENAME TO llm_usage_events_before_voice;
      CREATE TABLE llm_usage_events (
        usage_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('chat', 'sleep', 'voice')),
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
        estimated_cost_usd REAL NOT NULL CHECK (estimated_cost_usd >= 0),
        occurred_at TEXT NOT NULL
      );
      INSERT INTO llm_usage_events
        (usage_id, scope_key, lane, model, input_tokens, cached_input_tokens,
         output_tokens, total_tokens, estimated_cost_usd, occurred_at)
      SELECT usage_id, scope_key, lane, model, input_tokens, cached_input_tokens,
             output_tokens, total_tokens, estimated_cost_usd, occurred_at
      FROM llm_usage_events_before_voice;
      DROP TABLE llm_usage_events_before_voice;
      CREATE INDEX llm_usage_events_month_lane
        ON llm_usage_events (occurred_at, lane);
    `);
  }

  private migrateKnowledgeCore(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS question_definitions (
        question_key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        question TEXT NOT NULL,
        display_order INTEGER NOT NULL,
        allows_multiple INTEGER NOT NULL DEFAULT 0 CHECK (allows_multiple IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_answers (
        answer_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        question_key TEXT NOT NULL,
        answer TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source TEXT NOT NULL CHECK (source IN ('conversation', 'sleep', 'user', 'inference')),
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, answer_id),
        FOREIGN KEY (question_key) REFERENCES question_definitions(question_key)
      );
      CREATE INDEX IF NOT EXISTS knowledge_answers_scope_question
        ON knowledge_answers (scope_key, question_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_evidence (
        evidence_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        answer_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('conversation', 'sleep', 'user', 'inference')),
        observed_at TEXT NOT NULL,
        UNIQUE (scope_key, answer_id, quote, observed_at)
      );
      CREATE INDEX IF NOT EXISTS knowledge_evidence_answer
        ON knowledge_evidence (scope_key, answer_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_revisions (
        revision_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        answer_id TEXT NOT NULL,
        previous_answer TEXT,
        next_answer TEXT NOT NULL,
        reason TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_revisions_answer
        ON knowledge_revisions (scope_key, answer_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS personality_profiles (
        profile_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        analysis TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE (scope_key, version)
      );
      CREATE TABLE IF NOT EXISTS activity_events (
        activity_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS activity_events_scope_time
        ON activity_events (scope_key, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS sleep_runs (
        sleep_run_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        summary_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (scope_key, day_key)
      );
      CREATE TABLE IF NOT EXISTS prompt_projections (
        scope_key TEXT PRIMARY KEY,
        state_version INTEGER NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const seededAt = this.options.now();
    const insertDefinition = this.database.prepare(`
      INSERT OR IGNORE INTO question_definitions
        (question_key, category, question, display_order, allows_multiple, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `);
    for (const definition of DEFAULT_QUESTION_DEFINITIONS) {
      insertDefinition.run(definition.key, definition.category, definition.question, definition.order, seededAt);
    }

    const states = this.database.prepare(`
      SELECT scope_key, snapshot_json FROM companion_states
    `).all() as unknown as Array<{ scope_key: string; snapshot_json: string }>;
    for (const row of states) {
      const state = parseSnapshot(row.snapshot_json, row.scope_key, seededAt);
      for (const fact of state.userFacts) this.synchronizeFact(row.scope_key, fact, 'sleep');
      this.writePromptProjection(row.scope_key, state);
    }
  }

  private assertJobLease(jobId: string, workerId: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS held FROM background_jobs
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).get(jobId, workerId);
    if (!row) throw new Error('BACKGROUND_JOB_LEASE_LOST');
  }

  private markJobCompleted(jobId: string, workerId: string, completedAt: string): void {
    const changed = this.database.prepare(`
      UPDATE background_jobs
      SET status = 'completed', completed_at = ?, lease_owner = NULL, lease_until = NULL, last_error = NULL
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(completedAt, jobId, workerId);
    if (Number(changed.changes) !== 1) throw new Error('BACKGROUND_JOB_LEASE_LOST');
  }

  private insertEvent(
    scopeKey: string,
    type: string,
    observedAt: string,
    payload: unknown,
    eventId = randomUUID(),
  ): void {
    this.database.prepare(`
      INSERT INTO experience_events (event_id, scope_key, event_type, observed_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, scopeKey, type, observedAt, JSON.stringify(payload));
  }

  private transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      secureDatabaseFiles(this.options.path);
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export function configuredDatabasePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return environment.SHANNON_DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('SQLITE_STORE_LIMIT_INVALID');
  return value;
}

function prepareDatabaseLocation(path: string): void {
  if (path === ':memory:') return;
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(directory, 0o700);
}

function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

function parseSnapshot(raw: string, expectedScopeKey: string, nowIso: string): CompanionStateSnapshot {
  return restoreCompanionState(expectedScopeKey, parseJson(raw), nowIso);
}

function freezeStoredMessage(row: MessageRow): StoredConversationMessage {
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const metadata = row.metadata_json ? parseMessageMetadata(row.metadata_json) : null;
  return Object.freeze({
    id: row.message_id,
    role,
    content: row.content,
    observedAt: row.observed_at,
    ...(metadata?.messageEmotion ? { messageEmotion: Object.freeze({ ...metadata.messageEmotion }) } : {}),
    ...(metadata?.stateVersion !== undefined ? { stateVersion: metadata.stateVersion } : {}),
    ...(metadata?.taskDecision ? { taskDecision: Object.freeze({ ...metadata.taskDecision }) } : {}),
    ...(metadata?.artifacts?.length ? {
      artifacts: Object.freeze(metadata.artifacts.map(artifact => Object.freeze({ ...artifact }))),
    } : {}),
  });
}

function parseMessageMetadata(raw: string): MessageMetadata | null {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as MessageMetadata;
  return {
    ...(Number.isSafeInteger(row.stateVersion) ? { stateVersion: row.stateVersion } : {}),
    ...(validMessageEmotion(row.messageEmotion) ? { messageEmotion: row.messageEmotion } : {}),
    ...(validTaskDecision(row.taskDecision) ? { taskDecision: row.taskDecision } : {}),
    ...(validGeneratedArtifacts(row.artifacts) ? { artifacts: row.artifacts } : {}),
  };
}

function validGeneratedArtifacts(value: unknown): value is readonly ShannonGeneratedArtifact[] {
  if (!Array.isArray(value) || value.length > 2) return false;
  let totalCharacters = 0;
  return value.every(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const row = candidate as Partial<ShannonGeneratedArtifact>;
    totalCharacters += typeof row.content === 'string' ? row.content.length : 0;
    return typeof row.name === 'string'
      && row.name.length > 0 && row.name.length <= 120
      && !/[\\/\u0000-\u001F\u007F]/u.test(row.name)
      && typeof row.mimeType === 'string'
      && ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/x-source-code'].includes(row.mimeType)
      && typeof row.content === 'string' && row.content.length <= 12_000
      && totalCharacters <= 18_000
      && (row.summary === undefined || (typeof row.summary === 'string' && row.summary.length <= 160));
  });
}

function validTaskDecision(value: unknown): value is ShannonTaskDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ShannonTaskDecision>;
  return (row.disposition === 'none' || row.disposition === 'clarify' || row.disposition === 'propose')
    && typeof row.reason === 'string'
    && row.reason.length > 0
    && row.reason.length <= 500;
}

function parseTurnPayload(raw: string): TurnPayload | null {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<TurnPayload>;
  if (typeof row.userMessage !== 'string'
    || typeof row.shannonReply !== 'string'
    || typeof row.summary !== 'string') return null;
  return row as TurnPayload;
}

function parseBackgroundJobPayload(raw: string): BackgroundJobPayload {
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BACKGROUND_JOB_CORRUPT');
  const row = value as Partial<BackgroundJobPayload> & Record<string, unknown>;
  if (row.kind === 'turn-refinement'
    && typeof row.experienceId === 'string'
    && typeof row.userMessage === 'string') {
    return { kind: row.kind, experienceId: row.experienceId, userMessage: row.userMessage };
  }
  if (row.kind === 'sleep-consolidation'
    && typeof row.dayKey === 'string'
    && typeof row.startAt === 'string'
    && typeof row.endAt === 'string') {
    return { kind: row.kind, dayKey: row.dayKey, startAt: row.startAt, endAt: row.endAt };
  }
  throw new Error('BACKGROUND_JOB_CORRUPT');
}

function validMessageEmotion(value: unknown): value is ShannonMessageEmotion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ShannonMessageEmotion>;
  return typeof row.valence === 'number'
    && typeof row.arousal === 'number'
    && typeof row.openness === 'number'
    && typeof row.expression === 'string';
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('SHANNON_DATABASE_JSON_CORRUPT');
  }
}

function conciseThreadTitle(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新しいトーク';
  return cleaned.length <= 30 ? cleaned : `${cleaned.slice(0, 27)}…`;
}

function summarizeExperience(userMessage: string, shannonReply: string): string {
  const user = userMessage.replace(/\s+/g, ' ').trim().slice(0, 220);
  const shannon = shannonReply.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `ユーザー: ${user} / シャノン: ${shannon}`;
}
