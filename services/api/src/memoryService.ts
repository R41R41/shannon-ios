import {
  memoryControlFor,
  memoryIdentifier,
  type CompanionStateStore,
  type MemoryControl,
  type MemoryKind,
  type MemoryStatus,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from './conversationStore.js';
import type { KnowledgeAnswer, KnowledgeStore } from './knowledgeStore.js';
import type { PersonalityProfile } from './knowledgeStore.js';
import type { WorldItem, WorldReader } from './worldStore.js';
import { configuredBackgroundBudgetUsd, type LlmUsageReader, type LlmUsageSummaryRow } from './llmUsage.js';
import type { InitiativeEvaluationReader, InitiativeEvaluationSummary } from './initiativeStore.js';

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
    estimatedCostUsd: number;
    backgroundCostUsd: number;
    backgroundBudgetUsd: number;
    backgroundRemainingUsd: number;
    rows: readonly LlmUsageSummaryRow[];
  } | null;
  evaluation: InitiativeEvaluationSummary | null;
}

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  detail?: string;
  occurredAt: string;
}

export type MemoryAction = 'correct' | 'forget' | 'pin' | 'unpin' | 'reject' | 'restore';

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
  ) {}

  dashboard(scopeKey: string): MemoryDashboard {
    const state = this.stateStore.snapshot(scopeKey);
    const events = isHistorySource(this.history) ? this.history.events(scopeKey) : [];
    const experiences = this.history?.experienceCandidates(scopeKey) ?? [];
    const metadata = buildMetadata(events);
    const controls = new Map(state.memoryControls.map(control => [control.memoryId, control]));
    const items: MemoryItem[] = [];

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
    for (const experience of experiences.slice(-80).reverse()) {
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
      if (known.has(control.memoryId) || !control.overrideText) continue;
      items.push(buildItem({
        id: control.memoryId,
        kind: control.kind,
        text: control.overrideText,
        observedAt: control.updatedAt,
      }, control, metadata.get(control.memoryId)));
    }

    items.sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || right.updatedAt.localeCompare(left.updatedAt));
    const generatedAt = this.now();
    const monthKey = generatedAt.slice(0, 7);
    const usageRows = this.usageReader?.llmUsageSummary(scopeKey, monthKey) ?? [];
    const backgroundCostUsd = this.usageReader?.backgroundLlmCostUsd(monthKey) ?? 0;
    return Object.freeze({
      generatedAt,
      currentState: state,
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
        estimatedCostUsd: usageRows.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
        backgroundCostUsd,
        backgroundBudgetUsd: this.backgroundBudgetUsd,
        backgroundRemainingUsd: Math.max(0, this.backgroundBudgetUsd - backgroundCostUsd),
        rows: Object.freeze([...usageRows]),
      }) : null,
      evaluation: this.initiativeEvaluationReader?.initiativeEvaluation(30, generatedAt) ?? null,
    });
  }

  mutate(scopeKey: string, mutation: MemoryMutation): MemoryDashboard {
    const current = this.dashboard(scopeKey);
    const item = current.items.find(candidate => candidate.id === mutation.memoryId);
    if (!item) throw new Error('MEMORY_NOT_FOUND');
    const state = this.stateStore.snapshot(scopeKey);
    const previous = memoryControlFor(state, item.id);
    const timestamp = this.now();
    const control = actionControl(item, previous, mutation, timestamp);
    this.stateStore.apply(scopeKey, { type: 'memory-control-upserted', control });
    if (item.kind === 'user-fact' && mutation.action === 'correct' && control.overrideText) {
      this.knowledgeStore?.correctKnowledge(scopeKey, item.id, control.overrideText, timestamp);
    }
    if (item.kind === 'experience' && control.status === 'active' && control.pinned) {
      this.stateStore.apply(scopeKey, {
        type: 'memory-activated',
        memory: {
          id: item.id,
          summary: control.overrideText || item.text,
          relevance: 1,
          observedAt: item.createdAt,
        },
      });
    }
    return this.dashboard(scopeKey);
  }
}

