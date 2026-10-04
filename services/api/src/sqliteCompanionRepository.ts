import { randomUUID } from 'node:crypto';
import {
  assembleShannonSystemPrompt,
  createInitialCompanionState,
  normalizeShannonExpressiveEmotion,
  reduceCompanionState,
  visibleMemoryText,
  isOwnerMemoryEvidence,
  isMemoryEvidenceVisible,
  type CompanionStateEvent,
  type CompanionStateSnapshot,
  type CompanionStateStore,
} from '@shannon/cognition';
import type { LlmUsageEvent, LlmUsageStore } from './llmUsage.js';
import {
  classifyQuestion,
  type KnowledgeAnswer,
  type KnowledgeRevision,
  type KnowledgeSource,
  type KnowledgeStore,
  type PersonalityProfile,
} from './knowledgeStore.js';
import {
  SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS,
  type RealtimeVoiceAllowanceStatus,
  type RealtimeVoiceReservationStore,
  type RealtimeVoiceSessionReservation,
  type RealtimeVoiceSessionReservationRequest,
} from './realtimeVoice.js';
import { parseSnapshot } from './sqliteStoreCodecs.js';
import type { SQLiteStoreContext } from './sqliteStoreContext.js';
import { hydrateMemoryBoundaries, safePersonalityAnalysis } from './memoryProjectionSafety.js';

interface StateRow { snapshot_json: string; }
interface KnowledgeAnswerRow { answer_id: string; question_key: string; category: string; question: string; answer: string; confidence: number; source: KnowledgeSource; confirmed: number; updated_at: string; }
interface KnowledgeEvidenceRow { answer_id: string; quote: string; source: KnowledgeSource; observed_at: string; }
interface KnowledgeRevisionRow { revision_id: string; answer_id: string; previous_answer: string | null; next_answer: string; reason: string; observed_at: string; }

export class SQLiteCompanionRepository implements CompanionStateStore, KnowledgeStore, LlmUsageStore, RealtimeVoiceReservationStore {
  /** `committed` sees every state as it was written, after the write (the mood history, `moodHistory.ts`); it cannot change it. */
  constructor(private readonly context: SQLiteStoreContext, private readonly committed?: (scopeKey: string, state: CompanionStateSnapshot) => void) {}

