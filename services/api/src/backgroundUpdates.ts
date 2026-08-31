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

export interface CompletedTurn {
  scopeKey: string;
  capturedState: CompanionStateSnapshot;
  userMessage: string;
  shannonReply: string;
  messageEmotion: ShannonMessageEmotion;
  completedAt: string;
}

export class BackgroundUpdateCoordinator {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly conversationStore: ConversationStore,
    private readonly reportError: (error: unknown) => void = error => console.error('Shannon background update failed', error),
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
    const previous = this.queues.get(turn.scopeKey) ?? Promise.resolve();
    const next = previous
      .then(() => new Promise<void>((resolve, reject) => {
        setImmediate(() => {
          try {
            this.applyTurn(turn, recordedExperienceId);
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

  private applyTurn(turn: CompletedTurn, recordedExperienceId?: string): void {
    const candidates = this.conversationStore.experienceCandidates(turn.scopeKey)
      .filter(candidate => candidate.id !== recordedExperienceId);
    const recalled = selectActiveMemories(turn.userMessage, candidates);
    const current = this.stateStore.snapshot(turn.scopeKey);

    this.stateStore.apply(turn.scopeKey, {
      type: 'emotion-adjusted',
      delta: deriveEmotionDelta(current, turn.userMessage),
    });

    const recalledIds = new Set(recalled.map(memory => memory.id));
    for (const memory of current.activeMemories) {
      if (!recalledIds.has(memory.id)) {
        this.stateStore.apply(turn.scopeKey, { type: 'memory-deactivated', memoryId: memory.id });
      }
    }
    for (const memory of recalled) {
      this.stateStore.apply(turn.scopeKey, { type: 'memory-activated', memory });
    }
    const resonantInterest = current.temperament.curiosity >= 0.5
      ? deriveResonantInterest(turn.userMessage, recalled)
      : null;
    if (resonantInterest) {
      this.stateStore.apply(turn.scopeKey, { type: 'interest-observed', interest: resonantInterest });
    }
  }
}
