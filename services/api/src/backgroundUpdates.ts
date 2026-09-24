import {
  deriveEmotionDelta,
  deriveResonantInterest,
  selectActiveMemories,
  visibleMemoryText,
  isMemoryEvidenceVisible,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type ShannonMessageEmotion,
} from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';
import type { ShannonExperience } from './conversationStore.js';
import type { BackgroundJobStore } from './backgroundJobStore.js';
import { captureImmediateExplicitMemory, type UserFactProposal } from './sleepConsolidation.js';
import type { ShannonGeneratedArtifact, ShannonTaskDecision } from './chatModel.js';
import { extractProspectiveMemories } from './prospectiveMemory.js';
import { applyExplicitCommitmentCommand } from './commitmentCommands.js';

export interface CompletedTurn {
  timeZone?: string;
  threadTitle?: string;
  threadSummary?: string;
  scopeKey: string;
  threadId: string;
  capturedState: CompanionStateSnapshot;
  userMessage: string;
  shannonReply: string;
  messageEmotion: ShannonMessageEmotion;
  taskDecision?: ShannonTaskDecision;
  artifacts?: readonly ShannonGeneratedArtifact[];
  completedAt: string;
}

export interface TurnBackgroundService {
  readonly mode: 'in-process' | 'durable-queue';
  recordTurn(turn: CompletedTurn): ShannonExperience;
  schedule(turn: CompletedTurn, recordedExperienceId?: string): void;
  waitForIdle(scopeKey: string): Promise<void>;
}

export class TurnRefinementProcessor {
  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly conversationStore: ConversationStore,
  ) {}

  process(
    scopeKey: string,
    userMessage: string,
    recordedExperienceId?: string,
    observedAt?: string,
    supplementalProposals: readonly UserFactProposal[] = [],
    timeZone?: string,
  ): void {
    const source = recordedExperienceId
      ? this.conversationStore.experienceCandidates(scopeKey).find(item => item.id === recordedExperienceId)
      : undefined;
    const sourceTime = source?.observedAt ?? observedAt ?? new Date().toISOString();
    if (recordedExperienceId && !visibleMemoryText(this.stateStore.snapshot(scopeKey), recordedExperienceId, 'visible')) return;
    applyExplicitCommitmentCommand(this.stateStore, this.conversationStore, scopeKey, userMessage, sourceTime);
    const current = this.stateStore.snapshot(scopeKey);
    if (!isMemoryEvidenceVisible(current, userMessage)) return;
    const candidates = this.conversationStore.experienceCandidates(scopeKey)
      .filter(candidate => candidate.id !== recordedExperienceId
        && visibleMemoryText(current, candidate.id, candidate.summary)
        && isMemoryEvidenceVisible(current, candidate.userMessage));
    const recalled = selectActiveMemories(userMessage, candidates);

    this.stateStore.apply(scopeKey, {
      type: 'emotion-adjusted',
      delta: deriveEmotionDelta(current, userMessage),
    });

    const immediate = captureImmediateExplicitMemory(
      userMessage,
      current,
      sourceTime,
      supplementalProposals,
    );
    for (const fact of immediate.facts) {
      this.stateStore.apply(scopeKey, { type: 'user-fact-upserted',
        fact: { ...fact, ...(recordedExperienceId ? { sourceExperienceId: recordedExperienceId } : {}) }, source: 'conversation' });
    }
    for (const relationship of immediate.relationships) {
      this.stateStore.apply(scopeKey, { type: 'relationship-upserted',
        relationship: { ...relationship, ...(recordedExperienceId ? { sourceExperienceId: recordedExperienceId } : {}) }, source: 'conversation' });
    }
    for (const interest of immediate.interests) {
      this.stateStore.apply(scopeKey, { type: 'interest-observed', interest, source: 'conversation' });
    }
    for (const memory of extractProspectiveMemories(userMessage, sourceTime, recordedExperienceId, source?.timeZone ?? timeZone)) {
      this.stateStore.apply(scopeKey, { type: 'prospective-memory-upserted', memory });
    }

    const pinnedIds = new Set(current.memoryControls
      .filter(control => control.kind === 'experience' && control.status === 'active' && control.pinned)
      .map(control => control.memoryId));
    const recalledIds = new Set(recalled.map(memory => memory.id));
    const pinned = current.activeMemories.filter(memory => pinnedIds.has(memory.id) && !recalledIds.has(memory.id)
      && visibleMemoryText(current, memory.id, memory.summary));
    this.stateStore.apply(scopeKey, { type: 'active-memories-replaced', memories: [...recalled, ...pinned] });
    const resonantInterest = current.temperament.curiosity >= 0.5
      ? deriveResonantInterest(userMessage, recalled)
      : null;
    if (resonantInterest) {
      this.stateStore.apply(scopeKey, { type: 'interest-observed', interest: resonantInterest });
    }
  }
}