function buildActivity(
  events: readonly MemoryHistoryEvent[],
  experiences: readonly ShannonExperience[],
): ActivityItem[] {
  const activities: ActivityItem[] = experiences.slice(-60).map(experience => ({
    id: experience.id,
    type: 'conversation',
    title: 'トーク',
    detail: experience.summary,
    occurredAt: experience.observedAt,
  }));
  for (const event of events) {
    if (event.type === 'sleep.completed') {
      const payload = objectValue(event.payload);
      activities.push({
        id: event.id,
        type: 'sleep',
        title: '睡眠バッチ',
        detail: stringValue(payload?.dayKey) ?? undefined,
        occurredAt: event.observedAt,
      });
    } else if (event.type === 'state.user-fact-upserted') {
      activities.push({
        id: event.id,
        type: 'knowledge',
        title: '知識を更新',
        occurredAt: event.observedAt,
      });
    }
  }
  return activities.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 100);
}

function actionControl(
  item: MemoryItem,
  previous: MemoryControl | undefined,
  mutation: MemoryMutation,
  timestamp: string,
): MemoryControl {
  let status = previous?.status ?? item.status;
  let pinned = previous?.pinned ?? item.pinned;
  let overrideText = previous?.overrideText;
  let changeReason: string;
  switch (mutation.action) {
    case 'correct': {
      const text = mutation.text?.replace(/\s+/g, ' ').trim().slice(0, 320);
      if (!text) throw new Error('MEMORY_CORRECTION_REQUIRED');
      status = 'active';
      overrideText = text;
      changeReason = 'ユーザーが内容を訂正';
      break;
    }
    case 'forget':
      status = 'forgotten';
      pinned = false;
      changeReason = 'ユーザーが忘れるよう指定';
      break;
    case 'reject':
      status = 'rejected';
      pinned = false;
      changeReason = 'ユーザーが事実ではないと指定';
      break;
    case 'pin':
      status = 'active';
      pinned = true;
      changeReason = 'ユーザーが大切な記憶として固定';
      break;
    case 'unpin':
      pinned = false;
      changeReason = 'ユーザーが固定を解除';
      break;
    case 'restore':
      status = 'active';
      changeReason = 'ユーザーが記憶を復元';
      break;
  }
  return {
    memoryId: item.id,
    kind: item.kind,
    status,
    pinned,
    updatedAt: timestamp,
    changeReason,
    ...(overrideText ? { overrideText } : {}),
  };
}

interface ItemSeed {
  id: string;
  kind: MemoryKind;
  text: string;
  confidence?: number;
  relevance?: number;
  observedAt: string;
  evidence?: string;
}

interface MemoryMetadata {
  createdAt: string;
  updatedAt: string;
  changeReason: string;
}

function buildItem(seed: ItemSeed, control?: MemoryControl, metadata?: MemoryMetadata): MemoryItem {
  const updatedAt = control?.updatedAt ?? metadata?.updatedAt ?? seed.observedAt;
  return {
    id: seed.id,
    kind: seed.kind,
    text: control?.overrideText || seed.text,
    ...(seed.confidence !== undefined ? { confidence: seed.confidence } : {}),
    ...(seed.relevance !== undefined ? { relevance: seed.relevance } : {}),
    status: control?.status ?? 'active',
    pinned: control?.pinned ?? false,
    createdAt: metadata?.createdAt ?? seed.observedAt,
    updatedAt,
    changeReason: control?.changeReason ?? metadata?.changeReason ?? defaultReason(seed.kind),
    evidence: seed.evidence ? [{
      quote: seed.evidence,
      observedAt: seed.observedAt,
      source: seed.kind === 'experience' || metadata?.changeReason.startsWith('会話から') ? 'conversation' : 'sleep',
    }] : [],
  };
}

function defaultReason(kind: MemoryKind): string {
  switch (kind) {
    case 'user-fact': return '会話を睡眠中に整理して学習';
    case 'relationship': return '会話から関わり方を学習';
    case 'interest': return '会話との共鳴から関心が変化';
    case 'experience': return '会話として記憶';
  }
}

function isHistorySource(value: MemoryHistorySource | ConversationStore | null): value is MemoryHistorySource {
  return value !== null && 'events' in value && typeof value.events === 'function';
}

