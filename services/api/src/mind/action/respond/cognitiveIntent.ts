import { randomUUID } from 'node:crypto';
import type {
  ShannonCognitiveFrame,
  ShannonExperienceChannel,
  ShannonIntent,
  ShannonVerifiedWork,
} from '@shannon/cognition';
import { isNearTermOrConditionalWish, widenedGoalStatement } from './intentRules.js';
import { intentKey, boundedLimit } from './store/cognitiveIntentStore.js';
export { SQLiteCognitiveIntentStore } from './store/cognitiveIntentStore.js';

export interface CognitiveIntentPlan {
  nextStep: string;
  steps: readonly string[];
}

export type CognitiveIntentStatus = ShannonIntent['status'];

export interface CognitiveCycleReceipt {
  id: string;
  threadId: string;
  channel: ShannonExperienceChannel;
  primaryIntentID?: string;
  recalledMemoryIDs: readonly string[];
  action: 'respond' | 'command' | 'delegate';
  outcome: 'completed' | 'failed';
  summary: string;
  occurredAt: string;
}

export interface CognitiveIntentStore {
  list(scopeKey: string, status?: CognitiveIntentStatus): readonly ShannonIntent[];
  capture(scopeKey: string, intent: ShannonIntent, sourceExperienceId?: string): ShannonIntent;
  get(scopeKey: string, intentID: string): ShannonIntent | null;
  updatePlan(scopeKey: string, intentID: string, plan: CognitiveIntentPlan, at: string): ShannonIntent | null;
  linkTask(scopeKey: string, intentID: string, taskID: string, at: string): ShannonIntent | null;
  updateVerifiedWork(
    scopeKey: string,
    intentID: string,
    work: ShannonVerifiedWork,
    nextStep: string,
    at: string,
  ): ShannonIntent | null;
  updateStatus(scopeKey: string, intentID: string, status: CognitiveIntentStatus, at: string): ShannonIntent | null;
  recordCycle(scopeKey: string, frame: ShannonCognitiveFrame, receipt: Omit<CognitiveCycleReceipt, 'id'>): CognitiveCycleReceipt;
  recentCycles(scopeKey: string, limit?: number): readonly CognitiveCycleReceipt[];
}

