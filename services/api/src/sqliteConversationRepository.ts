import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ShannonConversationItem } from './chatModel.js';
import {
  boundedRecalledMemoryIds,
  threadNavigation,
  type ThreadSummaryLineage,
  type ConversationStore,
  type ConversationThread,
  type PlatformTurnPersistenceInput,
  type PlatformTurnPersistenceResult,
  type ShannonExperience,
  type StoredConversationMessage,
  type TurnPersistenceContext,
} from './conversationStore.js';
import type { ActivityItem } from './memoryService.js';
import { DEFAULT_THREAD_TITLE, initialThreadTitle } from './threadTitle.js';
import {
  conciseThreadTitle,
  freezeStoredMessage,
  parseJson,
  parseTurnPayload,
  summarizeExperience,
  type MessageMetadata,
  type MessageRow,
  type TurnPayload,
} from './sqliteStoreCodecs.js';
import type { PersistedExperienceEvent } from './sqliteStore.js';
import type { SQLiteStoreContext } from './sqliteStoreContext.js';
import { insertTurnCaptures, selectTurnCaptures, type TurnCaptureRecord } from './turnCaptures.js';

interface EventRow { sequence: number; event_id: string; scope_key: string; event_type: string; observed_at: string; payload_json: string; }
interface ThreadRow { thread_id: string; title: string; created_at: string; updated_at: string; message_count: number; summary: string | null; }
interface ThreadNavigationRow { thread_id: string; content: string; }
function boundedStoredThreadSummary(value: string | null | undefined): string | undefined {
  const compact = value?.trim();
  if (!compact) return undefined;
  const characters = Array.from(compact);
  return characters.length <= 180 ? compact : `${characters.slice(0, 179).join('')}…`;
}

/** A thread longer than this is judged on its most recent turns. */
const MAXIMUM_LINEAGE_MESSAGES = 4_000;

/** Additive and outside the numbered migrations, so an older API binary still opens the database. */
export function ensureSummaryLineageSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info('conversation_threads')").all() as unknown as Array<{ name: string }>;
  if (columns.length && !columns.some(column => column.name === 'summary_chain_started_at')) {
    database.exec('ALTER TABLE conversation_threads ADD COLUMN summary_chain_started_at TEXT;');
  }
}

function experienceFromRow(row: EventRow): ShannonExperience[] {
  const payload = parseTurnPayload(row.payload_json);
  if (!payload) return [];
  const recalledMemoryIds = boundedRecalledMemoryIds(payload.recalledMemoryIds);
  return [Object.freeze({
    id: row.event_id,
    userMessage: payload.userMessage,
    shannonReply: payload.shannonReply,
    summary: payload.summary,
    observedAt: row.observed_at,
    ...(payload.timeZone ? { timeZone: payload.timeZone } : {}),
    ...(recalledMemoryIds ? { recalledMemoryIds } : {}),
  })];
}

export class SQLiteConversationRepository implements ConversationStore {
  constructor(private readonly context: SQLiteStoreContext) {}

  listThreads(scopeKey: string): readonly ConversationThread[] {
    const rows = this.context.database.prepare(`
      SELECT thread_id, title, created_at, updated_at, summary,
        (SELECT COUNT(*) FROM conversation_messages cm WHERE cm.scope_key = ct.scope_key AND cm.thread_id = ct.thread_id) AS message_count
      FROM conversation_threads ct
      WHERE ct.scope_key = ? AND ct.archived_at IS NULL
      ORDER BY ct.updated_at DESC, ct.created_at DESC
    `).all(scopeKey) as unknown as ThreadRow[];
    const navigationRows = this.context.database.prepare(`
      SELECT thread_id, content
      FROM conversation_messages
      WHERE scope_key = ? AND role = 'assistant'
      ORDER BY observed_at ASC, message_id ASC
    `).all(scopeKey) as unknown as ThreadNavigationRow[];
    const messagesByThread = new Map<string, Array<{ role: 'assistant'; content: string }>>();
    for (const row of navigationRows) {
      const messages = messagesByThread.get(row.thread_id) ?? [];
      messages.push({ role: 'assistant', content: row.content });
      messagesByThread.set(row.thread_id, messages);
    }
    return Object.freeze(rows.map(row => {
      const navigation = threadNavigation(messagesByThread.get(row.thread_id) ?? []);
      const rollingSummary = boundedStoredThreadSummary(row.summary);
      const effectiveSummary = rollingSummary ?? navigation.summary;
      return Object.freeze({
        threadId: row.thread_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: Number(row.message_count),
        ...(effectiveSummary ? { summary: effectiveSummary } : {}),
        ...(navigation.sections.length ? { sections: navigation.sections } : {}),
      });
    }));
  }

