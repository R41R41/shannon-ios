import { randomUUID } from 'node:crypto';
import { searchMemoryDocuments } from '@shannon/cognition';
import type { MemorySearchHit } from './sqliteMemorySearch.js';
import type { ShannonConversationItem } from '../../../infra/models/chatModel.js';
import { DEFAULT_THREAD_TITLE, initialThreadTitle } from '../../../surfaces/text/threadTitle.js';
import type { TurnCaptureRecord } from './turnCaptures.js';
import { isPlatformThreadId, type NoteFace, type ShannonExperience, turnDisclosure, type ThreadSummaryLineage, type ReplaySummaryRecord, type ReplayEpochRecord, type ReplayChannel, type VoiceSummaryRecord, boundedRecalledMemoryIds, type ConversationThread, type StoredConversationMessage, type TurnPersistenceContext, type PlatformTurnPersistenceInput, type PlatformTurnPersistenceResult, type ConversationStore, threadNavigation } from '../conversationContract.js';
export { isPlatformThreadId, type NoteFace, type ShannonExperience, turnDisclosure, type ThreadSummaryLineage, type ReplaySummaryRecord, type ReplayEpochRecord, type ReplayChannel, type VoiceSummaryRecord, MAXIMUM_RECALLED_MEMORY_IDS, boundedRecalledMemoryIds, type ShannonSourceAttribution, type ConversationThread, type StoredConversationMessage, type TurnPersistenceContext, type PlatformTurnPersistenceInput, type PlatformTurnPersistenceResult, type ConversationStore, threadNavigation } from '../conversationContract.js';

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
  private readonly replaySummaries = new Map<string, ReplaySummaryRecord>();
  private readonly replayEpochs = new Map<string, ReplayEpochRecord>();
  private readonly voiceSummaryVersions = new Map<string, readonly VoiceSummaryRecord[]>();
  private readonly voiceSummaryWants = new Map<string, string>();

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
    // A platform conversation is never the default Talk (as in `SQLiteConversationRepository.threadId`).
    if (threadId && isPlatformThreadId(threadId)) return threadId;
    const cache = this.defaultThreadCache.get(scopeKey);
    if (threadId && cache !== threadId) {
      this.defaultThreadCache.set(scopeKey, threadId);
      return threadId;
    }
    if (cache) return cache;
    // The newest Talk of the app's own; a platform thread (game chat, Discord) that was written last is not one.
    const selected = this.listThreads(scopeKey).find(thread => !isPlatformThreadId(thread.threadId))?.threadId ?? `thread-${randomUUID()}`;
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

  assistantMessage(scopeKey: string, threadId: string, sourceOrMessageId: string): StoredConversationMessage | null {
    const rows=this.conversations.get(scopeKey)?.get(threadId)??[];
    return [...rows].reverse().find(row=>row.role==='assistant'&&(row.id===sourceOrMessageId||row.sourceExperienceId===sourceOrMessageId))??null;
  }
  appendNoteOnce(scopeKey: string, threadId: string, messageId: string, content: string, observedAt: string, noteKind: string, ownerAlone?: boolean): StoredConversationMessage {
    const existing=this.assistantMessage(scopeKey,threadId,messageId);
    if(existing){if(existing.content!==content||existing.sourceExperienceId!==`${noteKind}:${messageId}`)throw new Error('TASK_NOTE_CONFLICT');return existing;}
    const threads=this.conversations.get(scopeKey)??new Map<string,StoredConversationMessage[]>();
    const messages=threads.get(threadId)??[];
    const note=Object.freeze({id:messageId,sourceExperienceId:`${noteKind}:${messageId}`,role:'assistant' as const,content,observedAt,...(typeof ownerAlone === 'boolean' ? {noteOwnerAlone:ownerAlone} : {})});
    threads.set(threadId,[...messages,note].slice(-this.maximumConversationItems));this.conversations.set(scopeKey,threads);return note;
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
    if (!isPlatformThreadId(resolvedThreadId)) this.defaultThreadCache.set(scopeKey, resolvedThreadId);

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

  appendNote(scopeKey: string, threadId: string, content: string, observedAt: string, noteKind: string, face?: NoteFace): StoredConversationMessage {
    const resolvedThreadId = this.threadId(scopeKey, threadId);
    const threads = this.conversations.get(scopeKey) ?? new Map<string, StoredConversationMessage[]>();
    const conversation = threads.get(resolvedThreadId) ?? [];
    const note: StoredConversationMessage = {
      id: randomUUID(), sourceExperienceId: `${noteKind}:${randomUUID()}`, role: 'assistant', content, observedAt,
      ...(face ? { messageEmotion: Object.freeze({ ...face }) } : {}),
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

  replaySummary(scopeKey: string, threadId: string): ReplaySummaryRecord | undefined { return this.replaySummaries.get(`${scopeKey}\u0000${threadId}`); }
  saveReplaySummary(scopeKey: string, threadId: string, record: ReplaySummaryRecord): void {
    this.replaySummaries.set(`${scopeKey}\u0000${threadId}`, Object.freeze({ ...record }));
  }

  replayEpoch(scopeKey: string, threadId: string, channel: ReplayChannel): ReplayEpochRecord | undefined {
    return this.replayEpochs.get(`${scopeKey}\u0000${threadId}\u0000${channel}`);
  }
  saveReplayEpoch(scopeKey: string, threadId: string, channel: ReplayChannel, record: ReplayEpochRecord): void {
    this.replayEpochs.set(`${scopeKey}\u0000${threadId}\u0000${channel}`, Object.freeze({ ...record }));
  }

  voiceSummaries(scopeKey: string, threadId: string): readonly VoiceSummaryRecord[] {
    return this.voiceSummaryVersions.get(`${scopeKey}\u0000${threadId}`) ?? [];
  }
  saveVoiceSummary(scopeKey: string, threadId: string, prepare: () => { record: VoiceSummaryRecord; keep: readonly number[] } | null): boolean {
    const write = prepare();
    if (!write) return false;
    const { record, keep } = write;
    const kept = this.voiceSummaries(scopeKey, threadId).filter(item => keep.includes(item.version) && item.version !== record.version);
    const versions = [Object.freeze({ ...record }), ...kept].sort((left, right) => right.version - left.version);
    this.voiceSummaryVersions.set(`${scopeKey}\u0000${threadId}`, Object.freeze(versions));
    return true;
  }
  deleteVoiceSummaries(scopeKey: string, threadId: string, versions: readonly number[]): void {
    const kept = this.voiceSummaries(scopeKey, threadId).filter(item => !versions.includes(item.version));
    this.voiceSummaryVersions.set(`${scopeKey}\u0000${threadId}`, Object.freeze(kept));
  }
  voiceSummaryWanted(scopeKey: string, threadId: string): string | undefined { return this.voiceSummaryWants.get(`${scopeKey}\u0000${threadId}`); }
  markVoiceSummaryWanted(scopeKey: string, threadId: string, at: string): void { this.voiceSummaryWants.set(`${scopeKey}\u0000${threadId}`, at); }

  threadOfTurn(scopeKey: string, experienceId: string): string | undefined {
    return [...this.conversations.get(scopeKey) ?? []].find(([, messages]) => messages.some(item => item.sourceExperienceId === experienceId))?.[0];
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
