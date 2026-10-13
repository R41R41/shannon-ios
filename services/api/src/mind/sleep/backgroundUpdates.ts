import { turnPersistenceContext } from './turnPersistenceContext.js';
export { turnPersistenceContext } from './turnPersistenceContext.js';
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
import type { ConversationStore, TurnPersistenceContext } from '../memory/memoryPorts.js';
import type { ShannonExperience } from '../memory/memoryPorts.js';
import type { BackgroundJobStore } from './store/backgroundJobStore.js';
import { captureImmediateExplicitMemory, type UserFactProposal } from './sleepConsolidation.js';
import type { ShannonGeneratedArtifact, ShannonTaskDecision } from '../../infra/models/chatModel.js';
import { EXACT_TIME_DECLINED, extractPromiseCaptures, requestsExactTimeAlert, type MemoryProposals } from '../memory/memoryPorts.js';
import { extractExplicitUserIntent } from '../action/respond/respondPorts.js';
import { type TurnCaptureRecord } from '../memory/memoryPorts.js';
import { intentCaptureKey, ownerFacingStatement, turnCaptureId } from '../memory/capturePorts.js';
import { applyExplicitCommitmentCommand } from '../action/respond/respondCommandPorts.js';
import { sharedTimeEvent } from '../emotion/emotionPorts.js';
import { emotionTiming } from '../emotion/emotionPorts.js';

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
    /**
     * Syzygy ADR-0008 stage 3 (F5): the memory outbox. Present, what the turn teaches (facts, relationships, interests, promises,
     * the turn's captures) is proposed and the one writer applies it; emotion, the recalled memories and shared time stay direct.
     * Absent (switched off): everything is written here, as it was.
     */
    private readonly memory: MemoryProposals | null = null,
    private readonly stage5 = false,
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
    const proposals = this.memory;
    const opId = (part: string) => `turn:${scopeKey}:${recordedExperienceId ?? sourceTime}:${part}`.slice(0, 200);
    const episodes = recordedExperienceId ? [recordedExperienceId] : [];
    for (const fact of immediate.facts) {
      const stored = { ...fact, ...(recordedExperienceId ? { sourceExperienceId: recordedExperienceId } : {}),
        ...labelled(`${fact.statement}\n${fact.evidence ?? ''}`) };
      if (proposals) proposals.propose({ opId: opId(`fact:${fact.id}`), scopeKey, kind: 'fact.upsert', origin: 'turn', subjectKey: `fact:${fact.id}`,
        payload: { fact: stored, source: 'conversation' }, episodeIds: episodes, disclosure: stored.disclosure });
      else this.stateStore.apply(scopeKey, { type: 'user-fact-upserted', fact: stored, source: 'conversation' });
      learned(fact.id, fact.statement, current.userFacts.some(item => item.id === fact.id));
    }
    for (const relationship of immediate.relationships) {
      const stored = { ...relationship, ...(recordedExperienceId ? { sourceExperienceId: recordedExperienceId } : {}),
        ...labelled(`${relationship.statement}\n${relationship.evidence ?? ''}`) };
      if (proposals) proposals.propose({ opId: opId(`relationship:${relationship.id}`), scopeKey, kind: 'relationship.upsert', origin: 'turn',
        subjectKey: `relationship:${relationship.id}`, payload: { relationship: stored, source: 'conversation' }, episodeIds: episodes, disclosure: stored.disclosure });
      else this.stateStore.apply(scopeKey, { type: 'relationship-upserted', relationship: stored, source: 'conversation' });
      learned(relationship.id, relationship.statement, current.relationships.some(item => item.id === relationship.id));
    }
    for (const interest of immediate.interests) {
      if (proposals) proposals.propose({ opId: opId(`interest:${interest}`), scopeKey, kind: 'interest.change', origin: 'turn',
        subjectKey: `interest:${interest}`.slice(0, 240), payload: { interest, source: 'conversation', ...(this.stage5 ? { provenance: 'owner_explicit' } : {}) }, episodeIds: episodes });
      else this.stateStore.apply(scopeKey, { type: 'interest-observed', interest, source: 'conversation' });
    }
    // A timer or a reminder her device took in this turn answers the clock: no 「時刻ちょうどは…」 promise or notice beside it.
    const deviceAlert = deviceAlertSet(this.conversationStore, scopeKey, sourceTime);
    for (const promise of extractPromiseCaptures(userMessage, sourceTime, recordedExperienceId, source?.timeZone ?? timeZone)) {
      if (deviceAlert && promise.note) continue;
      const memory = { ...promise.memory, ...labelled(`${promise.memory.summary}\n${promise.memory.evidence ?? ''}`) };
      if (proposals) proposals.propose({ opId: opId(`promise:${memory.id}`), scopeKey, kind: 'promise.capture', origin: 'turn', subjectKey: `promise:${memory.id}`,
        payload: { memory }, episodeIds: episodes, disclosure: memory.disclosure ?? null });
      else this.stateStore.apply(scopeKey, { type: 'prospective-memory-upserted', memory });
      capture('commitment', memory.id, promise.topic, { itemId: memory.id,
        ...(memory.dueDate ? { dueDate: memory.dueDate } : {}), ...(memory.dueAt ? { dueAt: memory.dueAt } : {}),
        ...(memory.dueHint ? { dueHint: memory.dueHint } : {}), ...(memory.timeZone ? { timeZone: memory.timeZone } : {}),
        ...(promise.note ? { note: promise.note } : {}) });
    }
    // The response lane owns the intention ledger; this records only that the turn stated a goal.
    const goal = extractExplicitUserIntent(userMessage, '', sourceTime);
    if (goal) capture('intent', intentCaptureKey(goal.title), goal.title, { itemId: intentCaptureKey(goal.title) });
    if (requestsExactTimeAlert(userMessage) && !deviceAlert) capture('notice', 'exact-time', EXACT_TIME_DECLINED);
    if (proposals && captures.length) {
      // What the turn stated as a goal is its own op (the intention ledger reads it); the rest of the turn's captures are one.
      for (const intent of captures.filter(item => item.kind === 'intent')) proposals.propose({ opId: opId(`capture:${intent.id}`), scopeKey, kind: 'intent.capture',
        origin: 'turn', subjectKey: `turn:${intent.turnId}`, payload: { capture: intent }, episodeIds: episodes });
      const rest = captures.filter(item => item.kind !== 'intent');
      if (rest.length) proposals.propose({ opId: opId('captures'), scopeKey, kind: 'turn_capture', origin: 'turn', subjectKey: `turn:${rest[0]!.turnId}`,
        payload: { captures: rest }, episodeIds: episodes });
    } else if (captures.length) this.conversationStore.recordTurnCaptures?.(scopeKey, captures);

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
    if (resonantInterest && proposals && this.stage5) {
      proposals.propose({ opId: opId(`resonant:${resonantInterest}`), scopeKey, kind: 'self.interest.propose', origin: 'turn',
        subjectKey: `self-interest:${resonantInterest}`.slice(0, 240), payload: { kind: 'add', provenance: 'resonant_self',
          title: resonantInterest, description: '', reason: '会話と想起した経験に共鳴した' }, episodeIds: episodes, disclosure: disclosureFor(resonantInterest, audience) });
    } else if (resonantInterest && proposals) {
      proposals.propose({ opId: opId(`resonant:${resonantInterest}`), scopeKey, kind: 'interest.change', origin: 'turn',
        subjectKey: `interest:${resonantInterest}`.slice(0, 240), payload: { interest: resonantInterest }, episodeIds: episodes });
    } else if (resonantInterest && !this.stage5) {
      this.stateStore.apply(scopeKey, { type: 'interest-observed', interest: resonantInterest });
    }
    // Last, so the slow traits are recalibrated from what this turn just stored.
    this.stateStore.apply(scopeKey, sharedTimeEvent(candidates, sourceTime, source?.timeZone ?? timeZone));
  }
}

