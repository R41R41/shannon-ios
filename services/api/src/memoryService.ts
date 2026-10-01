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
  disclosureView,
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
  /** Who was present and whether it is 機微 or ふつう. Absent for interests, which are never shown to others. */
  disclosure?: MemoryDisclosureView;
}

export interface MemoryDisclosureView {
  /** 「ライ氏と二人の時」「ミキさんと一緒の時」「グループの会話」 */
  audience: string;
  sensitivity: 'sensitive' | 'ordinary';
  /** `default`: recorded before labels existed, so it is treated as sensitive. */
  decidedBy: 'rule' | 'owner' | 'default';
  reason: string;
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

export type MemoryAction = 'correct' | 'forget' | 'pin' | 'unpin' | 'reject' | 'restore' | 'complete' | 'dismiss' | 'snooze'
  | 'mark-sensitive' | 'mark-ordinary';

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

const UNKNOWN_MEMORY_TEXT = '元の内容を一覧で取得できない記憶';

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
        disclosure: disclosureView(state, memory.id, memory.disclosure),
      });
    }

    for (const fact of state.userFacts) {
      items.push({ ...buildItem({
        id: fact.id,
        kind: 'user-fact',
        text: fact.statement,
        confidence: fact.confidence,
        observedAt: fact.observedAt,
        evidence: fact.evidence,
      }, controls.get(fact.id), metadata.get(fact.id)), disclosure: disclosureView(state, fact.id, fact.disclosure) });
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
      items.push({ ...buildItem({
        id: relationship.id,
        kind: 'relationship',
        text: relationship.statement,
        confidence: relationship.confidence,
        observedAt: relationship.observedAt,
        evidence: relationship.evidence,
      }, controls.get(relationship.id), metadata.get(relationship.id)), disclosure: disclosureView(state, relationship.id, relationship.disclosure) });
    }
    // Overview pagination must never orphan a durable control or pinned item.
    const managedExperiences = experiences.filter((experience, index) =>
      index >= experiences.length - 80 || controls.has(experience.id));
    for (const experience of managedExperiences.reverse()) {
      items.push({ ...buildItem({
        id: experience.id,
        kind: 'experience',
        text: experience.summary,
        observedAt: experience.observedAt,
        evidence: experience.userMessage,
        relevance: state.activeMemories.find(memory => memory.id === experience.id)?.relevance,
      }, controls.get(experience.id), metadata.get(experience.id)), disclosure: disclosureView(state, experience.id, experience.disclosure) });
    }

    const known = new Set(items.map(item => item.id));
    for (const control of state.memoryControls) {
      if (known.has(control.memoryId)) continue;
      items.push(buildItem({
        id: control.memoryId,
        kind: control.kind,
        text: control.overrideText ?? control.sourceEvidence ?? UNKNOWN_MEMORY_TEXT,
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
      // 「覚えていること」 lists what is in use: a forgotten or rejected answer moves to 記憶の管理 until restored.
      knowledge: Object.freeze((this.knowledgeStore?.knowledgeAnswers(scopeKey) ?? []).filter(answer => {
        const source = state.userFacts.find(fact => fact.id === answer.answerId)?.sourceExperienceId;
        return (controls.get(answer.answerId)?.status ?? 'active') === 'active' && (!source || (controls.get(source)?.status ?? 'active') === 'active');
      })),
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
    const hiding = mutation.action === 'forget' || mutation.action === 'reject';
    const statusBefore = previous && previous.status !== 'active' ? previous.commitmentStatusBefore : promise?.status;
    // Kept on the control so the rule survives the item leaving the bounded state.
    // A conversation turn is identified by the owner's utterance (sourceEvidence), not by its two-sided summary.
    const withheldText = previous?.withheldText ?? ((hiding || mutation.action === 'correct') && !previous?.overrideText
      && (item.kind !== 'experience' || promise) && item.text !== UNKNOWN_MEMORY_TEXT ? item.text : undefined);
    const control: MemoryControl = { ...actionControl(item, previous, mutation, timestamp),
      sourceEvidence: previous?.sourceEvidence ?? source?.userMessage ?? item.evidence[0]?.quote,
      contextInvalidatedAt: hiding || mutation.action === 'correct' ? timestamp : previous?.contextInvalidatedAt,
      ...(withheldText ? { withheldText } : {}),
      ...(previous?.causedBy && mutation.action !== 'restore' ? { causedBy: previous.causedBy } : {}),
      ...(hiding && statusBefore ? { commitmentStatusBefore: statusBefore } : {}) };
    events.push({ type: 'memory-control-upserted', control });
    // Everything hidden together with this item: its source turn and the promises made in that turn.
    const sourceID = promise?.sourceExperienceId ?? item.id;
    const together = [sourceID, ...state.prospectiveMemories.filter(memory => memory.sourceExperienceId === sourceID).map(memory => memory.id)]
      .filter((id, index, ids) => id !== item.id && ids.indexOf(id) === index);
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
    if (hiding) {
      for (const id of together) {
        const existing = memoryControlFor(state, id);
        // A control the owner set on that item directly stays theirs; restoring this item must not lift it.
        if (existing && existing.status !== 'active') continue;
        const memory = state.prospectiveMemories.find(candidate => candidate.id === id);
        events.push({ type: 'memory-control-upserted', control: {
          memoryId: id, kind: 'experience', status: control.status, pinned: false, updatedAt: timestamp,
          changeReason: control.changeReason, contextInvalidatedAt: timestamp, causedBy: item.id,
          ...(control.sourceEvidence ? { sourceEvidence: control.sourceEvidence } : {}),
          ...(existing?.overrideText ? { overrideText: existing.overrideText } : {}),
          ...(memory ? { commitmentStatusBefore: memory.status } : {}),
        } });
        if (memory) events.push({ type: 'prospective-memory-status-changed', memoryId: id, status: 'dismissed' });
      }
    }
    if (mutation.action === 'restore') {
      // One forget hides a group; restoring any member lifts that group and nothing the owner hid separately.
      const origin = previous?.causedBy ?? item.id;
      const reopen = (memory: typeof promise, before: MemoryControl | undefined) => {
        if (!memory || !before || before.status === 'active') return;
        const status = before.commitmentStatusBefore ?? (memory.status === 'dismissed' ? 'pending' : memory.status);
        if (status !== memory.status) events.push({ type: 'prospective-memory-status-changed', memoryId: memory.id, status });
      };
      reopen(promise, previous);
      for (const lifted of state.memoryControls) {
        // Controls written before `causedBy` existed are recognised by the shared instant and reason of that forget.
        const sameForget = !lifted.causedBy && previous && !previous.causedBy && previous.status !== 'active' && together.includes(lifted.memoryId)
          && lifted.updatedAt === previous.updatedAt && lifted.changeReason === previous.changeReason;
        if (lifted.memoryId === item.id || lifted.status === 'active') continue;
        if (lifted.memoryId !== origin && lifted.causedBy !== origin && !sameForget) continue;
        const { causedBy: _cause, commitmentStatusBefore: _before, ...kept } = lifted;
        events.push({ type: 'memory-control-upserted', control: { ...kept, status: 'active', updatedAt: timestamp, changeReason: control.changeReason } });
        reopen(state.prospectiveMemories.find(memory => memory.id === lifted.memoryId), lifted);
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
