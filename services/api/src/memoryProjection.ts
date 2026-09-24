import {
  memoryIdentifier,
  type MemoryControl,
  type MemoryKind,
  type MemoryStatus,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from './conversationStore.js';
import type {
  ActivityHistorySource,
  ActivityItem,
  MemoryHistoryEvent,
  MemoryHistorySource,
  MemoryItem,
  MemoryMutation,
  SleepChange,
  SleepContradiction,
  SleepReport,
} from './memoryService.js';

export function localDayKey(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '00';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function buildActivity(
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

export function actionControl(
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
    case 'complete':
      changeReason = 'ユーザーが約束を完了';
      break;
    case 'dismiss':
      changeReason = 'ユーザーが約束を取り消し';
      break;
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

export function buildItem(seed: ItemSeed, control?: MemoryControl, metadata?: MemoryMetadata): MemoryItem {
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

export function defaultReason(kind: MemoryKind): string {
  switch (kind) {
    case 'user-fact': return '会話を睡眠中に整理して学習';
    case 'relationship': return '会話から関わり方を学習';
    case 'interest': return '会話との共鳴から関心が変化';
    case 'experience': return '会話として記憶';
  }
}

export function isHistorySource(value: MemoryHistorySource | ConversationStore | null): value is MemoryHistorySource {
  return value !== null && 'events' in value && typeof value.events === 'function';
}

export function isActivityHistorySource(value: MemoryHistorySource | ConversationStore | null): value is MemoryHistorySource & ActivityHistorySource {
  return value !== null && 'activityTimeline' in value && typeof value.activityTimeline === 'function';
}

export function buildMetadata(events: readonly MemoryHistoryEvent[]): Map<string, MemoryMetadata> {
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

export function mergeMetadata(result: Map<string, MemoryMetadata>, id: string, at: string, reason: string): void {
  const previous = result.get(id);
  result.set(id, {
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
    changeReason: reason,
  });
}

export function parseSleepReports(events: readonly MemoryHistoryEvent[]): SleepReport[] {
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
      ...(validCommitmentReview(payload?.commitmentReview) ? { commitmentReview: payload!.commitmentReview as import('./sleepCommitmentReview.js').CommitmentSleepReview } : {}),
    }];
  });
}

function validCommitmentReview(value: unknown): boolean {
  const record = objectValue(value);
  return Boolean(record && ['pending', 'completed', 'dismissed', 'needsDateClarification', 'overdue']
    .every(key => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0));
}

export function parseChanges(value: unknown): SleepChange[] {
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

export function parseContradictions(value: unknown): SleepContradiction[] {
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

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function memoryKind(value: unknown): MemoryKind | null {
  return value === 'user-fact' || value === 'interest' || value === 'experience' || value === 'relationship'
    ? value : null;
}
