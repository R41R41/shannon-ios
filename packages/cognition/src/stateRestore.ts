import type {
  CompanionStateSnapshot,
  ShannonEmotion,
  ShannonTemperament,
} from './types.js';
import { restoreShannonExpressiveEmotion } from './emotionState.js';
import {
  MAX_ACTIVE_MEMORIES,
  MAX_INTERESTS,
  MAX_MEMORY_CONTROLS,
  MAX_PROSPECTIVE_MEMORIES,
  MAX_RELATIONSHIPS,
  MAX_USER_FACTS,
  clamp,
  cleanControl,
  cleanFact,
  cleanMemory,
  cleanProspectiveMemory,
  cleanRelationship,
  cleanText,
  createInitialCompanionState,
  freezeSnapshot,
  normalizeMemories,
} from './state.js';
import { restoreSharedDays } from './temperament.js';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function restoredNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

function restoredTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function restoredText(value: unknown, maximumLength: number): string {
  return typeof value === 'string' ? cleanText(value, maximumLength) : '';
}

function restoredItems<T>(
  value: unknown,
  maximum: number,
  parse: (item: Record<string, unknown>) => T | null,
  identity: (item: T) => string,
): T[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, T>();
  for (const candidate of value) {
    const row = recordValue(candidate);
    if (!row) continue;
    const item = parse(row);
    if (!item) continue;
    const id = identity(item);
    if (!unique.has(id)) unique.set(id, item);
  }
  return [...unique.values()].slice(0, maximum);
}