  threadId(scopeKey: string, threadId?: string): string {
    const preferred = threadId?.trim();
    if (preferred) {
      this.ensureThread(scopeKey, preferred, null);
      this.context.defaultThreadCache.set(scopeKey, preferred);
      return preferred;
    }
    const cached = this.context.defaultThreadCache.get(scopeKey);
    if (cached) return cached;

    const threads = this.listThreads(scopeKey);
    if (threads[0]) {
      this.context.defaultThreadCache.set(scopeKey, threads[0].threadId);
      return threads[0].threadId;
    }
    const created = this.createThread(scopeKey);
    this.context.defaultThreadCache.set(scopeKey, created);
    return created;
  }

  private ensureThread(scopeKey: string, threadId: string, title: string | null): void {
    const now = this.context.now();
    this.context.database.prepare(`
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
    const result = this.context.database.prepare(`
      UPDATE conversation_threads
      SET title = ?, title_origin = 'manual', updated_at = ?
      WHERE scope_key = ? AND thread_id = ? AND archived_at IS NULL
    `).run(title, this.context.now(), scopeKey, threadId);
    return Number(result.changes) > 0;
  }

  needsAutomaticThreadTitle(scopeKey: string, threadId: string): boolean {
    return Boolean(this.context.database.prepare(`
      SELECT 1 FROM conversation_threads
      WHERE scope_key = ? AND thread_id = ? AND title_origin = 'pending' AND archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation_messages WHERE scope_key = ? AND thread_id = ? AND role = 'user'
        )
    `).get(scopeKey, threadId, scopeKey, threadId));
  }

  archiveThread(scopeKey: string, threadId: string): boolean {
    const result = this.context.database.prepare(`
      UPDATE conversation_threads SET archived_at = ?
      WHERE scope_key = ? AND thread_id = ? AND archived_at IS NULL
    `).run(this.context.now(), scopeKey, threadId);
    if (Number(result.changes) > 0 && this.context.defaultThreadCache.get(scopeKey) === threadId) {
      this.context.defaultThreadCache.delete(scopeKey);
    }
    return Number(result.changes) > 0;
  }

  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[] {
    return Object.freeze(this.conversationHistory(scopeKey, threadId)
      .slice(-this.context.maximumModelConversationItems)
      .map(item => Object.freeze({ role: item.role, content: item.content })));
  }

  threadSummary(scopeKey: string, threadId: string): string | undefined {
    const row = this.context.database.prepare(`
      SELECT summary FROM conversation_threads
      WHERE scope_key = ? AND thread_id = ? AND archived_at IS NULL
    `).get(scopeKey, threadId) as unknown as { summary: string | null } | undefined;
    const rollingSummary = boundedStoredThreadSummary(row?.summary);
    if (rollingSummary) return rollingSummary;
    const latest = this.context.database.prepare(`
      SELECT content FROM conversation_messages
      WHERE scope_key = ? AND thread_id = ? AND role = 'assistant'
      ORDER BY sequence DESC LIMIT 1
    `).get(scopeKey, threadId) as unknown as { content: string } | undefined;
    return latest ? threadNavigation([{ role: 'assistant', content: latest.content }]).summary : undefined;
  }

  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[] {
    const effectiveThreadId = this.threadId(scopeKey, threadId);
    const rows = this.context.database.prepare(`
      SELECT message_id, thread_id, turn_id, role, content, observed_at, metadata_json
      FROM (
        SELECT sequence, message_id, thread_id, turn_id, role, content, observed_at, metadata_json
        FROM conversation_messages
        WHERE scope_key = ? AND thread_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence ASC
    `).all(scopeKey, effectiveThreadId, this.context.maximumDisplayedConversationItems) as unknown as MessageRow[];
    return Object.freeze(rows.map(row => freezeStoredMessage(row)));
  }

  experienceCandidates(scopeKey: string): readonly ShannonExperience[] {
    const rows = this.context.database.prepare(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
      FROM experience_events
      WHERE scope_key = ? AND event_type = 'turn.completed'
      ORDER BY sequence DESC
      LIMIT ?
    `).all(scopeKey, this.context.maximumExperiences) as unknown as EventRow[];
    return Object.freeze(rows.reverse().flatMap(experienceFromRow));
  }

