import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ShannonConversationItem } from '../models/chatModel.js';
import { normalizeDisclosure } from '@shannon/cognition';
import {
  boundedRecalledMemoryIds,
  threadNavigation,
  turnDisclosure,
  isPlatformThreadId,
  type ThreadSummaryLineage,
  type ConversationStore,
  type ConversationThread,
  type PlatformTurnPersistenceInput,
  type PlatformTurnPersistenceResult,
  type ShannonExperience,
  type StoredConversationMessage,
  type TurnPersistenceContext,
} from '../../mind/memory/store/conversationStore.js';
import type { ActivityItem } from '../../mind/memory/memoryService.js';
import { DEFAULT_THREAD_TITLE, initialThreadTitle } from '../../surfaces/text/threadTitle.js';
import { parsedRow, readWhileUnchanged } from './experienceCandidateReads.js';
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
import { REPORT_CARD_NOTE_KIND, type ReportCardNote } from '../../contracts/conversationExtrasContract.js';
import { insertTurnCaptures, selectTurnCaptures, type TurnCaptureRecord } from '../../mind/memory/store/turnCaptures.js';

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

function experienceFromRow(row: Pick<EventRow, 'event_id' | 'observed_at' | 'payload_json'>): ShannonExperience[] {
  const payload = parseTurnPayload(row.payload_json);
  if (!payload) return [];
  const recalledMemoryIds = payload.source === 'fca.task' && Array.isArray(payload.recalledMemoryIds)
    ? payload.recalledMemoryIds.filter(id => typeof id === 'string' && id.length <= 240).slice(0, 5000) : boundedRecalledMemoryIds(payload.recalledMemoryIds);
  // An unreadable or absent label stays absent: owner-only and sensitive.
  const disclosure = normalizeDisclosure(payload.disclosure);
  return [Object.freeze({
    id: row.event_id,
    userMessage: payload.userMessage,
    shannonReply: payload.shannonReply,
    summary: payload.summary,
    observedAt: row.observed_at,
    ...(payload.source === 'fca.task' && Array.isArray(payload.readSourceIds) ? { readSourceIds: payload.readSourceIds.filter(id => typeof id === 'string' && id.length <= 240).slice(0, 5000) } : {}),
    ...(payload.timeZone ? { timeZone: payload.timeZone } : {}),
    ...(recalledMemoryIds ? { recalledMemoryIds } : {}),
    ...(disclosure ? { disclosure } : {}),
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
    // A platform conversation (Discord, her Minecraft body…) is never the app's default Talk, and reading one creates
    // nothing: it is created when its first turn is stored (`appendTurn` ensures it).
    if (preferred && isPlatformThreadId(preferred)) return preferred;
    if (preferred) {
      this.ensureThread(scopeKey, preferred, null);
      this.context.defaultThreadCache.set(scopeKey, preferred);
      return preferred;
    }
    const cached = this.context.defaultThreadCache.get(scopeKey);
    if (cached) return cached;

    // The newest Talk of the app's own; a platform thread (game chat, Discord) that was written last is not one.
    const newest = this.listThreads(scopeKey).find(thread => !isPlatformThreadId(thread.threadId));
    if (newest) {
      this.context.defaultThreadCache.set(scopeKey, newest.threadId);
      return newest.threadId;
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

  assistantMessage(scopeKey: string, threadId: string, sourceOrMessageId: string): StoredConversationMessage | null {
    const row = this.context.database.prepare(`
      SELECT message_id, thread_id, turn_id, role, content, observed_at, metadata_json
      FROM conversation_messages WHERE scope_key=? AND thread_id=? AND role='assistant'
        AND (message_id=? OR turn_id=?) ORDER BY sequence DESC LIMIT 1
    `).get(scopeKey,threadId,sourceOrMessageId,sourceOrMessageId) as unknown as MessageRow | undefined;
    return row ? freezeStoredMessage(row) : null;
  }

  appendNoteOnce(scopeKey: string, threadId: string, messageId: string, content: string, observedAt: string, noteKind: string, ownerAlone?: boolean): StoredConversationMessage {
    return this.context.transaction(() => {
      const existing = this.assistantMessage(scopeKey,threadId,messageId);
      if (existing) {
        if (existing.content!==content || existing.sourceExperienceId!==`${noteKind}:${messageId}`) throw new Error('TASK_NOTE_CONFLICT');
        return existing;
      }
      this.ensureThread(scopeKey,threadId,null);
      const row:MessageRow={message_id:messageId,thread_id:threadId,turn_id:`${noteKind}:${messageId}`,role:'assistant',content,observed_at:observedAt,metadata_json:JSON.stringify({noteKind,...(typeof ownerAlone === 'boolean' ? {noteOwnerAlone:ownerAlone} : {})})};
      this.context.database.prepare(`INSERT INTO conversation_messages
        (message_id,scope_key,thread_id,turn_id,ordinal,role,content,observed_at,metadata_json)
        VALUES(?,?,?,?,1,'assistant',?,?,?)`).run(messageId,scopeKey,threadId,row.turn_id,content,observedAt,row.metadata_json);
      this.context.database.prepare('UPDATE conversation_threads SET updated_at=? WHERE scope_key=? AND thread_id=?').run(observedAt,scopeKey,threadId);
      return freezeStoredMessage(row);
    });
  }

  appendReportCardOnce(scopeKey: string, threadId: string, messageId: string, note: ReportCardNote): StoredConversationMessage {
    const { card, observedAt } = note;
    return this.context.transaction(() => {
      const existing = this.assistantMessage(scopeKey, threadId, messageId);
      if (existing) return existing;
      this.ensureThread(scopeKey, threadId, null);
      const recalled = boundedRecalledMemoryIds(note.recalledMemoryIds);
      const metadata = { noteKind: REPORT_CARD_NOTE_KIND, noteOwnerAlone: true, reportCard: card,
        ...(recalled?.length ? { recalledMemoryIds: recalled } : {}) };
      const row: MessageRow = { message_id: messageId, thread_id: threadId, turn_id: `${REPORT_CARD_NOTE_KIND}:${messageId}`, role: 'assistant',
        content: card.answer, observed_at: observedAt, metadata_json: JSON.stringify(metadata) };
      this.context.database.prepare(`INSERT INTO conversation_messages
        (message_id,scope_key,thread_id,turn_id,ordinal,role,content,observed_at,metadata_json)
        VALUES(?,?,?,?,1,'assistant',?,?,?)`).run(messageId, scopeKey, threadId, row.turn_id, row.content, observedAt, row.metadata_json);
      this.context.database.prepare('UPDATE conversation_threads SET updated_at=? WHERE scope_key=? AND thread_id=?')
        .run(observedAt, scopeKey, threadId);
      return freezeStoredMessage(row);
    });
  }

  experienceCandidates(scopeKey: string): readonly ShannonExperience[] { return readWhileUnchanged(this.context.database, scopeKey, () => {
    const rows = this.context.database.prepare(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
      FROM experience_events
      WHERE scope_key = ? AND event_type = 'turn.completed'
      ORDER BY sequence DESC
      LIMIT ?
    `).all(scopeKey, this.context.maximumExperiences) as unknown as EventRow[];
    return Object.freeze(rows.reverse().flatMap(row => parsedRow(this.context.database, scopeKey, row, this.context.maximumExperiences, experienceFromRow)));
  }); }

  experiencesById(scopeKey: string, experienceIds: readonly string[]): readonly ShannonExperience[] {
    const ids = [...new Set(experienceIds)].slice(0, 200);
    if (!ids.length) return Object.freeze([]);
    const rows = this.context.prepared(`
      SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json FROM experience_events
      WHERE scope_key = ? AND event_type = 'turn.completed' AND event_id IN (${ids.map(() => '?').join(', ')})
    `).all(scopeKey, ...ids) as unknown as EventRow[];
    return Object.freeze(rows.flatMap(experienceFromRow));
  }

  hasReadSourceProvenance(scopeKey: string): boolean {
    // Only canonical task:<uuid> experiences can own readSourceIds. Ordinary turns can inherit them by ID.
    // This fresh existence check is independent of FCA enablement and reads no payloads.
    // A range on the unique event_id index (`task:` up to, not including, `task;`), the same rows as GLOB 'task:*' without a scan:
    // this is asked at the start of every withholding read (2026-10-12: about a second per voice turn on 855 turns).
    return Boolean(this.context.prepared(`SELECT 1 FROM experience_events
      WHERE event_id >= 'task:' AND event_id < 'task;' AND +scope_key = ? AND +event_type = 'turn.completed' LIMIT 1`).get(scopeKey));
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
    const disclosure = turnDisclosure(userMessage, shannonReply, context);
    const payload: TurnPayload = {
      userMessage,
      shannonReply,
      summary,
      disclosure,
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
    return Object.freeze({ id: turnId, userMessage, shannonReply, summary, observedAt, disclosure });
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
        const experience = event ? experienceFromRow({ event_id: previous.experience_id, ...event })[0] : undefined;
        if (!experience) throw new Error('PLATFORM_TURN_RECEIPT_CORRUPT');
        return { duplicate: true, experience };
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
    const thread = this.context.prepared(`
      SELECT summary_chain_started_at, updated_at FROM conversation_threads WHERE scope_key = ? AND thread_id = ?
    `).get(scopeKey, threadId) as unknown as { summary_chain_started_at: string | null; updated_at: string } | undefined;
    const rows = this.context.prepared(`
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