  snapshot(scopeKey: string): CompanionStateSnapshot {
    const row = this.context.database.prepare(`
      SELECT snapshot_json
      FROM companion_states
      WHERE scope_key = ?
    `).get(scopeKey) as unknown as StateRow | undefined;
    if (row) return hydrateMemoryBoundaries(this.context, parseSnapshot(row.snapshot_json, scopeKey, this.context.now()));

    const initial = createInitialCompanionState(scopeKey, this.context.now());
    this.context.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO companion_states (scope_key, version, updated_at, snapshot_json)
        VALUES (?, ?, ?, ?)
      `).run(scopeKey, initial.version, initial.updatedAt, JSON.stringify(initial));
      this.context.insertEvent(scopeKey, 'state.initialized', initial.updatedAt, {
        toVersion: initial.version,
      });
    });
    return initial;
  }

  apply(scopeKey: string, event: CompanionStateEvent): CompanionStateSnapshot {
    let written: CompanionStateSnapshot | undefined;
    const result = this.context.transaction(() => {
      // API and sleep worker share this database. Read only after obtaining
      // the write lock so a later writer cannot overwrite a fresh correction.
      const current = this.snapshot(scopeKey);
      const next = reduceCompanionState(current, event, this.context.now(), this.context.emotionTiming());
      if (next === current) return current;
      if (next.version === current.version) {
        // Her clock alone moved (and what fades with it): no event row, no version, no prompt projection.
        this.context.database.prepare('UPDATE companion_states SET snapshot_json = ? WHERE scope_key = ?').run(JSON.stringify(next), scopeKey);
        return written = next;
      }
      this.context.database.prepare(`
        UPDATE companion_states
        SET version = ?, updated_at = ?, snapshot_json = ?
        WHERE scope_key = ?
      `).run(next.version, next.updatedAt, JSON.stringify(next), scopeKey);
      this.context.insertEvent(scopeKey, `state.${event.type}`, next.updatedAt, {
        // The feeling as stored: the resolver's notes to the reducer are not kept in the log either.
        event: event.type === 'expressive-emotion-updated' ? { ...event, emotion: normalizeShannonExpressiveEmotion(event.emotion) } : event,
        fromVersion: current.version,
        toVersion: next.version,
      });
      if (event.type === 'user-fact-upserted') {
        this.synchronizeFact(scopeKey, event.fact, event.source ?? 'inference');
        this.context.insertActivity(scopeKey, 'knowledge', '知識を更新', event.fact.statement, next.updatedAt);
      }
      if (event.type === 'memory-control-upserted' || event.type === 'memory-transaction') {
        this.writePersonalityProfile(scopeKey, next, next.updatedAt);
      }
      this.writePromptProjection(scopeKey, next);
      return written = next;
    });
    if (written) this.committed?.(scopeKey, written);
    return result;
  }

  synchronizeFact(scopeKey: string, fact: CompanionStateSnapshot['userFacts'][number], source: KnowledgeSource): void {
    const definition = classifyQuestion(fact.statement, fact.id);
    const existing = this.context.database.prepare(`
      SELECT answer FROM knowledge_answers WHERE answer_id = ? AND scope_key = ?
    `).get(fact.id, scopeKey) as unknown as { answer: string } | undefined;
    this.context.database.prepare(`
      INSERT INTO question_definitions (question_key, category, question, display_order, allows_multiple, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(question_key) DO UPDATE SET
        category = excluded.category,
        question = excluded.question,
        display_order = excluded.display_order
    `).run(definition.key, definition.category, definition.question, definition.order, fact.observedAt);
    if (existing && existing.answer !== fact.statement) {
      this.context.database.prepare(`
        INSERT INTO knowledge_revisions
          (revision_id, scope_key, answer_id, previous_answer, next_answer, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), scopeKey, fact.id, existing.answer, fact.statement, `${source}から更新`, fact.observedAt);
    }
    this.context.database.prepare(`
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
      this.context.database.prepare(`
        INSERT OR IGNORE INTO knowledge_evidence
          (evidence_id, scope_key, answer_id, quote, source, observed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), scopeKey, fact.id, fact.evidence, source, fact.observedAt);
    }
  }

  correctKnowledge(scopeKey: string, answerId: string, answer: string, observedAt: string): void {
    const current = this.context.database.prepare(`
      SELECT answer FROM knowledge_answers WHERE scope_key = ? AND answer_id = ?
    `).get(scopeKey, answerId) as unknown as { answer: string } | undefined;
    if (!current) return;
    if (current.answer !== answer) {
      this.context.database.prepare(`
        INSERT INTO knowledge_revisions
          (revision_id, scope_key, answer_id, previous_answer, next_answer, reason, observed_at)
        VALUES (?, ?, ?, ?, ?, 'ユーザーが手動で訂正', ?)
      `).run(randomUUID(), scopeKey, answerId, current.answer, answer, observedAt);
    }
    this.context.database.prepare(`
      UPDATE knowledge_answers
      SET answer = ?, confidence = 1, source = 'user', confirmed = 1, updated_at = ?
      WHERE scope_key = ? AND answer_id = ?
    `).run(answer, observedAt, scopeKey, answerId);
    this.context.database.prepare(`
      INSERT INTO knowledge_evidence
        (evidence_id, scope_key, answer_id, quote, source, observed_at)
      VALUES (?, ?, ?, ?, 'user', ?)
    `).run(randomUUID(), scopeKey, answerId, answer, observedAt);
    this.context.insertActivity(scopeKey, 'knowledge', '知識を手動訂正', answer, observedAt, { answerId });
    this.writePromptProjection(scopeKey, this.snapshot(scopeKey));
  }

  knowledgeAnswers(scopeKey: string): readonly KnowledgeAnswer[] {
    const rows = this.context.database.prepare(`
      SELECT a.answer_id, a.question_key, q.category, q.question, a.answer,
             a.confidence, a.source, a.confirmed, a.updated_at
      FROM knowledge_answers a
      JOIN question_definitions q ON q.question_key = a.question_key
      WHERE a.scope_key = ?
      ORDER BY q.display_order ASC, a.updated_at DESC
    `).all(scopeKey) as unknown as KnowledgeAnswerRow[];
    const evidenceRows = this.context.database.prepare(`
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
      ? this.context.database.prepare(`
          SELECT revision_id, answer_id, previous_answer, next_answer, reason, observed_at
          FROM knowledge_revisions WHERE scope_key = ? AND answer_id = ? ORDER BY observed_at DESC
        `).all(scopeKey, answerId)
      : this.context.database.prepare(`
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
    const row = this.context.database.prepare(`
      SELECT version, analysis, created_at
      FROM personality_profiles
      WHERE scope_key = ? AND active = 1
      ORDER BY version DESC LIMIT 1
    `).get(scopeKey) as unknown as { version: number; analysis: string; created_at: string } | undefined;
    return row ? Object.freeze({ version: Number(row.version), analysis: safePersonalityAnalysis(this.snapshot(scopeKey)), createdAt: row.created_at }) : null;
  }

  promptProjection(scopeKey: string): string | null {
    const row = this.context.database.prepare(`
      SELECT content FROM prompt_projections WHERE scope_key = ?
    `).get(scopeKey) as unknown as { content: string } | undefined;
    // Cached/profile text can predate a privacy-policy upgrade or a correction.
    return row ? this.promptContent(scopeKey, this.snapshot(scopeKey)) : null;
  }

  recordLlmUsage(event: LlmUsageEvent): void {
    this.context.database.prepare(`
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
    const row = this.context.database.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM llm_usage_events
      WHERE lane IN ('sleep', 'memory_background') AND substr(occurred_at, 1, 7) = ?
    `).get(monthKey) as unknown as { cost: number };
    return Number(row.cost);
  }

  backgroundLlmCostUsdForDay(dayKey: string): number {
    const row = this.context.database.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM llm_usage_events
      WHERE lane IN ('sleep', 'memory_background') AND date(datetime(occurred_at, '+9 hours')) = ?
    `).get(dayKey) as unknown as { cost: number };
    return Number(row.cost);
  }

  voiceLlmCostUsdForDay(scopeKey: string, dayKey: string): number {
    const row = this.context.database.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
      FROM llm_usage_events
      WHERE scope_key = ? AND lane = 'voice'
        AND date(datetime(occurred_at, '+9 hours')) = ?
    `).get(scopeKey, dayKey) as unknown as { cost: number };
    return Number(row.cost);
  }

  reserveRealtimeVoiceSession(
    request: RealtimeVoiceSessionReservationRequest,
  ): RealtimeVoiceSessionReservation | null {
    const scopeKey = request.scopeKey.trim();
    if (!scopeKey) throw new Error('REALTIME_VOICE_SCOPE_REQUIRED');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(request.dayKey)) throw new Error('REALTIME_VOICE_DAY_INVALID');
    if (!Number.isInteger(request.reservedSeconds) || request.reservedSeconds <= 0) {
      throw new Error('REALTIME_VOICE_RESERVATION_INVALID');
    }
    if (!Number.isInteger(request.dailyLimitSeconds) || request.dailyLimitSeconds < request.reservedSeconds) {
      throw new Error('REALTIME_VOICE_DAILY_LIMIT_INVALID');
    }
    if (!Number.isFinite(Date.parse(request.createdAt))) throw new Error('REALTIME_VOICE_CREATED_AT_INVALID');

    return this.context.transaction(() => {
      const row = this.context.database.prepare(`
        SELECT COALESCE(SUM(reserved_seconds), 0) AS reserved_seconds
        FROM realtime_voice_session_reservations
        WHERE scope_key = ? AND day_key = ?
      `).get(scopeKey, request.dayKey) as unknown as { reserved_seconds: number };
      const alreadyReserved = Number(row.reserved_seconds);
      if (alreadyReserved + request.reservedSeconds > request.dailyLimitSeconds) return null;

      const reservationId = randomUUID();
      this.context.database.prepare(`
        INSERT INTO realtime_voice_session_reservations
          (reservation_id, scope_key, day_key, reserved_seconds, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        reservationId,
        scopeKey,
        request.dayKey,
        request.reservedSeconds,
        request.createdAt,
      );
      return Object.freeze({
        reservationId,
        remainingSeconds: request.dailyLimitSeconds - alreadyReserved - request.reservedSeconds,
      });
    });
  }

  releaseRealtimeVoiceSessionReservation(reservationId: string): void {
    this.context.database.prepare(`
      DELETE FROM realtime_voice_session_reservations WHERE reservation_id = ?
    `).run(reservationId);
  }

  realtimeVoiceReservedSecondsForDay(scopeKey: string, dayKey: string): number {
    const row = this.context.database.prepare(`
      SELECT COALESCE(SUM(reserved_seconds), 0) AS reserved_seconds
      FROM realtime_voice_session_reservations
      WHERE scope_key = ? AND day_key = ?
    `).get(scopeKey, dayKey) as unknown as { reserved_seconds: number };
    return Number(row.reserved_seconds);
  }

  realtimeVoiceAllowanceStatus(
    scopeKey: string,
    dayKey: string,
    baseAllowanceSeconds: number,
    maximumAllowanceSeconds = SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS,
  ): RealtimeVoiceAllowanceStatus {
    const normalizedScopeKey = validatedRealtimeVoiceScope(scopeKey);
    validatedRealtimeVoiceDay(dayKey);
    validatedRealtimeVoiceAllowance(baseAllowanceSeconds, maximumAllowanceSeconds);
    const extension = this.context.database.prepare(`
      SELECT additional_seconds
      FROM realtime_voice_allowance_extensions
      WHERE scope_key = ? AND day_key = ?
    `).get(normalizedScopeKey, dayKey) as unknown as { additional_seconds: number } | undefined;
    const additionalAllowanceSeconds = Number(extension?.additional_seconds ?? 0);
    const totalAllowanceSeconds = Math.min(
      maximumAllowanceSeconds,
      baseAllowanceSeconds + additionalAllowanceSeconds,
    );
    const reservedSeconds = this.realtimeVoiceReservedSecondsForDay(normalizedScopeKey, dayKey);
    return Object.freeze({
      dayKey,
      baseAllowanceSeconds,
      additionalAllowanceSeconds,
      totalAllowanceSeconds,
      reservedSeconds,
      remainingSeconds: Math.max(0, totalAllowanceSeconds - reservedSeconds),
      maximumAllowanceSeconds,
    });
  }

  extendRealtimeVoiceAllowance(
    scopeKey: string,
    dayKey: string,
    baseAllowanceSeconds: number,
    additionalSeconds: number,
    maximumAllowanceSeconds: number,
    updatedAt: string,
  ): RealtimeVoiceAllowanceStatus | null {
    const normalizedScopeKey = validatedRealtimeVoiceScope(scopeKey);
    validatedRealtimeVoiceDay(dayKey);
    validatedRealtimeVoiceAllowance(baseAllowanceSeconds, maximumAllowanceSeconds);
    if (!Number.isInteger(additionalSeconds) || additionalSeconds <= 0) {
      throw new Error('REALTIME_VOICE_EXTENSION_INVALID');
    }
    if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('REALTIME_VOICE_UPDATED_AT_INVALID');

    return this.context.transaction(() => {
      const current = this.realtimeVoiceAllowanceStatus(
        normalizedScopeKey,
        dayKey,
        baseAllowanceSeconds,
        maximumAllowanceSeconds,
      );
      if (current.totalAllowanceSeconds + additionalSeconds > maximumAllowanceSeconds) return null;
      this.context.database.prepare(`
        INSERT INTO realtime_voice_allowance_extensions
          (scope_key, day_key, additional_seconds, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope_key, day_key) DO UPDATE SET
          additional_seconds = additional_seconds + excluded.additional_seconds,
          updated_at = excluded.updated_at
      `).run(normalizedScopeKey, dayKey, additionalSeconds, updatedAt);
      return this.realtimeVoiceAllowanceStatus(
        normalizedScopeKey,
        dayKey,
        baseAllowanceSeconds,
        maximumAllowanceSeconds,
      );
    });
  }

  llmUsageSummary(scopeKey: string, monthKey: string): readonly {
    lane: LlmUsageEvent['lane']; calls: number; inputTokens: number; cachedInputTokens: number;
    outputTokens: number; totalTokens: number; estimatedCostUsd: number;
  }[] {
    const rows = this.context.database.prepare(`
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

  writePromptProjection(scopeKey: string, state: CompanionStateSnapshot): void {
    const content = this.promptContent(scopeKey, state);
    this.context.database.prepare(`
      INSERT INTO prompt_projections (scope_key, state_version, content, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        state_version = excluded.state_version,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(scopeKey, state.version, content, state.updatedAt);
  }

  private promptContent(scopeKey: string, state: CompanionStateSnapshot): string {
    const personality = this.personalityProfile(scopeKey);
    const knowledge = this.knowledgeAnswers(scopeKey).flatMap(item => {
      const answer = visibleMemoryText(state, item.answerId, item.answer);
      const corrected = state.memoryControls.some(control => control.memoryId === item.answerId && control.overrideText);
      return answer && !item.evidence.some(evidence => !isMemoryEvidenceVisible(state, evidence.quote, item.answerId)
        || (item.source !== 'user' && !isOwnerMemoryEvidence(evidence.quote)))
        ? [{ ...item, answer, question: corrected ? '本人が訂正した情報' : item.question }] : [];
    }).slice(0, 80);
    const sections = [assembleShannonSystemPrompt(state)];
    if (knowledge.length) {
      sections.push(`[User knowledge]\n${knowledge.map(item => `- ${item.question}: ${item.answer} (confidence ${item.confidence.toFixed(2)}, source ${item.source})`).join('\n')}`);
    }
    if (personality) sections.push(`[Personality analysis v${personality.version}]\n${safePersonalityAnalysis(state)}`);
    return sections.join('\n\n');
  }

  writePersonalityProfile(scopeKey: string, state: CompanionStateSnapshot, createdAt: string): void {
    const previous = this.context.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM personality_profiles WHERE scope_key = ?
    `).get(scopeKey) as unknown as { version: number };
    const analysis = safePersonalityAnalysis(state);
    this.context.database.prepare(`UPDATE personality_profiles SET active = 0 WHERE scope_key = ?`).run(scopeKey);
    this.context.database.prepare(`
      INSERT INTO personality_profiles
        (profile_id, scope_key, version, analysis, active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(randomUUID(), scopeKey, Number(previous.version) + 1, analysis, createdAt);
  }
}

function validatedRealtimeVoiceScope(scopeKey: string): string {
  const normalized = scopeKey.trim();
  if (!normalized) throw new Error('REALTIME_VOICE_SCOPE_REQUIRED');
  return normalized;
}

function validatedRealtimeVoiceDay(dayKey: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) throw new Error('REALTIME_VOICE_DAY_INVALID');
}

function validatedRealtimeVoiceAllowance(baseSeconds: number, maximumSeconds: number): void {
  if (!Number.isInteger(baseSeconds) || baseSeconds <= 0
    || !Number.isInteger(maximumSeconds) || maximumSeconds < baseSeconds) {
    throw new Error('REALTIME_VOICE_DAILY_LIMIT_INVALID');
  }
}
