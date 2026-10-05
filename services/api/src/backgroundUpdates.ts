import {
  deriveEmotionDelta,
  soothingIn,
  deriveResonantInterest,
  selectActiveMemories,
  visibleMemoryText,
  isMemoryEvidenceVisible,
  disclosureFor,
  ownerSpoke,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type MemoryAudience,
  type ShannonMessageEmotion,
} from '@shannon/cognition';
import type { ConversationStore, TurnPersistenceContext } from './conversationStore.js';
import type { ShannonExperience } from './conversationStore.js';
import type { BackgroundJobStore } from './backgroundJobStore.js';
import { captureImmediateExplicitMemory, type UserFactProposal } from './sleepConsolidation.js';
import type { ShannonGeneratedArtifact, ShannonTaskDecision } from './chatModel.js';
import { EXACT_TIME_DECLINED, extractPromiseCaptures, requestsExactTimeAlert } from './prospectiveMemory.js';
import { extractExplicitUserIntent } from './cognitiveIntent.js';
import { intentCaptureKey, ownerFacingStatement, turnCaptureId, type TurnCaptureRecord } from './turnCaptures.js';
import { applyExplicitCommitmentCommand } from './commitmentCommands.js';
import { sharedTimeEvent } from './companionPresence.js';
import { emotionTiming } from './emotionTiming.js';

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
  /** Provenance of the reply: IDs recalled into the prompt that produced it. */
  recalledMemoryIds?: readonly string[];
  summaryContinuesChain?: boolean;
  /** Who was present. Absent: the owner alone. */
  audience?: MemoryAudience;
  /** Who spoke the user side. Absent: the owner when alone, otherwise unknown. */
  speaker?: 'owner' | 'unknown';
  /** A voice turn: the client's id of the utterance, as its delegation carried it. Not stored; it links what her tools did. */
  utteranceId?: string;
}

