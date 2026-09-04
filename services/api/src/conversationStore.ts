import { randomUUID } from 'node:crypto';
import type { RecallCandidate, ShannonMessageEmotion } from '@shannon/cognition';
import type { ShannonConversationItem } from './chatModel.js';
import type { ShannonTaskDecision } from './chatModel.js';

export interface ShannonExperience extends RecallCandidate {
  userMessage: string;
  shannonReply: string;
}

export interface ConversationThread {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredConversationMessage extends ShannonConversationItem {
  id: string;
  observedAt: string;
  messageEmotion?: ShannonMessageEmotion;
  stateVersion?: number;
  taskDecision?: ShannonTaskDecision;
}

export interface TurnPersistenceContext {
  messageEmotion: ShannonMessageEmotion;
  capturedStateVersion: number;
  taskDecision?: ShannonTaskDecision;
}

export interface ConversationStore {
  listThreads(scopeKey: string): readonly ConversationThread[];
  threadId(scopeKey: string, threadId?: string): string;
  createThread(scopeKey: string, title?: string): string;
  renameThread(scopeKey: string, threadId: string, title: string): boolean;
  archiveThread(scopeKey: string, threadId: string): boolean;
  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[];
  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[];
  experienceCandidates(scopeKey: string, threadId?: string): readonly ShannonExperience[];
  appendTurn(
    scopeKey: string,
    threadId: string,
    userMessage: string,
    shannonReply: string,
    observedAt: string,
    context?: TurnPersistenceContext,
  ): ShannonExperience;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Map<string, StoredConversationMessage[]>>();
  private readonly threadTitles = new Map<string, Map<string, string>>();
  private readonly experiences = new Map<string, ShannonExperience[]>();
  private readonly archivedThreads = new Map<string, Set<string>>();

  private readonly defaultThreadCache = new Map<string, string>();

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
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const customTitle = threadTitles.get(threadId);
      return Object.freeze({
        threadId,
        title: customTitle ?? (first ? conciseTitle(first.content) : '新しいトーク'),
        createdAt: ordered[0]?.observedAt ?? new Date().toISOString(),
        updatedAt: last?.observedAt ?? new Date().toISOString(),
        messageCount: messages.length,
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

  createThread(scopeKey: string, title = '新しいトーク'): string {
    const threadId = randomUUID();
    const threads = this.conversations.get(scopeKey) ?? new Map<string, StoredConversationMessage[]>();
    const threadTitles = this.threadTitles.get(scopeKey) ?? new Map<string, string>();
    threads.set(threadId, []);
    threadTitles.set(threadId, title.trim() || '新しいトーク');
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
    return true;
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

  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[] {
    const effectiveThreadId = this.threadId(scopeKey, threadId);
    const threadMessages = this.conversations.get(scopeKey)?.get(effectiveThreadId) ?? [];
    return Object.freeze(threadMessages.map(item => Object.freeze({
      ...item,
      ...(item.messageEmotion ? { messageEmotion: Object.freeze({ ...item.messageEmotion }) } : {}),
    })));
  }

  experienceCandidates(scopeKey: string, threadId?: string): readonly ShannonExperience[] {
    this.threadId(scopeKey, threadId);
    return Object.freeze((this.experiences.get(scopeKey) ?? []).map(item => Object.freeze({ ...item })));
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
    conversation.push(
      { id: randomUUID(), role: 'user', content: userMessage, observedAt },
      {
        id: randomUUID(),
        role: 'assistant',
        content: shannonReply,
        observedAt,
        ...(context ? {
          messageEmotion: Object.freeze({ ...context.messageEmotion }),
          stateVersion: context.capturedStateVersion,
          ...(context.taskDecision ? { taskDecision: Object.freeze({ ...context.taskDecision }) } : {}),
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
    });
    experiences.push(experience);
    this.experiences.set(scopeKey, experiences.slice(-this.maximumExperiences));
    return experience;
  }
}

function summarizeExperience(userMessage: string, shannonReply: string): string {
  const user = userMessage.replace(/\s+/g, ' ').trim().slice(0, 220);
  const shannon = shannonReply.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `ユーザー: ${user} / シャノン: ${shannon}`;
}

function conciseTitle(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新しいトーク';
  return cleaned.length <= 30 ? cleaned : `${cleaned.slice(0, 27)}…`;
}