export function extractExplicitUserIntent(
  message: string,
  threadId: string,
  occurredAt: string,
): ShannonIntent | null {
  const text = message.replace(/\s+/gu, ' ').trim();
  if (text.length < 4 || text.length > 1_000 || /(?:したくない|するつもりはない|やめたい|中止したい)/u.test(text)) return null;
  if (/^(?:その方針で)?(?:引き続き)?[、\s]*(?:お願い(?:します)?|よろしく(?:お願い(?:します)?)?|続けて(?:ください)?|進めて(?:ください)?)[。.!！]?$/u.test(text)) return null;

  const goalMatch = text.match(/^(?:私の)?(?:目標|目的|ゴール)(?:は|:|：)?[、\s]*(.{3,320})[。.!！]?$/u);
  const ongoingMatch = text.match(/^(?:今後|これから|引き続き|最終的には|最終目標として)[、\s]*(.{3,320})[。.!！]?$/u);
  const directMatch = text.match(/^(.{3,280}?(?:実装|改善|統合|構築|作成|開発|修正|整理|実現|完成|進め|育て)(?:したい|たい|てほしい|てください|てお願いします))[。.!！]?$/u);
  const captured = goalMatch?.[1] ?? (ongoingMatch && meaningfulOngoingGoal(ongoingMatch[1]!) ? ongoingMatch[1] : undefined)
    ?? (directMatch && !isNearTermOrConditionalWish(text) ? directMatch[1] : undefined) ?? widenedGoalStatement(text) ?? undefined;
  if (!captured) return null;
  const desiredOutcome = captured.replace(/[。.!！]+$/gu, '').trim();
  const title = conciseIntentTitle(desiredOutcome);
  if (title.length < 3) return null;
  return Object.freeze({
    id: randomUUID(),
    title,
    desiredOutcome,
    status: 'active',
    source: 'explicit-user-goal',
    threadId,
    priority: goalMatch ? 0.8 : 0.65,
    confidence: 0.95,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

function meaningfulOngoingGoal(value: string): boolean {
  const normalized = value.replace(/[。.!！]+$/gu, '').replace(/(?:してください|お願いします)$/u, '').trim();
  if (/^(?:お願い(?:します)?|よろしく(?:お願い(?:します)?)?|続けて|進めて)$/u.test(normalized)) return false;
  return /(?:したい|てほしい|てください|てお願いします|続けたい|進めたい|実現したい|完成させたい)$/u.test(normalized);
}

function conciseIntentTitle(value: string): string {
  return value.replace(/(?:してください|してほしい|お願いします)$/u, '')
    .replace(/^(?:私は|シャノンに|シャノンを)[、\s]*/u, '')
    .trim().slice(0, 120);
}

export class InMemoryCognitiveIntentStore implements CognitiveIntentStore {
  private readonly intents = new Map<string, ShannonIntent[]>();
  private readonly cycles = new Map<string, CognitiveCycleReceipt[]>();

  list(scopeKey: string, status?: CognitiveIntentStatus): readonly ShannonIntent[] {
    return Object.freeze((this.intents.get(scopeKey) ?? []).filter(item => !status || item.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(item => Object.freeze({ ...item })));
  }

  get(scopeKey: string, intentID: string): ShannonIntent | null {
    return this.list(scopeKey).find(item => item.id === intentID) ?? null;
  }

  capture(scopeKey: string, intent: ShannonIntent, sourceExperienceId?: string): ShannonIntent {
    const rows = this.intents.get(scopeKey) ?? [];
    const existing = rows.find(item => item.status === 'active' && intentKey(item) === intentKey(intent));
    const saved = Object.freeze({
      ...(existing ?? intent),
      desiredOutcome: intent.desiredOutcome,
      threadId: intent.threadId,
      priority: Math.max(existing?.priority ?? 0, intent.priority),
      confidence: Math.max(existing?.confidence ?? 0, intent.confidence),
      updatedAt: intent.updatedAt,
      ...(sourceExperienceId ? { sourceExperienceId } : {}),
    });
    const next = existing ? rows.map(item => item.id === existing.id ? saved : item) : [...rows, saved];
    this.intents.set(scopeKey, next.slice(-100));
    return saved;
  }

  updateStatus(scopeKey: string, intentID: string, status: CognitiveIntentStatus, at: string): ShannonIntent | null {
    const rows = this.intents.get(scopeKey) ?? [];
    const existing = rows.find(item => item.id === intentID);
    if (!existing) return null;
    if (status === 'active' && rows.some(item => item.id !== intentID && item.status === 'active' && intentKey(item) === intentKey(existing))) {
      throw new Error('COGNITIVE_INTENT_ACTIVE_CONFLICT');
    }
    const saved = Object.freeze({ ...existing, status, updatedAt: at });
    this.intents.set(scopeKey, rows.map(item => item.id === intentID ? saved : item));
    return saved;
  }

  updatePlan(scopeKey: string, intentID: string, plan: CognitiveIntentPlan, at: string): ShannonIntent | null {
    const rows = this.intents.get(scopeKey) ?? [];
    const existing = rows.find(item => item.id === intentID);
    if (!existing) return null;
    const saved = Object.freeze({
      ...existing,
      nextStep: plan.nextStep,
      planSteps: Object.freeze([...plan.steps]),
      updatedAt: at,
    });
    this.intents.set(scopeKey, rows.map(item => item.id === intentID ? saved : item));
    return saved;
  }

  linkTask(scopeKey: string, intentID: string, taskID: string, at: string): ShannonIntent | null {
    const rows = this.intents.get(scopeKey) ?? [];
    const existing = rows.find(item => item.id === intentID);
    if (!existing) return null;
    const saved = Object.freeze({ ...existing, linkedTaskId: taskID, updatedAt: at });
    this.intents.set(scopeKey, rows.map(item => item.id === intentID ? saved : item));
    return saved;
  }

  updateVerifiedWork(
    scopeKey: string,
    intentID: string,
    work: ShannonVerifiedWork,
    nextStep: string,
    at: string,
  ): ShannonIntent | null {
    const rows = this.intents.get(scopeKey) ?? [];
    const existing = rows.find(item => item.id === intentID && (!item.linkedTaskId || item.linkedTaskId === work.taskId));
    if (!existing) return null;
    const planSteps = work.plan.length ? Object.freeze(work.plan.slice(0, 5).map(item => item.title)) : existing.planSteps;
    const saved = Object.freeze({
      ...existing,
      linkedTaskId: work.taskId,
      verifiedWork: Object.freeze({ ...work, plan: Object.freeze([...work.plan]) }),
      nextStep,
      ...(planSteps?.length ? { planSteps } : {}),
      updatedAt: at,
    });
    this.intents.set(scopeKey, rows.map(item => item.id === intentID ? saved : item));
    return saved;
  }

  recordCycle(scopeKey: string, frame: ShannonCognitiveFrame, receipt: Omit<CognitiveCycleReceipt, 'id'>): CognitiveCycleReceipt {
    const saved = Object.freeze({ id: randomUUID(), ...receipt,
      ...(frame.primaryIntent ? { primaryIntentID: frame.primaryIntent.id } : {}),
      recalledMemoryIDs: frame.recalledMemoryIDs });
    this.cycles.set(scopeKey, [...this.cycles.get(scopeKey) ?? [], saved].slice(-500));
    return saved;
  }

  recentCycles(scopeKey: string, limit = 20): readonly CognitiveCycleReceipt[] {
    return Object.freeze((this.cycles.get(scopeKey) ?? []).slice(-boundedLimit(limit)).reverse());
  }
}