/** The device's timer and reminder (`deviceActionToolDefinitions.ts`). */
const DEVICE_ALERT_TOOLS: ReadonlySet<string> = new Set(['timer.start', 'reminder.create']);
/** How far before the turn's time a call of it may have been traced (a voice turn is stored after she spoke). */
const DEVICE_ALERT_WINDOW_MILLISECONDS = 3 * 60_000;

/**
 * Whether her device took a timer or a reminder in this turn, from her tool traces (2026-10-13 daily evals D1: the background notice
 * 「時刻ちょうどにお知らせすることは、まだできません」 appeared under a reply whose timer the device had set). A store without traces: no.
 */
export function deviceAlertSet(store: unknown, scopeKey: string, at: string): boolean {
  const traces = store as { toolTraces?: (scopeKey: string, threadId: string | null, query: { since?: string }) => readonly {
    recordedAt: string; calls: readonly { tool: string; ok: boolean }[] }[] };
  if (typeof traces.toolTraces !== 'function' || !Number.isFinite(Date.parse(at))) return false;
  const since = new Date(Date.parse(at) - DEVICE_ALERT_WINDOW_MILLISECONDS).toISOString();
  try {
    const until = Date.parse(at) + 60_000; // Not a later turn's.
    return traces.toolTraces(scopeKey, null, { since }).some(record => Date.parse(record.recordedAt) <= until
      && record.calls.some(call => call.ok && DEVICE_ALERT_TOOLS.has(call.tool)));
  } catch { return false; }
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
    /** Syzygy ADR-0008 stage 3 (F5): the memory outbox (absent: switched off, written here as it was). */
    memory?: MemoryProposals | null,
    stage5 = false,
  ) {
    this.processor = new TurnRefinementProcessor(stateStore, conversationStore, memory ?? null, stage5);
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
