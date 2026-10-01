import { randomUUID } from 'node:crypto';
import {
  disclosureFor, searchMemoryDocuments,
  type MemoryAudience, type MemoryDisclosure, type RecallCandidate, type ShannonMessageEmotion,
} from '@shannon/cognition';
import type { MemorySearchHit } from './sqliteMemorySearch.js';
import type { ShannonConversationItem, ShannonGeneratedArtifact } from './chatModel.js';
import type { ShannonTaskDecision } from './chatModel.js';
import { DEFAULT_THREAD_TITLE, initialThreadTitle } from './threadTitle.js';
import type { ReminderReference, ReminderView, TurnCaptureRecord, TurnCaptureView } from './turnCaptures.js';

export interface ShannonExperience extends RecallCandidate {
  timeZone?: string;
  userMessage: string;
  shannonReply: string;
  /** Memory, knowledge and summary IDs recalled into this turn's prompt. Absent on turns recorded before provenance. */
  recalledMemoryIds?: readonly string[];
  /** Who was present and whether the turn is sensitive. Absent on turns recorded before labels: owner-only, sensitive. */
  disclosure?: MemoryDisclosure;
}

/** The label a completed turn is stored with: decided here, when it is written, by deterministic rules. */
export function turnDisclosure(userMessage: string, shannonReply: string, context?: Pick<TurnPersistenceContext, 'audience' | 'speaker'>): MemoryDisclosure {
  return disclosureFor(`${userMessage}\n${shannonReply}`, context?.audience, context?.speaker ? { speaker: context.speaker } : {});
}

/** What a thread's rolling summary was built from: when its chain last started fresh, and the thread's turns. */
export interface ThreadSummaryLineage {
  /** Absent for summaries written before lineage was recorded: the chain may reach back to the first turn. */
  chainStartedAt?: string;
  updatedAt?: string;
  messages: readonly StoredConversationMessage[];
}

export const MAXIMUM_RECALLED_MEMORY_IDS = 40;

export function boundedRecalledMemoryIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Object.freeze(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
    .slice(0, MAXIMUM_RECALLED_MEMORY_IDS));
}

export interface ShannonSourceAttribution {
  title: string;
  url: string;
  reason: string;
}

export interface ConversationThread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  summary?: string;
  sections?: readonly string[];
}

export interface StoredConversationMessage extends ShannonConversationItem {
  id: string;
  /** Durable turn.completed event that owns this message, when available. */
  sourceExperienceId?: string;
  observedAt: string;
  messageEmotion?: ShannonMessageEmotion;
  stateVersion?: number;
  taskDecision?: ShannonTaskDecision;
  artifacts?: readonly ShannonGeneratedArtifact[];
  sourceAttribution?: ShannonSourceAttribution;
  /** The promise a reminder message is about; resolved to a `ReminderView` for clients. */
  reminder?: ReminderReference | ReminderView;
  /** What Shannon took in from this turn, attached to her reply once the worker has recorded it. */
  captures?: readonly TurnCaptureView[];
  /** Provenance of a reply: IDs recalled into its prompt. Server-side only; never sent to clients. */
  recalledMemoryIds?: readonly string[];
}

export interface TurnPersistenceContext {
  timeZone?: string;
  threadTitle?: string;
  threadSummary?: string;
  messageEmotion: ShannonMessageEmotion;
  capturedStateVersion: number;
  taskDecision?: ShannonTaskDecision;
  artifacts?: readonly ShannonGeneratedArtifact[];
  /** IDs of the memories, knowledge and summaries recalled into this turn's prompt. */
  recalledMemoryIds?: readonly string[];
  /** True only when the model was given the stored prior summary and wrote the next one from it. */
  summaryContinuesChain?: boolean;
  /** Who was present for this turn. Absent: the owner alone. */
  audience?: MemoryAudience;
  /** Who spoke the user side. Absent: the owner when alone, otherwise unknown. */
  speaker?: 'owner' | 'unknown';
}

export interface PlatformTurnPersistenceInput {
  scopeKey: string;
  platform: string;
  requestId: string;
  payloadHash: string;
  threadId: string;
  userMessage: string;
  shannonReply: string;
  observedAt: string;
  context: TurnPersistenceContext;
}