  experiencesById(scopeKey: string, experienceIds: readonly string[]): readonly ShannonExperience[] {
    const ids = [...new Set(experienceIds)].slice(0, 200);
    if (!ids.length) return Object.freeze([]);
    const rows = this.context.database.prepare(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json FROM experience_events
      WHERE scope_key = ? AND event_type = 'turn.completed' AND event_id IN (${ids.map(() => '?').join(', ')})
    `).all(scopeKey, ...ids) as unknown as EventRow[];
    return Object.freeze(rows.flatMap(experienceFromRow));
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
    const threadSummary = context?.threadSummary ?? threadNavigation([
      { role: 'assistant', content: shannonReply },
    ]).summary ?? null;
    const recalledMemoryIds = boundedRecalledMemoryIds(context?.recalledMemoryIds);
    const payload: TurnPayload = {
      userMessage,
      shannonReply,
      summary,
      ...(recalledMemoryIds ? { recalledMemoryIds } : {}),
      ...(context?.timeZone ? { timeZone: context.timeZone } : {}),
      ...(context ? {
        capturedStateVersion: context.capturedStateVersion,
        messageEmotion: context.messageEmotion,
        ...(context.taskDecision ? { taskDecision: context.taskDecision } : {}),
      } : {}),
    };
    this.context.transaction(() => {
      // Recheck after the model await: a manual edit or another completed turn wins.
      if (this.needsAutomaticThreadTitle(scopeKey, effectiveThreadId)) {
        this.context.database.prepare(`
          UPDATE conversation_threads SET title = ?, title_origin = 'automatic'
          WHERE scope_key = ? AND thread_id = ? AND title_origin = 'pending' AND archived_at IS NULL
        `).run(initialThreadTitle(context?.threadTitle, userMessage), scopeKey, effectiveThreadId);
      }
      // A summary written without the stored prior summary starts a fresh chain built from visible history only.
      this.context.database.prepare(`
        UPDATE conversation_threads SET updated_at = ?, summary = ?,
          summary_chain_started_at = CASE WHEN ? THEN summary_chain_started_at ELSE ? END
        WHERE scope_key = ? AND thread_id = ?
      `).run(observedAt, threadSummary, context?.summaryContinuesChain ? 1 : 0, observedAt, scopeKey, effectiveThreadId);
      const insert = this.context.database.prepare(`
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
          ...(recalledMemoryIds ? { recalledMemoryIds } : {}),
        } satisfies MessageMetadata) : null,
      );
      this.context.insertEvent(scopeKey, 'turn.completed', observedAt, payload, turnId);
      this.context.insertActivity(scopeKey, 'conversation', 'トーク', summary, observedAt, { threadId: effectiveThreadId });
    });
    return Object.freeze({ id: turnId, userMessage, shannonReply, summary, observedAt });
  }

  appendNote(scopeKey: string, threadId: string, content: string, observedAt: string, noteKind: string): StoredConversationMessage {
    const effectiveThreadId = this.threadId(scopeKey, threadId);
    this.ensureThread(scopeKey, effectiveThreadId, null);
    const row: MessageRow = {
      message_id: randomUUID(), thread_id: effectiveThreadId, turn_id: `${noteKind}:${randomUUID()}`,
      role: 'assistant', content, observed_at: observedAt, metadata_json: JSON.stringify({ noteKind }),
    };
    this.context.transaction(() => {
      // No user row and no experience event: the note is display history only.
      this.context.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(row.message_id, scopeKey, effectiveThreadId, row.turn_id, content, observedAt, row.metadata_json);
      this.context.database.prepare(`
        UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?
      `).run(observedAt, scopeKey, effectiveThreadId);
    });
    return freezeStoredMessage(row);
  }

  ingestPlatformTurn(input: PlatformTurnPersistenceInput): PlatformTurnPersistenceResult {
    return this.context.transaction(() => {
      const previous = this.context.database.prepare(`
        SELECT payload_hash, experience_id
        FROM platform_turn_receipts
        WHERE scope_key = ? AND platform = ? AND request_id = ?
      `).get(input.scopeKey, input.platform, input.requestId) as unknown as {
        payload_hash: string;
        experience_id: string;
      } | undefined;
      if (previous) {
        if (previous.payload_hash !== input.payloadHash) throw new Error('PLATFORM_TURN_CONFLICT');
        const event = this.context.database.prepare(`
          SELECT observed_at, payload_json
          FROM experience_events
          WHERE event_id = ? AND scope_key = ? AND event_type = 'turn.completed'
        `).get(previous.experience_id, input.scopeKey) as unknown as {
          observed_at: string;
          payload_json: string;
        } | undefined;
        const turn = event ? parseTurnPayload(event.payload_json) : null;
        if (!event || !turn) throw new Error('PLATFORM_TURN_RECEIPT_CORRUPT');
        return {
          duplicate: true,
          experience: Object.freeze({
            id: previous.experience_id,
            userMessage: turn.userMessage,
            shannonReply: turn.shannonReply,
            summary: turn.summary,
            observedAt: event.observed_at,
          }),
        };
      }
      const experience = this.appendTurn(
        input.scopeKey,
        input.threadId,
        input.userMessage,
        input.shannonReply,
        input.observedAt,
        input.context,
      );
      this.context.database.prepare(`
        INSERT INTO platform_turn_receipts
          (scope_key, platform, request_id, payload_hash, thread_id, experience_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.scopeKey,
        input.platform,
        input.requestId,
        input.payloadHash,
        input.threadId,
        experience.id,
        input.observedAt,
      );
      return { duplicate: false, experience };
    });
  }

  threadSummaryLineage(scopeKey: string, threadId: string): ThreadSummaryLineage {
    const thread = this.context.database.prepare(`
      SELECT summary_chain_started_at, updated_at FROM conversation_threads WHERE scope_key = ? AND thread_id = ?
    `).get(scopeKey, threadId) as unknown as { summary_chain_started_at: string | null; updated_at: string } | undefined;
    const rows = this.context.database.prepare(`
      SELECT message_id, thread_id, turn_id, role, content, observed_at, metadata_json
      FROM conversation_messages WHERE scope_key = ? AND thread_id = ?
      ORDER BY sequence DESC LIMIT ?
    `).all(scopeKey, threadId, MAXIMUM_LINEAGE_MESSAGES) as unknown as MessageRow[];
    return Object.freeze({
      ...(thread?.summary_chain_started_at ? { chainStartedAt: thread.summary_chain_started_at } : {}),
      ...(thread ? { updatedAt: thread.updated_at } : {}),
      messages: Object.freeze(rows.map(row => freezeStoredMessage(row))),
    });
  }

  recordTurnCaptures(scopeKey: string, captures: readonly TurnCaptureRecord[]): void {
    if (captures.length) this.context.transaction(() => insertTurnCaptures(this.context.database, scopeKey, captures));
  }

  turnCaptures(scopeKey: string, turnIds: readonly string[]): readonly TurnCaptureRecord[] {
    return Object.freeze(selectTurnCaptures(this.context.database, scopeKey, turnIds));
  }

  events(scopeKey: string): readonly PersistedExperienceEvent[] {
    const rows = this.context.database.prepare(`
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
    const rows = this.context.database.prepare(`
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


}