/** Restores persisted JSON through the same bounds used by live state updates. */
export function restoreCompanionState(
  scopeKey: string,
  candidate: unknown,
  nowIso: string,
): CompanionStateSnapshot {
  const initial = createInitialCompanionState(scopeKey, nowIso);
  const row = recordValue(candidate);
  if (!row || row.scopeKey !== scopeKey) return initial;

  const temperamentRow = recordValue(row.temperament);
  const emotionRow = recordValue(row.emotion);
  const temperament: ShannonTemperament = {
    curiosity: restoredNumber(temperamentRow?.curiosity, initial.temperament.curiosity, 0, 1),
    initiative: restoredNumber(temperamentRow?.initiative, initial.temperament.initiative, 0, 1),
    closeness: restoredNumber(temperamentRow?.closeness, initial.temperament.closeness, 0, 1),
    calmness: restoredNumber(temperamentRow?.calmness, initial.temperament.calmness, 0, 1),
    needForContinuity: restoredNumber(temperamentRow?.needForContinuity, initial.temperament.needForContinuity, 0, 1),
    confidenceAboutUser: restoredNumber(temperamentRow?.confidenceAboutUser, initial.temperament.confidenceAboutUser, 0, 1),
  };
  const emotion: ShannonEmotion = {
    valence: restoredNumber(emotionRow?.valence, initial.emotion.valence, -1, 1),
    arousal: restoredNumber(emotionRow?.arousal, initial.emotion.arousal, 0, 1),
    openness: restoredNumber(emotionRow?.openness, initial.emotion.openness, 0, 1),
  };
  const expressiveEmotion = restoreShannonExpressiveEmotion(
    row.expressiveEmotion,
    initial.expressiveEmotion!,
  );
  const interests = Array.isArray(row.interests)
    ? [...new Set(row.interests.map(value => restoredText(value, 120)).filter(Boolean))].slice(0, MAX_INTERESTS)
    : [];
  const userFacts = restoredItems(row.userFacts, MAX_USER_FACTS, value => {
    const id = restoredText(value.id, 120);
    const statement = restoredText(value.statement, 320);
    if (!id || !statement) return null;
    return cleanFact({
      id,
      statement,
      confidence: restoredNumber(value.confidence, 0, 0, 1),
      observedAt: restoredTimestamp(value.observedAt, nowIso),
      ...(restoredText(value.evidence, 320) ? { evidence: restoredText(value.evidence, 320) } : {}),
      ...(restoredText(value.sourceExperienceId, 120) ? { sourceExperienceId: restoredText(value.sourceExperienceId, 120) } : {}),
    });
  }, item => item.id);
  const activeMemories = normalizeMemories(restoredItems(row.activeMemories, MAX_ACTIVE_MEMORIES * 2, value => {
    const id = restoredText(value.id, 120);
    const summary = restoredText(value.summary, 320);
    if (!id || !summary) return null;
    return cleanMemory({
      id,
      summary,
      relevance: restoredNumber(value.relevance, 0, 0, 1),
      observedAt: restoredTimestamp(value.observedAt, nowIso),
    });
  }, item => item.id));
  const relationships = restoredItems(row.relationships, MAX_RELATIONSHIPS, value => {
    const id = restoredText(value.id, 120);
    const statement = restoredText(value.statement, 320);
    if (!id || !statement) return null;
    return cleanRelationship({
      id,
      statement,
      confidence: restoredNumber(value.confidence, 0, 0, 1),
      observedAt: restoredTimestamp(value.observedAt, nowIso),
      ...(restoredText(value.evidence, 320) ? { evidence: restoredText(value.evidence, 320) } : {}),
      ...(restoredText(value.sourceExperienceId, 120) ? { sourceExperienceId: restoredText(value.sourceExperienceId, 120) } : {}),
    });
  }, item => item.id);
  const prospectiveMemories = restoredItems(row.prospectiveMemories, MAX_PROSPECTIVE_MEMORIES, value => {
    const id = restoredText(value.id, 120);
    const summary = restoredText(value.summary, 320);
    const status = value.status;
    if (!id || !summary || (status !== 'pending' && status !== 'completed' && status !== 'dismissed')) return null;
    const createdAt = restoredTimestamp(value.createdAt, nowIso);
    return cleanProspectiveMemory({
      id,
      summary,
      status,
      createdAt,
      updatedAt: restoredTimestamp(value.updatedAt, createdAt),
      ...(restoredText(value.dueHint, 80) ? { dueHint: restoredText(value.dueHint, 80) } : {}),
      ...(typeof value.dueAt === 'string' ? { dueAt: value.dueAt } : {}),
      ...(typeof value.dueDate === 'string' ? { dueDate: value.dueDate } : {}),
      ...(typeof value.timeZone === 'string' ? { timeZone: value.timeZone } : {}),
      ...(typeof value.sourceExperienceId === 'string' ? { sourceExperienceId: value.sourceExperienceId } : {}),
      ...(restoredText(value.evidence, 320) ? { evidence: restoredText(value.evidence, 320) } : {}),
      ...(typeof value.remindAfter === 'string' ? { remindAfter: value.remindAfter } : {}),
    });
  }, item => item.id);
  const memoryControls = restoredItems(row.memoryControls, MAX_MEMORY_CONTROLS, value => {
    const memoryId = restoredText(value.memoryId, 120);
    const changeReason = restoredText(value.changeReason, 240);
    const kind = value.kind;
    const status = value.status;
    if (!memoryId || !changeReason
      || (kind !== 'user-fact' && kind !== 'interest' && kind !== 'experience' && kind !== 'relationship')
      || (status !== 'active' && status !== 'forgotten' && status !== 'rejected')) return null;
    return cleanControl({
      memoryId,
      kind,
      status,
      pinned: value.pinned === true,
      updatedAt: restoredTimestamp(value.updatedAt, nowIso),
      changeReason,
      ...(restoredText(value.overrideText, 320) ? { overrideText: restoredText(value.overrideText, 320) } : {}),
      ...(restoredText(value.sourceEvidence, 8_000) ? { sourceEvidence: restoredText(value.sourceEvidence, 8_000) } : {}),
      ...(typeof value.contextInvalidatedAt === 'string' ? { contextInvalidatedAt: value.contextInvalidatedAt } : {}),
    });
  }, item => item.memoryId);

  return freezeSnapshot({
    scopeKey,
    version: typeof row.version === 'number' && Number.isSafeInteger(row.version) && row.version >= 0 ? row.version : 0,
    updatedAt: restoredTimestamp(row.updatedAt, nowIso),
    temperament,
    emotion,
    expressiveEmotion,
    interests,
    userFacts,
    activeMemories,
    relationships,
    prospectiveMemories,
    memoryControls,
    ...(Array.isArray(row.sharedDays) ? { sharedDays: restoreSharedDays(row.sharedDays) } : {}),
  });
}
