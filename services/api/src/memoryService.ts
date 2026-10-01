import { presentCompanionState } from './companionPresence.js';
import {
  memoryControlFor,
  memoryIdentifier,
  type CompanionStateStore,
  type CompanionStateEvent,
  type MemoryControl,
  type MemoryKind,
  type MemoryStatus,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from './conversationStore.js';
import type { KnowledgeAnswer, KnowledgeStore } from './knowledgeStore.js';
import type { PersonalityProfile } from './knowledgeStore.js';
import type { WorldItem, WorldReader } from './worldStore.js';
import { configuredBackgroundBudgetUsd, type LlmUsageReader, type LlmUsageSummaryRow } from './llmUsage.js';
import { commitmentDeadline } from './commitmentTime.js';
import { SNOOZE_MILLISECONDS } from './commitmentInitiative.js';
import type { CommitmentSleepReview } from './sleepCommitmentReview.js';
import type { InitiativeEvaluationReader, InitiativeEvaluationSummary } from './initiativeStore.js';
import type { DailyMindFocus, DailyMindReader } from './dailyMind.js';

import {
  actionControl,
  buildActivity,
  buildItem,
  buildMetadata,
  isActivityHistorySource,
  isHistorySource,
  localDayKey,
  parseSleepReports,
} from './memoryProjection.js';

export interface MemoryEvidence {
  quote: string;
  observedAt: string;
  source: 'conversation' | 'sleep' | 'user';
}

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  confidence?: number;
  relevance?: number;
  status: MemoryStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  changeReason: string;
  evidence: readonly MemoryEvidence[];
  commitment?: { status: 'pending' | 'completed' | 'dismissed'; dueAt?: string; dueDate?: string; dueHint?: string; timeZone?: string; remindAfter?: string };
}

export interface SleepChange {
  kind: MemoryKind;
  memoryId: string;
  text: string;
  reason: string;
  evidence?: string;
}

export interface SleepContradiction {
  kind: MemoryKind;
  memoryId: string;
  currentText: string;
  candidateText: string;
  reason: string;
  evidence: string;
}

export interface SleepReport {
  commitmentReview?: CommitmentSleepReview;
  dayKey: string;
  completedAt: string;
  learned: readonly SleepChange[];
  updated: readonly SleepChange[];
  interestChanges: readonly SleepChange[];
  contradictions: readonly SleepContradiction[];
}

export interface MemoryDashboard {
  generatedAt: string;
  currentState: ReturnType<CompanionStateStore['snapshot']>;
  knowledge: readonly KnowledgeAnswer[];
  personalityProfile: PersonalityProfile | null;
  activity: readonly ActivityItem[];
  world: readonly WorldItem[];
  items: readonly MemoryItem[];
  sleepReports: readonly SleepReport[];
  usage: {
    monthKey: string;
    dayKey: string;
    estimatedCostUsd: number;
    backgroundCostUsd: number;
    todayBackgroundCostUsd: number;
    backgroundBudgetUsd: number;
    backgroundRemainingUsd: number;
    rows: readonly LlmUsageSummaryRow[];
  } | null;
  evaluation: InitiativeEvaluationSummary | null;
  dailyMind: DailyMindFocus | null;
}

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  detail?: string;
  occurredAt: string;
}

export type MemoryAction = 'correct' | 'forget' | 'pin' | 'unpin' | 'reject' | 'restore' | 'complete' | 'dismiss' | 'snooze';

export interface MemoryMutation {
  memoryId: string;
  action: MemoryAction;
  text?: string;
}

export interface MemoryHistoryEvent {
  id: string;
  type: string;
  observedAt: string;
  payload: unknown;
}

export interface MemoryHistorySource {
  experienceCandidates(scopeKey: string): readonly ShannonExperience[];
  events(scopeKey: string): readonly MemoryHistoryEvent[];
}

export interface ActivityHistorySource {
  activityTimeline(scopeKey: string): readonly ActivityItem[];
}

export interface ShannonMemoryStore {
  dashboard(scopeKey: string): MemoryDashboard;
  mutate(scopeKey: string, mutation: MemoryMutation): MemoryDashboard;
}

export class ShannonMemoryService implements ShannonMemoryStore {
  constructor(
    private readonly stateStore: CompanionStateStore,
    private readonly history: MemoryHistorySource | ConversationStore | null,
    private readonly now: () => string,
    private readonly knowledgeStore: KnowledgeStore | null = null,
    private readonly worldReader: WorldReader | null = null,
    private readonly usageReader: LlmUsageReader | null = null,
    private readonly backgroundBudgetUsd = configuredBackgroundBudgetUsd(),
    private readonly initiativeEvaluationReader: InitiativeEvaluationReader | null = null,
    private readonly dailyMindReader: DailyMindReader | null = null,
  ) {}