export class BackgroundUpdateCoordinator implements TurnBackgroundService {
  readonly mode = 'in-process' as const;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly processor: TurnRefinementProcessor;

  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly conversationStore: ConversationStore,
    private readonly reportError: (error: unknown) => void = error => console.error('Shannon background update failed', error),
  ) {
    this.processor = new TurnRefinementProcessor(stateStore, conversationStore);
  }

  recordTurn(turn: CompletedTurn): ShannonExperience {
    return this.conversationStore.appendTurn(
      turn.scopeKey,
      turn.threadId,
      turn.userMessage,
      turn.shannonReply,
      turn.completedAt,
      {
        messageEmotion: turn.messageEmotion,
        capturedStateVersion: turn.capturedState.version,
        ...(turn.timeZone ? { timeZone: turn.timeZone } : {}),
        ...(turn.threadTitle ? { threadTitle: turn.threadTitle } : {}),
        ...(turn.threadSummary ? { threadSummary: turn.threadSummary } : {}),
        ...(turn.taskDecision ? { taskDecision: turn.taskDecision } : {}),
        ...(turn.artifacts?.length ? { artifacts: turn.artifacts } : {}),
      },
    );
  }

  schedule(turn: CompletedTurn, recordedExperienceId?: string): void {
    const previous = this.queues.get(turn.scopeKey) ?? Promise.resolve();
    const next = previous
      .then(() => new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          try {
            this.processor.process(turn.scopeKey, turn.userMessage, recordedExperienceId, turn.completedAt, [], turn.timeZone);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }))
      .catch(this.reportError);
    this.queues.set(turn.scopeKey, next);
    void next.finally(() => {
      if (this.queues.get(turn.scopeKey) === next) this.queues.delete(turn.scopeKey);
    });
  }

  async waitForIdle(scopeKey: string): Promise<void> {
    await (this.queues.get(scopeKey) ?? Promise.resolve());
  }

}

/** API-side adapter: persist the turn and enqueue work, but never perform cognition inline. */
export class DurableBackgroundDispatcher implements TurnBackgroundService {
  readonly mode = 'durable-queue' as const;
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly jobStore: BackgroundJobStore,
  ) {}

  recordTurn(turn: CompletedTurn): ShannonExperience {
    return this.conversationStore.appendTurn(
      turn.scopeKey,
      turn.threadId,
      turn.userMessage,
      turn.shannonReply,
      turn.completedAt,
      {
        messageEmotion: turn.messageEmotion,
        capturedStateVersion: turn.capturedState.version,
        ...(turn.timeZone ? { timeZone: turn.timeZone } : {}),
        ...(turn.threadTitle ? { threadTitle: turn.threadTitle } : {}),
        ...(turn.threadSummary ? { threadSummary: turn.threadSummary } : {}),
        ...(turn.taskDecision ? { taskDecision: turn.taskDecision } : {}),
        ...(turn.artifacts?.length ? { artifacts: turn.artifacts } : {}),
      },
    );
  }

  schedule(turn: CompletedTurn, recordedExperienceId?: string): void {
    if (!recordedExperienceId) throw new Error('RECORDED_EXPERIENCE_ID_REQUIRED');
    this.jobStore.enqueueTurnRefinement(
      turn.scopeKey,
      recordedExperienceId,
      turn.userMessage,
      turn.completedAt,
      turn.timeZone,
    );
  }

  async waitForIdle(_scopeKey: string): Promise<void> {
    // A separate process owns the durable queue; the response lane never waits for it.
  }
}
