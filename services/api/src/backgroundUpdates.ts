import {
  deriveEmotionDelta,
  deriveResonantInterest,
  selectActiveMemories,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type ShannonMessageEmotion,
} from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';
import type { ShannonExperience } from './conversationStore.js';
import type { BackgroundJobStore } from './backgroundJobStore.js';

export interface CompletedTurn {
  scopeKey: string;
  capturedState: CompanionStateSnapshot;
  userMessage: string;
  shannonReply: string;
  messageEmotion: ShannonMessageEmotion;
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

  process(scopeKey: string, userMessage: string, recordedExperienceId?: string): void {
    const candidates = this.conversationStore.experienceCandidates(scopeKey)
      .filter(candidate => candidate.id !== recordedExperienceId);
    const recalled = selectActiveMemories(userMessage, candidates);
    const current = this.stateStore.snapshot(scopeKey);

    this.stateStore.apply(scopeKey, {
      type: 'emotion-adjusted',
      delta: deriveEmotionDelta(current, userMessage),
    });

    const recalledIds = new Set(recalled.map(memory => memory.id));
    const pinnedIds = new Set(current.memoryControls
      .filter(control => control.kind === 'experience' && control.status === 'active' && control.pinned)
      .map(control => control.memoryId));
    for (const memory of current.activeMemories) {
      if (!recalledIds.has(memory.id) && !pinnedIds.has(memory.id)) {
        this.stateStore.apply(scopeKey, { type: 'memory-deactivated', memoryId: memory.id });
      }
    }
    for (const memory of recalled) {
      this.stateStore.apply(scopeKey, { type: 'memory-activated', memory });
    }
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
      turn.userMessage,
      turn.shannonReply,
      turn.completedAt,
      {
        messageEmotion: turn.messageEmotion,
        capturedStateVersion: turn.capturedState.version,
      },
    );
  }

  schedule(turn: CompletedTurn, recordedExperienceId?: string): void {
    const previous = this.queues.get(turn.scopeKey) ?? Promise.resolve();
    const next = previous
      .then(() => new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          try {
            this.processor.process(turn.scopeKey, turn.userMessage, recordedExperienceId);
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
      turn.userMessage,
      turn.shannonReply,
      turn.completedAt,
      {
        messageEmotion: turn.messageEmotion,
        capturedStateVersion: turn.capturedState.version,
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
    );
  }

  async waitForIdle(): Promise<void> {
    // A separate process owns the durable queue; the response lane never waits for it.
  }
}