function isActivityHistorySource(value: MemoryHistorySource | ConversationStore | null): value is MemoryHistorySource & ActivityHistorySource {
  return value !== null && 'activityTimeline' in value && typeof value.activityTimeline === 'function';
}

function buildMetadata(events: readonly MemoryHistoryEvent[]): Map<string, MemoryMetadata> {
  const result = new Map<string, MemoryMetadata>();
  for (const event of events) {
    if (event.type === 'turn.completed') {
      mergeMetadata(result, event.id, event.observedAt, '会話として記憶');
      continue;
    }
    if (!event.type.startsWith('state.')) continue;
    const payload = objectValue(event.payload);
    const stateEvent = objectValue(payload?.event);
    if (!stateEvent) continue;
    let id: string | null = null;
    let reason = '共有状態を更新';
    if (stateEvent.type === 'user-fact-upserted') {
      id = stringValue(objectValue(stateEvent.fact)?.id);
      reason = stateEvent.source === 'conversation' ? '会話からすぐにユーザー理解を更新' : '睡眠中にユーザー理解を更新';
    } else if (stateEvent.type === 'relationship-upserted') {
      id = stringValue(objectValue(stateEvent.relationship)?.id);
      reason = stateEvent.source === 'conversation' ? '会話からすぐに関係の理解を更新' : '睡眠中に関係の理解を更新';
    } else if (stateEvent.type === 'interest-observed') {
      const interest = stringValue(stateEvent.interest);
      id = interest ? `interest:${interest}` : null;
      reason = stateEvent.source === 'conversation' ? '会話からすぐに関心を更新' : '会話との共鳴で関心を更新';
    } else if (stateEvent.type === 'memory-control-upserted') {
      id = stringValue(objectValue(stateEvent.control)?.memoryId);
      reason = stringValue(objectValue(stateEvent.control)?.changeReason) ?? 'ユーザー操作で更新';
    } else if (stateEvent.type === 'memory-activated') {
      id = stringValue(objectValue(stateEvent.memory)?.id);
      reason = '会話から想起';
    }
    if (id) mergeMetadata(result, id, event.observedAt, reason);
  }
  return result;
}

function mergeMetadata(result: Map<string, MemoryMetadata>, id: string, at: string, reason: string): void {
  const previous = result.get(id);
  result.set(id, {
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
    changeReason: reason,
  });
}

function parseSleepReports(events: readonly MemoryHistoryEvent[]): SleepReport[] {
  return events.filter(event => event.type === 'sleep.completed').reverse().flatMap(event => {
    const payload = objectValue(event.payload);
    const dayKey = stringValue(payload?.dayKey);
    if (!dayKey) return [];
    return [{
      dayKey,
      completedAt: event.observedAt,
      learned: parseChanges(payload?.learned),
      updated: parseChanges(payload?.updated),
      interestChanges: parseChanges(payload?.interestChanges),
      contradictions: parseContradictions(payload?.contradictions),
    }];
  });
}

function parseChanges(value: unknown): SleepChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const item = objectValue(row);
    const kind = memoryKind(item?.kind);
    const memoryId = stringValue(item?.memoryId);
    const text = stringValue(item?.text);
    const reason = stringValue(item?.reason);
    if (!kind || !memoryId || !text || !reason) return [];
    const evidence = stringValue(item?.evidence);
    return [{ kind, memoryId, text, reason, ...(evidence ? { evidence } : {}) }];
  });
}

function parseContradictions(value: unknown): SleepContradiction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const item = objectValue(row);
    const kind = memoryKind(item?.kind);
    const memoryId = stringValue(item?.memoryId);
    const currentText = stringValue(item?.currentText);
    const candidateText = stringValue(item?.candidateText);
    const reason = stringValue(item?.reason);
    const evidence = stringValue(item?.evidence);
    return kind && memoryId && currentText && candidateText && reason && evidence
      ? [{ kind, memoryId, currentText, candidateText, reason, evidence }]
      : [];
  });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function memoryKind(value: unknown): MemoryKind | null {
  return value === 'user-fact' || value === 'interest' || value === 'experience' || value === 'relationship'
    ? value : null;
}
