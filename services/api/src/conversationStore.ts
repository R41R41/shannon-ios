import { randomUUID } from 'node:crypto';
import type { RecallCandidate, ShannonMessageEmotion } from '@shannon/cognition';
import type { ShannonConversationItem, ShannonGeneratedArtifact } from './chatModel.js';
import type { ShannonTaskDecision } from './chatModel.js';
import { DEFAULT_THREAD_TITLE, initialThreadTitle } from './threadTitle.js';

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
  summary?: string;
  sections?: readonly string[];
}

export interface StoredConversationMessage extends ShannonConversationItem {
  id: string;
  observedAt: string;
  messageEmotion?: ShannonMessageEmotion;
  stateVersion?: number;
  taskDecision?: ShannonTaskDecision;
  artifacts?: readonly ShannonGeneratedArtifact[];
}

export interface TurnPersistenceContext {
  threadTitle?: string;
  threadSummary?: string;
  messageEmotion: ShannonMessageEmotion;
  capturedStateVersion: number;
  taskDecision?: ShannonTaskDecision;
  artifacts?: readonly ShannonGeneratedArtifact[];
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
  private readonly threadSummaries = new Map<string, Map<string, string>>();
  private readonly protectedTitles = new Map<string, Set<string>>();
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