export interface PlatformTurnPersistenceResult {
  duplicate: boolean;
  experience: ShannonExperience;
}

export interface ConversationStore {
  listThreads(scopeKey: string): readonly ConversationThread[];
  threadId(scopeKey: string, threadId?: string): string;
  createThread(scopeKey: string, title?: string): string;
  renameThread(scopeKey: string, threadId: string, title: string): boolean;
  needsAutomaticThreadTitle(scopeKey: string, threadId: string): boolean;
  archiveThread(scopeKey: string, threadId: string): boolean;
  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[];
  threadSummary(scopeKey: string, threadId: string): string | undefined;
  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[];
  experienceCandidates(scopeKey: string, threadId?: string): readonly ShannonExperience[];
  /** Deterministic full-text recall over all experiences and thread summaries. */
  searchMemory?(scopeKey: string, text: string, limit?: number): readonly MemorySearchHit[];
  appendTurn(
    scopeKey: string,
    threadId: string,
    userMessage: string,
    shannonReply: string,
    observedAt: string,
    context?: TurnPersistenceContext,
  ): ShannonExperience;
  ingestPlatformTurn(input: PlatformTurnPersistenceInput): PlatformTurnPersistenceResult;
  /**
   * Adds a Shannon-authored note to a thread without a user message and without an
   * experience event, so it never becomes a memory, promise, or profile source.
   */
  appendNote?(scopeKey: string, threadId: string, content: string, observedAt: string, noteKind: string): StoredConversationMessage;
  /** Durable per-turn capture records. Optional so lightweight stores stay valid. */
  recordTurnCaptures?(scopeKey: string, captures: readonly TurnCaptureRecord[]): void;
  turnCaptures?(scopeKey: string, turnIds: readonly string[]): readonly TurnCaptureRecord[];
  /** Lineage of a thread's rolling summary. A store without it cannot prove a summary clean. */
  threadSummaryLineage?(scopeKey: string, threadId: string): ThreadSummaryLineage;
  /** Completed turns by ID, including ones older than the recent candidate window. */
  experiencesById?(scopeKey: string, experienceIds: readonly string[]): readonly ShannonExperience[];
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Map<string, StoredConversationMessage[]>>();
  private readonly threadTitles = new Map<string, Map<string, string>>();
  private readonly threadSummaries = new Map<string, Map<string, string>>();
  private readonly protectedTitles = new Map<string, Set<string>>();
  private readonly experiences = new Map<string, ShannonExperience[]>();
  private readonly archivedThreads = new Map<string, Set<string>>();
  private readonly platformReceipts = new Map<string, { payloadHash: string; experience: ShannonExperience }>();

  private readonly defaultThreadCache = new Map<string, string>();
  private readonly captures = new Map<string, Map<string, TurnCaptureRecord>>();
  private readonly summaryChains = new Map<string, string>();

  constructor(
    private readonly maximumConversationItems = 200,
    private readonly maximumExperiences = 1_000,
    private readonly maximumModelConversationItems = 20,
  ) {}