  dashboard(scopeKey: string): MemoryDashboard {
    const state = this.stateStore.snapshot(scopeKey);
    const events = isHistorySource(this.history) ? this.history.events(scopeKey) : [];
    const experiences = this.history?.experienceCandidates(scopeKey) ?? [];
    const metadata = buildMetadata(events);
    const controls = new Map(state.memoryControls.map(control => [control.memoryId, control]));
    const items: MemoryItem[] = [];
    for (const memory of state.prospectiveMemories) {
      items.push({
        ...buildItem({ id: memory.id, kind: 'experience', text: memory.summary,
          observedAt: memory.createdAt, evidence: memory.evidence }, controls.get(memory.id)
            ?? (memory.sourceExperienceId ? controls.get(memory.sourceExperienceId) : undefined), metadata.get(memory.id)),
        updatedAt: controls.get(memory.id)?.updatedAt ?? memory.updatedAt,
        commitment: { status: memory.status, dueAt: memory.dueAt, dueDate: memory.dueDate,
          dueHint: memory.dueHint, timeZone: memory.timeZone, remindAfter: memory.remindAfter },
      });
    }

    for (const fact of state.userFacts) {
      items.push(buildItem({
        id: fact.id,
        kind: 'user-fact',
        text: fact.statement,
        confidence: fact.confidence,
        observedAt: fact.observedAt,
        evidence: fact.evidence,
      }, controls.get(fact.id), metadata.get(fact.id)));
    }
    for (const interest of state.interests) {
      const id = memoryIdentifier('interest', interest);
      const eventMeta = metadata.get(id) ?? metadata.get(`interest:${interest}`);
      items.push(buildItem({
        id,
        kind: 'interest',
        text: interest,
        observedAt: eventMeta?.createdAt ?? state.updatedAt,
      }, controls.get(id), eventMeta));
    }
    for (const relationship of state.relationships) {
      items.push(buildItem({
        id: relationship.id,
        kind: 'relationship',
        text: relationship.statement,
        confidence: relationship.confidence,
        observedAt: relationship.observedAt,
        evidence: relationship.evidence,
      }, controls.get(relationship.id), metadata.get(relationship.id)));
    }
    // Overview pagination must never orphan a durable control or pinned item.
    const managedExperiences = experiences.filter((experience, index) =>
      index >= experiences.length - 80 || controls.has(experience.id));
    for (const experience of managedExperiences.reverse()) {
      items.push(buildItem({
        id: experience.id,
        kind: 'experience',
        text: experience.summary,
        observedAt: experience.observedAt,
        evidence: experience.userMessage,
        relevance: state.activeMemories.find(memory => memory.id === experience.id)?.relevance,
      }, controls.get(experience.id), metadata.get(experience.id)));
    }

    const known = new Set(items.map(item => item.id));
    for (const control of state.memoryControls) {
      if (known.has(control.memoryId)) continue;
      items.push(buildItem({
        id: control.memoryId,
        kind: control.kind,
        text: control.overrideText ?? control.sourceEvidence ?? '元の内容を一覧で取得できない記憶',
        observedAt: control.updatedAt,
        ...(control.sourceEvidence ? { evidence: control.sourceEvidence } : {}),
      }, control, metadata.get(control.memoryId)));
    }

    items.sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || right.updatedAt.localeCompare(left.updatedAt));
    const generatedAt = this.now();
    const monthKey = generatedAt.slice(0, 7);
    const dayKey = localDayKey(generatedAt, 'Asia/Tokyo');
    const usageRows = this.usageReader?.llmUsageSummary(scopeKey, monthKey) ?? [];
    const backgroundCostUsd = this.usageReader?.backgroundLlmCostUsd(monthKey) ?? 0;
    return Object.freeze({
      generatedAt,
      currentState: presentCompanionState(state, generatedAt),
      knowledge: this.knowledgeStore?.knowledgeAnswers(scopeKey) ?? Object.freeze([]),
      personalityProfile: this.knowledgeStore?.personalityProfile(scopeKey) ?? null,
      activity: isActivityHistorySource(this.history)
        ? this.history.activityTimeline(scopeKey)
        : Object.freeze(buildActivity(events, experiences)),
      world: this.worldReader?.latestItems(40) ?? Object.freeze([]),
      items: Object.freeze(items.map(item => Object.freeze({ ...item, evidence: Object.freeze([...item.evidence]) }))),
      sleepReports: Object.freeze(parseSleepReports(events).slice(0, 30)),
      usage: this.usageReader ? Object.freeze({
        monthKey,
        dayKey,
        estimatedCostUsd: usageRows.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
        backgroundCostUsd,
        todayBackgroundCostUsd: this.usageReader.backgroundLlmCostUsdForDay?.(dayKey) ?? 0,
        backgroundBudgetUsd: this.backgroundBudgetUsd,
        backgroundRemainingUsd: Math.max(0, this.backgroundBudgetUsd - backgroundCostUsd),
        rows: Object.freeze([...usageRows]),
      }) : null,
      evaluation: this.initiativeEvaluationReader?.initiativeEvaluation(30, generatedAt) ?? null,
      dailyMind: this.dailyMindReader?.currentFocus(scopeKey, generatedAt) ?? null,
    });
  }

  mutate(scopeKey: string, mutation: MemoryMutation): MemoryDashboard {
    const current = this.dashboard(scopeKey);
    const item = current.items.find(candidate => candidate.id === mutation.memoryId);
    if (!item) throw new Error('MEMORY_NOT_FOUND');
    const state = this.stateStore.snapshot(scopeKey);
    const previous = memoryControlFor(state, item.id);
    const timestamp = this.now();
    const events: CompanionStateEvent[] = [];
    const promise = state.prospectiveMemories.find(memory => memory.id === item.id);
    if ((mutation.action === 'complete' || mutation.action === 'dismiss' || mutation.action === 'snooze') && !promise) {
      throw new Error('MEMORY_COMMITMENT_REQUIRED');
    }
    if (promise && mutation.action === 'snooze') {
      // 「あとで」 is a new revision of the same promise: one more reminder, inside the same daily slot.
      if (promise.status !== 'pending') throw new Error('MEMORY_COMMITMENT_REQUIRED');
      this.stateStore.apply(scopeKey, { type: 'prospective-memory-upserted', replace: true, memory: {
        ...promise, updatedAt: timestamp, remindAfter: new Date(Date.parse(timestamp) + SNOOZE_MILLISECONDS).toISOString(),
      } });
      return this.dashboard(scopeKey);
    }
    const source = this.history?.experienceCandidates(scopeKey).find(value => value.id === (promise?.sourceExperienceId ?? item.id));
    const control = { ...actionControl(item, previous, mutation, timestamp),
      sourceEvidence: previous?.sourceEvidence ?? source?.userMessage ?? item.evidence[0]?.quote,
      contextInvalidatedAt: ['forget', 'reject', 'correct'].includes(mutation.action) ? timestamp : previous?.contextInvalidatedAt };
    events.push({ type: 'memory-control-upserted', control });
    if (promise && mutation.action === 'correct' && control.overrideText) {
      const { dueAt: _at, dueDate: _date, dueHint: _hint, remindAfter: _remind, ...retained } = promise;
      events.push({ type: 'prospective-memory-upserted', replace: true, memory: {
        ...retained, summary: control.overrideText, updatedAt: timestamp,
        ...commitmentDeadline(control.overrideText, timestamp, promise.timeZone),
      } });
    }
    if (promise && ['complete', 'dismiss', 'forget', 'reject'].includes(mutation.action)) {
      events.push({ type: 'prospective-memory-status-changed', memoryId: promise.id,
        status: mutation.action === 'complete' ? 'completed' : 'dismissed' });
    }
    if (mutation.action === 'forget' || mutation.action === 'reject') {
      const sourceID = promise?.sourceExperienceId ?? item.id;
      const related = state.prospectiveMemories.filter(memory => memory.sourceExperienceId === sourceID);
      for (const id of new Set([sourceID, ...related.map(memory => memory.id)])) {
        events.push({ type: 'memory-control-upserted', control: { ...control, memoryId: id, kind: 'experience' } });
        events.push({ type: 'prospective-memory-status-changed', memoryId: id, status: 'dismissed' });
      }
    }
    if (item.kind === 'user-fact' && mutation.action === 'correct' && control.overrideText) {
      this.knowledgeStore?.correctKnowledge(scopeKey, item.id, control.overrideText, timestamp);
    }
    if (item.kind === 'experience' && !promise && control.status === 'active' && control.pinned) {
      events.push({
        type: 'memory-activated',
        memory: {
          id: item.id,
          summary: control.overrideText || item.text,
          relevance: 1,
          observedAt: item.createdAt,
        },
      });
    }
    this.stateStore.apply(scopeKey, { type: 'memory-transaction', events });
    return this.dashboard(scopeKey);
  }
}