function turnPersistenceContext(turn: CompletedTurn): TurnPersistenceContext {
  return {
    messageEmotion: turn.messageEmotion,
    capturedStateVersion: turn.capturedState.version,
    ...(turn.timeZone ? { timeZone: turn.timeZone } : {}),
    ...(turn.threadTitle ? { threadTitle: turn.threadTitle } : {}),
    ...(turn.threadSummary ? { threadSummary: turn.threadSummary } : {}),
    ...(turn.taskDecision ? { taskDecision: turn.taskDecision } : {}),
    ...(turn.artifacts?.length ? { artifacts: turn.artifacts } : {}),
    ...(turn.recalledMemoryIds ? { recalledMemoryIds: turn.recalledMemoryIds } : {}),
    ...(turn.summaryContinuesChain ? { summaryContinuesChain: true } : {}),
    ...(turn.audience ? { audience: turn.audience } : {}),
    ...(turn.speaker ? { speaker: turn.speaker } : {}),
  };
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
        ?? this.conversationStore.experiencesById?.(scopeKey, [recordedExperienceId])[0]
      : undefined;
    const sourceTime = source?.observedAt ?? observedAt ?? new Date().toISOString();
    if (recordedExperienceId && !visibleMemoryText(this.stateStore.snapshot(scopeKey), recordedExperienceId, 'visible')) return;
    // With anyone else present the words may be theirs: nothing becomes an owner fact, promise, goal or feeling.
    if (source && !ownerSpoke(source.disclosure)) return;
    // Derived items inherit who heard the turn; their own text decides whether they are sensitive.
    const audience = source?.disclosure?.audience;
    const labelled = (text: string) => ({ disclosure: disclosureFor(text, audience) });
    applyExplicitCommitmentCommand(this.stateStore, this.conversationStore, scopeKey, userMessage, sourceTime);
    const current = this.stateStore.snapshot(scopeKey);
    if (!isMemoryEvidenceVisible(current, userMessage)) return;
    const candidates = this.conversationStore.experienceCandidates(scopeKey)
      .filter(candidate => candidate.id !== recordedExperienceId && ownerSpoke(candidate.disclosure)
        && visibleMemoryText(current, candidate.id, candidate.summary)
        && isMemoryEvidenceVisible(current, candidate.userMessage));
    const recalled = selectActiveMemories(userMessage, candidates);

    this.stateStore.apply(scopeKey, {
      type: 'emotion-adjusted',
      delta: deriveEmotionDelta(current, userMessage, emotionTiming()),
    });
    // His apology or kind word eases what she still holds against him. Only a turn of the owner's own reaches this line.
    // Unlike the lines above this fails closed: without the recorded turn there is no proof the words were his, and nothing is eased.
    const soothing = emotionTiming().clock === 'awake' && source && ownerSpoke(source.disclosure) ? soothingIn(userMessage) : null;
    if (soothing) this.stateStore.apply(scopeKey, { type: 'feeling-eased', by: soothing });

    const immediate = captureImmediateExplicitMemory(
      userMessage,
      current,
      sourceTime,
      supplementalProposals,
    );
    const captures: TurnCaptureRecord[] = [];
    const capture = (kind: TurnCaptureRecord['kind'], key: string, text: string, extra: Partial<TurnCaptureRecord> = {}) => {
      if (recordedExperienceId) captures.push({ id: turnCaptureId(recordedExperienceId, kind, key), turnId: recordedExperienceId,
        kind, text: text.slice(0, 160), createdAt: sourceTime, ...extra });
    };
    const learned = (id: string, statement: string, known: boolean) => {
      const revision = immediate.revisions?.find(item => item.id === id);
      capture('knowledge', id, ownerFacingStatement(statement), { itemId: id,
        ...(revision ? { change: 'updated' as const, previousText: revision.previousText }
          : { change: known ? 'confirmed' as const : 'created' as const }) });
    };
    for (const fact of immediate.facts) {
      this.stateStore.apply(scopeKey, { type: 'user-fact-upserted',
        fact: { ...fact, ...(recordedExperienceId ? { sourceExperienceId: recordedExperienceId } : {}),
          ...labelled(`${fact.statement}\n${fact.evidence ?? ''}`) }, source: 'conversation' });
      learned(fact.id, fact.statement, current.userFacts.some(item => item.id === fact.id));
    }
    for (const relationship of immediate.relationships) {
      this.stateStore.apply(scopeKey, { type: 'relationship-upserted',
        relationship: { ...relationship, ...(recordedExperienceId ? { sourceExperienceId: recordedExperienceId } : {}),
          ...labelled(`${relationship.statement}\n${relationship.evidence ?? ''}`) }, source: 'conversation' });
      learned(relationship.id, relationship.statement, current.relationships.some(item => item.id === relationship.id));
    }
    for (const interest of immediate.interests) {
      this.stateStore.apply(scopeKey, { type: 'interest-observed', interest, source: 'conversation' });
    }
    for (const promise of extractPromiseCaptures(userMessage, sourceTime, recordedExperienceId, source?.timeZone ?? timeZone)) {
      const memory = { ...promise.memory, ...labelled(`${promise.memory.summary}\n${promise.memory.evidence ?? ''}`) };
      this.stateStore.apply(scopeKey, { type: 'prospective-memory-upserted', memory });
      capture('commitment', memory.id, promise.topic, { itemId: memory.id,
        ...(memory.dueDate ? { dueDate: memory.dueDate } : {}), ...(memory.dueAt ? { dueAt: memory.dueAt } : {}),
        ...(memory.dueHint ? { dueHint: memory.dueHint } : {}), ...(memory.timeZone ? { timeZone: memory.timeZone } : {}),
        ...(promise.note ? { note: promise.note } : {}) });
    }
    // The response lane owns the intention ledger; this records only that the turn stated a goal.
    const goal = extractExplicitUserIntent(userMessage, '', sourceTime);
    if (goal) capture('intent', intentCaptureKey(goal.title), goal.title, { itemId: intentCaptureKey(goal.title) });
    if (requestsExactTimeAlert(userMessage)) capture('notice', 'exact-time', EXACT_TIME_DECLINED);
    if (captures.length) this.conversationStore.recordTurnCaptures?.(scopeKey, captures);

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
    // Last, so the slow traits are recalibrated from what this turn just stored.
    this.stateStore.apply(scopeKey, sharedTimeEvent(candidates, sourceTime, source?.timeZone ?? timeZone));
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
    /** Runs after a turn's refinement, still off the response path (the replay summary). */
    private readonly afterTurn?: (turn: CompletedTurn, recordedExperienceId?: string) => Promise<unknown>,
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
      turnPersistenceContext(turn),
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
      .then(() => this.afterTurn?.(turn, recordedExperienceId)).then(() => undefined)
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
      turnPersistenceContext(turn),
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