  listThreads(scopeKey: string): readonly ConversationThread[] {
    const threads = this.conversations.get(scopeKey);
    if (!threads || threads.size === 0) return [];
    const threadTitles = this.threadTitles.get(scopeKey) ?? new Map<string, string>();
    const archived = this.archivedThreads.get(scopeKey) ?? new Set<string>();
    return Object.freeze(Array.from(threads.entries()).filter(([threadId]) => !archived.has(threadId)).map(([threadId, messages]) => {
      const ordered = [...messages].sort((left, right) => left.observedAt.localeCompare(right.observedAt));
      const last = ordered[ordered.length - 1];
      const customTitle = threadTitles.get(threadId);
      const navigation = threadNavigation(messages);
      const rollingSummary = this.threadSummaries.get(scopeKey)?.get(threadId);
      const effectiveSummary = rollingSummary ?? navigation.summary;
      return Object.freeze({
        threadId,
        title: customTitle ?? DEFAULT_THREAD_TITLE,
        createdAt: ordered[0]?.observedAt ?? new Date().toISOString(),
        updatedAt: last?.observedAt ?? new Date().toISOString(),
        messageCount: messages.length,
        ...(effectiveSummary ? { summary: effectiveSummary } : {}),
        ...(navigation.sections.length ? { sections: navigation.sections } : {}),
      });
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  threadId(scopeKey: string, threadId?: string): string {
    const cache = this.defaultThreadCache.get(scopeKey);
    if (threadId && cache !== threadId) {
      this.defaultThreadCache.set(scopeKey, threadId);
      return threadId;
    }
    if (cache) return cache;
    const threads = this.listThreads(scopeKey);
    const selected = threads.at(0)?.threadId ?? `thread-${randomUUID()}`;
    this.defaultThreadCache.set(scopeKey, selected);
    return selected;
  }

  createThread(scopeKey: string, title?: string): string {
    const threadId = randomUUID();
    const threads = this.conversations.get(scopeKey) ?? new Map<string, StoredConversationMessage[]>();
    const threadTitles = this.threadTitles.get(scopeKey) ?? new Map<string, string>();
    threads.set(threadId, []);
    threadTitles.set(threadId, title?.trim() || DEFAULT_THREAD_TITLE);
    if (title?.trim()) this.protectTitle(scopeKey, threadId);
    this.conversations.set(scopeKey, threads);
    this.threadTitles.set(scopeKey, threadTitles);
    this.defaultThreadCache.set(scopeKey, threadId);
    return threadId;
  }

  renameThread(scopeKey: string, threadId: string, title: string): boolean {
    const threads = this.conversations.get(scopeKey);
    if (!threads?.has(threadId) || this.archivedThreads.get(scopeKey)?.has(threadId)) return false;
    const threadTitles = this.threadTitles.get(scopeKey) ?? new Map<string, string>();
    threadTitles.set(threadId, title);
    this.threadTitles.set(scopeKey, threadTitles);
    this.protectTitle(scopeKey, threadId);
    return true;
  }

  private protectTitle(scopeKey: string, threadId: string): void {
    const protectedTitles = this.protectedTitles.get(scopeKey) ?? new Set<string>();
    protectedTitles.add(threadId);
    this.protectedTitles.set(scopeKey, protectedTitles);
  }

  needsAutomaticThreadTitle(scopeKey: string, threadId: string): boolean {
    return !this.protectedTitles.get(scopeKey)?.has(threadId)
      && !this.archivedThreads.get(scopeKey)?.has(threadId)
      && !(this.conversations.get(scopeKey)?.get(threadId) ?? []).some(item => item.role === 'user');
  }

  archiveThread(scopeKey: string, threadId: string): boolean {
    if (!this.conversations.get(scopeKey)?.has(threadId)) return false;
    const archived = this.archivedThreads.get(scopeKey) ?? new Set<string>();
    archived.add(threadId);
    this.archivedThreads.set(scopeKey, archived);
    if (this.defaultThreadCache.get(scopeKey) === threadId) this.defaultThreadCache.delete(scopeKey);
    return true;
  }

  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[] {
    return Object.freeze(this.conversationHistory(scopeKey, threadId)
      .slice(-this.maximumModelConversationItems)
      .map(item => Object.freeze({ role: item.role, content: item.content })));
  }

  threadSummary(scopeKey: string, threadId: string): string | undefined {
    return this.threadSummaries.get(scopeKey)?.get(threadId)
      ?? threadNavigation(this.conversations.get(scopeKey)?.get(threadId) ?? []).summary;
  }

  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[] {
    const effectiveThreadId = this.threadId(scopeKey, threadId);
    const threadMessages = this.conversations.get(scopeKey)?.get(effectiveThreadId) ?? [];
    return Object.freeze(threadMessages.map(item => Object.freeze({
      ...item,
      ...(item.messageEmotion ? { messageEmotion: Object.freeze({ ...item.messageEmotion }) } : {}),
      ...(item.artifacts?.length ? {
        artifacts: Object.freeze(item.artifacts.map(artifact => Object.freeze({ ...artifact }))),
      } : {}),
      ...(item.sourceAttribution ? {
        sourceAttribution: Object.freeze({ ...item.sourceAttribution }),
      } : {}),
    })));
  }

  experienceCandidates(scopeKey: string, threadId?: string): readonly ShannonExperience[] {
    this.threadId(scopeKey, threadId);
    return Object.freeze((this.experiences.get(scopeKey) ?? []).map(item => Object.freeze({ ...item })));
  }

  searchMemory(scopeKey: string, text: string, limit = 12): readonly MemorySearchHit[] {
    const archived = this.archivedThreads.get(scopeKey) ?? new Set<string>();
    const documents = [
      ...(this.experiences.get(scopeKey) ?? []).map(item => ({ id: item.id, text: item.summary, observedAt: item.observedAt })),
      ...[...(this.threadSummaries.get(scopeKey) ?? new Map<string, string>())]
        .filter(([threadId]) => !archived.has(threadId))
        .map(([threadId, summary]) => ({ id: `thread:${threadId}`, text: `${this.threadTitles.get(scopeKey)?.get(threadId) ?? ''} ${summary}`,
          observedAt: (this.conversations.get(scopeKey)?.get(threadId) ?? []).map(item => item.observedAt).sort().at(-1) ?? '1970-01-01T00:00:00.000Z' })),
    ];
    return Object.freeze(searchMemoryDocuments(text, documents, limit).map(document => Object.freeze({
      kind: document.id.startsWith('thread:') ? 'thread' as const : 'experience' as const,
      id: document.id,
      sourceId: document.id.replace(/^thread:/u, ''),
      ...(document.id.startsWith('thread:') ? { threadId: document.id.slice(7) } : {}),
      summary: document.text,
      observedAt: document.observedAt,
      score: 1,
    })));
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
    const resolvedThreadId = this.threadId(scopeKey, threadId);
    const threads = this.conversations.get(scopeKey) ?? new Map<string, StoredConversationMessage[]>();
    const conversation = threads.get(resolvedThreadId) ?? [];
    if (this.needsAutomaticThreadTitle(scopeKey, resolvedThreadId)) {
      const titles = this.threadTitles.get(scopeKey) ?? new Map<string, string>();
      titles.set(resolvedThreadId, initialThreadTitle(context?.threadTitle, userMessage));
      this.threadTitles.set(scopeKey, titles);
      this.protectTitle(scopeKey, resolvedThreadId);
    }
    const summaries = this.threadSummaries.get(scopeKey) ?? new Map<string, string>();
    const nextSummary = context?.threadSummary ?? threadNavigation([
      { role: 'assistant', content: shannonReply },
    ]).summary;
    if (nextSummary) summaries.set(resolvedThreadId, nextSummary);
    this.threadSummaries.set(scopeKey, summaries);
    if (!context?.summaryContinuesChain) this.summaryChains.set(`${scopeKey}\u0000${resolvedThreadId}`, observedAt);
    const recalledMemoryIds = boundedRecalledMemoryIds(context?.recalledMemoryIds);
    conversation.push(
      { id: randomUUID(), sourceExperienceId: turnId, role: 'user', content: userMessage, observedAt },
      {
        id: randomUUID(),
        sourceExperienceId: turnId,
        role: 'assistant',
        content: shannonReply,
        observedAt,
        ...(recalledMemoryIds ? { recalledMemoryIds } : {}),
        ...(context ? {
          messageEmotion: Object.freeze({ ...context.messageEmotion }),
          stateVersion: context.capturedStateVersion,
          ...(context.taskDecision ? { taskDecision: Object.freeze({ ...context.taskDecision }) } : {}),
          ...(context.artifacts?.length ? {
            artifacts: Object.freeze(context.artifacts.map(artifact => Object.freeze({ ...artifact }))),
          } : {}),
        } : {}),
      },
    );
    threads.set(resolvedThreadId, conversation.slice(-this.maximumConversationItems));
    this.conversations.set(scopeKey, threads);
    this.defaultThreadCache.set(scopeKey, resolvedThreadId);

    const experiences = this.experiences.get(scopeKey) ?? [];
    const experience: ShannonExperience = Object.freeze({
      id: turnId,
      userMessage,
      shannonReply,
      summary: summarizeExperience(userMessage, shannonReply),
      observedAt,
      ...(context?.timeZone ? { timeZone: context.timeZone } : {}),
      ...(recalledMemoryIds ? { recalledMemoryIds } : {}),
      disclosure: turnDisclosure(userMessage, shannonReply, context),
    });
    experiences.push(experience);
    this.experiences.set(scopeKey, experiences.slice(-this.maximumExperiences));
    return experience;
  }

  appendNote(scopeKey: string, threadId: string, content: string, observedAt: string, noteKind: string): StoredConversationMessage {
    const resolvedThreadId = this.threadId(scopeKey, threadId);
    const threads = this.conversations.get(scopeKey) ?? new Map<string, StoredConversationMessage[]>();
    const conversation = threads.get(resolvedThreadId) ?? [];
    const note: StoredConversationMessage = {
      id: randomUUID(), sourceExperienceId: `${noteKind}:${randomUUID()}`, role: 'assistant', content, observedAt,
    };
    conversation.push(note);
    threads.set(resolvedThreadId, conversation.slice(-this.maximumConversationItems));
    this.conversations.set(scopeKey, threads);
    return Object.freeze({ ...note });
  }

  threadSummaryLineage(scopeKey: string, threadId: string): ThreadSummaryLineage {
    const messages = this.conversations.get(scopeKey)?.get(threadId) ?? [];
    const chainStartedAt = this.summaryChains.get(`${scopeKey}\u0000${threadId}`);
    const updatedAt = messages.at(-1)?.observedAt;
    return Object.freeze({ ...(chainStartedAt ? { chainStartedAt } : {}), ...(updatedAt ? { updatedAt } : {}), messages: Object.freeze([...messages]) });
  }

  experiencesById(scopeKey: string, experienceIds: readonly string[]): readonly ShannonExperience[] {
    const wanted = new Set(experienceIds);
    return Object.freeze((this.experiences.get(scopeKey) ?? []).filter(item => wanted.has(item.id)));
  }

  recordTurnCaptures(scopeKey: string, captures: readonly TurnCaptureRecord[]): void {
    const rows = this.captures.get(scopeKey) ?? new Map<string, TurnCaptureRecord>();
    for (const capture of captures) if (!rows.has(capture.id)) rows.set(capture.id, Object.freeze({ ...capture }));
    this.captures.set(scopeKey, rows);
  }

  turnCaptures(scopeKey: string, turnIds: readonly string[]): readonly TurnCaptureRecord[] {
    const wanted = new Set(turnIds);
    return Object.freeze([...this.captures.get(scopeKey)?.values() ?? []].filter(capture => wanted.has(capture.turnId)));
  }

  ingestPlatformTurn(input: PlatformTurnPersistenceInput): PlatformTurnPersistenceResult {
    const key = `${input.scopeKey}\u0000${input.platform}\u0000${input.requestId}`;
    const previous = this.platformReceipts.get(key);
    if (previous) {
      if (previous.payloadHash !== input.payloadHash) throw new Error('PLATFORM_TURN_CONFLICT');
      return { duplicate: true, experience: previous.experience };
    }
    const experience = this.appendTurn(
      input.scopeKey,
      input.threadId,
      input.userMessage,
      input.shannonReply,
      input.observedAt,
      input.context,
    );
    this.platformReceipts.set(key, { payloadHash: input.payloadHash, experience });
    return { duplicate: false, experience };
  }
}

function summarizeExperience(userMessage: string, shannonReply: string): string {
  const user = userMessage.replace(/\s+/g, ' ').trim().slice(0, 220);
  const shannon = shannonReply.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `ユーザー: ${user} / シャノン: ${shannon}`;
}

export function threadNavigation(
  messages: readonly Pick<StoredConversationMessage, 'role' | 'content'>[],
): { summary?: string; sections: readonly string[] } {
  const assistantMessages = messages.filter(message => message.role === 'assistant');
  const latest = assistantMessages.at(-1)?.content ?? '';
  const compactSummary = latest
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>`~\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const summaryCharacters = Array.from(compactSummary);
  const summary = summaryCharacters.length <= 180
    ? compactSummary
    : `${summaryCharacters.slice(0, 179).join('')}…`;
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const message of assistantMessages) {
    let insideCode = false;
    for (const rawLine of message.content.replace(/\r\n/g, '\n').split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('```')) {
        insideCode = !insideCode;
        continue;
      }
      if (insideCode) continue;
      const match = /^(#{1,6})\s+(.+)$/.exec(line);
      const title = match?.[2]?.trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      sections.push(title.slice(0, 100));
    }
  }
  return {
    ...(summary ? { summary } : {}),
    sections: Object.freeze(sections.slice(-12)),
  };
}
