/** The conversation store's contract: what a conversation, a turn and an experience are, and what every conversation store does (Syzygy ADR-0008 stage 3, S2: moved unchanged out of `store/conversationStore.ts`, which keeps the in-memory store and re-exports this). */
import { disclosureFor, type MemoryAudience, type MemoryDisclosure, type RecallCandidate, type ShannonMessageEmotion } from '@shannon/cognition';
import type { ShannonConversationItem, ShannonGeneratedArtifact, ShannonTaskDecision } from '../../infra/models/chatModel.js';
import type { ReminderReference, ReminderView, TurnCaptureRecord, TurnCaptureView } from './store/turnCaptures.js';
import type { MemorySearchHit } from './store/sqliteMemorySearch.js';
import type { FeedbackState } from '../../contracts/feedbackContract.js';

/** Threads of the platform bridge (`platformBridgeThreadId`): `platform:<platform>:<32 hex>`. Never the default Talk. */
export const isPlatformThreadId = (threadId: string): boolean => /^platform:[a-z]+:[0-9a-f]{32}$/u.test(threadId);

export interface ShannonExperience extends RecallCandidate {
  readSourceIds?: readonly string[];
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

/** What was said in a thread before its replay window (`conversationReplaySummary.ts`); not the navigation summary. */
export interface ReplaySummaryRecord {
  summary: string;
  /** The newest message the summary accounts for. */
  coveredThroughMessageId: string;
  /** When it was last built from visible messages only, without a previous summary; and when it was last written. */
  chainStartedAt: string; updatedAt: string;
  template?: import('@shannon/mind').CompactionTemplate; // ADR-0008 stage 3 (F7): what `summary` was rendered from, and its raw range.
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
  /** Server-only initial audience of a canonical task result note. Older notes omit it. */
  noteOwnerAlone?: boolean;
  messageEmotion?: ShannonMessageEmotion;
  stateVersion?: number;
  taskDecision?: ShannonTaskDecision;
  artifacts?: readonly ShannonGeneratedArtifact[];
  sourceAttribution?: ShannonSourceAttribution;
  /** A piece of her study this message is about; clients open the reader from it. */
  studyPiece?: { id: string; title: string };
  /** Her message about one look at the room: what she saw (`seen`), or why she did not look (`not_seen`). */
  bodyLook?: { id: string; outcome: 'seen' | 'not_seen' };
  /** The promise a reminder message is about; resolved to a `ReminderView` for clients. */
  reminder?: ReminderReference | ReminderView;
  /** What Shannon took in from this turn, attached to her reply once the worker has recorded it. */
  captures?: readonly TurnCaptureView[];
  feedback?:FeedbackState;
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
  /** False proves this scope has no canonical experience owning private-read provenance. Omitted means unknown; never infer from FCA being off. */
  hasReadSourceProvenance?(scopeKey: string): boolean;
  /** Current native source visibility, injected by wiring; absent readers withhold derived private task experiences. */
  readSourceVisible?(scopeKey: string, sourceId: string, observedAt: string): boolean;
  /** Stage5's bounded supplementary self. Read again under current forgetting/disclosure; absent/OFF yields no prompt. */
  selfInterestProjection?(scopeKey: string, audience: MemoryAudience, openOnly?: boolean): string;
  listThreads(scopeKey: string): readonly ConversationThread[];
  threadId(scopeKey: string, threadId?: string): string;
  createThread(scopeKey: string, title?: string): string;
  renameThread(scopeKey: string, threadId: string, title: string): boolean;
  needsAutomaticThreadTitle(scopeKey: string, threadId: string): boolean;
  archiveThread(scopeKey: string, threadId: string): boolean;
  history(scopeKey: string, threadId?: string): readonly ShannonConversationItem[];
  threadSummary(scopeKey: string, threadId: string): string | undefined;
  conversationHistory(scopeKey: string, threadId?: string): readonly StoredConversationMessage[];
  /** Exact assistant source lookup across the entire persisted thread; never the display window. */
  assistantMessage?(scopeKey: string, threadId: string, sourceOrMessageId: string): StoredConversationMessage | null;
  /** Display-only task result written once under a server-owned original-attempt id. */
  appendNoteOnce?(scopeKey: string, threadId: string, messageId: string, content: string, observedAt: string, noteKind: string, ownerAlone?: boolean): StoredConversationMessage;
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
  /** The newest `limit` messages of a thread, oldest first. Absent: the displayed history is used. */
  recentMessages?(scopeKey: string, threadId: string, limit: number): readonly StoredConversationMessage[];
  replaySummary?(scopeKey: string, threadId: string): ReplaySummaryRecord | undefined;
  saveReplaySummary?(scopeKey: string, threadId: string, record: ReplaySummaryRecord): void;
  /** The thread a completed turn was stored in. */
  threadOfTurn?(scopeKey: string, experienceId: string): string | undefined;
  /** Her impressions of people (`impressions.ts`). Absent: none are read or written. */
  impressionStore?(): import('./impressions.js').ImpressionStore;
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
