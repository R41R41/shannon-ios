import type {
  ActiveMemory,
  CompanionStateEvent,
  CompanionStateSnapshot,
  ShannonEmotion,
  ShannonTemperament,
  MemoryControl,
  ProspectiveMemory,
  RelationshipInsight,
  UserFact,
} from './types.js';
import {
  INITIAL_SHANNON_EXPRESSIVE_EMOTION,
  normalizeShannonExpressiveEmotion,
  restoreShannonExpressiveEmotion,
  sameShannonExpressiveEmotion,
} from './emotionState.js';

export const INITIAL_SHANNON_TEMPERAMENT: Readonly<ShannonTemperament> = Object.freeze({
  curiosity: 0.65,
  initiative: 0.25,
  closeness: 0.15,
  calmness: 0.60,
  needForContinuity: 0.70,
  confidenceAboutUser: 0.05,
});

export const INITIAL_SHANNON_EMOTION: Readonly<ShannonEmotion> = Object.freeze({
  valence: 0,
  arousal: 0.30,
  openness: 0.35,
});

const MAX_INTERESTS = 12;
const MAX_USER_FACTS = 24;
const MAX_ACTIVE_MEMORIES = 8;
const MAX_RELATIONSHIPS = 24;
// These are authoritative records, not working-memory projections. Never evict
// unresolved commitments or explicit forget boundaries when another is added.
const MAX_MEMORY_CONTROLS = Number.POSITIVE_INFINITY;
const MAX_PROSPECTIVE_MEMORIES = Number.POSITIVE_INFINITY;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanText(value: string, maximumLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

function cleanFact(fact: UserFact): UserFact {
  return Object.freeze({
    id: cleanText(fact.id, 120),
    statement: cleanText(fact.statement, 320),
    confidence: clamp(fact.confidence, 0, 1),
    observedAt: fact.observedAt,
    ...(fact.evidence ? { evidence: cleanText(fact.evidence, 320) } : {}),
    ...(fact.sourceExperienceId ? { sourceExperienceId: cleanText(fact.sourceExperienceId, 120) } : {}),
  });
}

function cleanMemory(memory: ActiveMemory): ActiveMemory {
  return Object.freeze({
    id: cleanText(memory.id, 120),
    summary: cleanText(memory.summary, 320),
    relevance: clamp(memory.relevance, 0, 1),
    observedAt: memory.observedAt,
  });
}

function cleanRelationship(relationship: RelationshipInsight): RelationshipInsight {
  return Object.freeze({
    id: cleanText(relationship.id, 120),
    statement: cleanText(relationship.statement, 320),
    confidence: clamp(relationship.confidence, 0, 1),
    observedAt: relationship.observedAt,
    ...(relationship.evidence ? { evidence: cleanText(relationship.evidence, 320) } : {}),
    ...(relationship.sourceExperienceId ? { sourceExperienceId: cleanText(relationship.sourceExperienceId, 120) } : {}),
  });
}

function isCommitmentStatus(value: unknown): value is ProspectiveMemory['status'] {
  return value === 'pending' || value === 'completed' || value === 'dismissed';
}

function cleanControl(control: MemoryControl): MemoryControl {
  return Object.freeze({
    memoryId: cleanText(control.memoryId, 120),
    kind: control.kind,
    status: control.status,
    pinned: control.pinned,
    updatedAt: control.updatedAt,
    changeReason: cleanText(control.changeReason, 240),
    ...(control.overrideText ? { overrideText: cleanText(control.overrideText, 320) } : {}),
    ...(control.sourceEvidence ? { sourceEvidence: cleanText(control.sourceEvidence, 8_000) } : {}),
    ...(control.contextInvalidatedAt && Number.isFinite(Date.parse(control.contextInvalidatedAt)) ? { contextInvalidatedAt: control.contextInvalidatedAt } : {}),
    ...(control.withheldText ? { withheldText: cleanText(control.withheldText, 320) } : {}),
    ...(control.causedBy ? { causedBy: cleanText(control.causedBy, 120) } : {}),
    ...(isCommitmentStatus(control.commitmentStatusBefore) ? { commitmentStatusBefore: control.commitmentStatusBefore } : {}),
  });
}

function cleanProspectiveMemory(memory: ProspectiveMemory): ProspectiveMemory {
  return Object.freeze({
    id: cleanText(memory.id, 120),
    summary: cleanText(memory.summary, 320),
    status: memory.status,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    ...(memory.dueHint ? { dueHint: cleanText(memory.dueHint, 80) } : {}),
    ...(memory.dueAt && Number.isFinite(Date.parse(memory.dueAt)) ? { dueAt: memory.dueAt } : {}),
    ...(memory.dueDate ? { dueDate: cleanText(memory.dueDate, 10) } : {}),
    ...(memory.timeZone ? { timeZone: cleanText(memory.timeZone, 64) } : {}),
    ...(memory.sourceExperienceId ? { sourceExperienceId: cleanText(memory.sourceExperienceId, 120) } : {}),
    ...(memory.evidence ? { evidence: cleanText(memory.evidence, 320) } : {}),
    ...(memory.remindAfter && Number.isFinite(Date.parse(memory.remindAfter)) ? { remindAfter: memory.remindAfter } : {}),
  });
}

function sameEmotion(left: ShannonEmotion, right: ShannonEmotion): boolean {
  return left.valence === right.valence
    && left.arousal === right.arousal
    && left.openness === right.openness;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMemories(left: readonly ActiveMemory[], right: readonly ActiveMemory[]): boolean {
  return left.length === right.length && left.every((memory, index) => {
    const other = right[index];
    return other !== undefined
      && memory.id === other.id
      && memory.summary === other.summary
      && memory.relevance === other.relevance
      && memory.observedAt === other.observedAt;
  });
}

function normalizeMemories(memories: readonly ActiveMemory[]): readonly ActiveMemory[] {
  const unique = new Map<string, ActiveMemory>();
  for (const candidate of memories) {
    const memory = cleanMemory(candidate);
    if (!memory.id || !memory.summary) continue;
    const previous = unique.get(memory.id);
    if (!previous || memory.relevance > previous.relevance) unique.set(memory.id, memory);
  }
  return [...unique.values()]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_ACTIVE_MEMORIES);
}

export function createInitialCompanionState(scopeKey: string, nowIso: string): CompanionStateSnapshot {
  if (!scopeKey.trim()) throw new Error('scopeKey is required');
  return freezeSnapshot({
    scopeKey,
    version: 0,
    updatedAt: nowIso,
    temperament: { ...INITIAL_SHANNON_TEMPERAMENT },
    emotion: { ...INITIAL_SHANNON_EMOTION },
    expressiveEmotion: { ...INITIAL_SHANNON_EXPRESSIVE_EMOTION, startedAt: nowIso },
    interests: [],
    userFacts: [],
    activeMemories: [],
    relationships: [],
    prospectiveMemories: [],
    memoryControls: [],
  });
}

export function reduceCompanionState(
  current: CompanionStateSnapshot,
  event: CompanionStateEvent,
  nowIso: string,
): CompanionStateSnapshot {
  let next: CompanionStateSnapshot;
  switch (event.type) {
    case 'memory-transaction': {
      if (!event.events.length) return current;
      if (event.events.some(item => item.type === 'memory-transaction')) throw new Error('Nested memory transaction');
      next = event.events.reduce((state, item) => reduceCompanionState(state, item, nowIso), current);
      if (next === current) return current;
      break;
    }
    case 'emotion-adjusted': {
      const emotion = { ...current.emotion };
      if (event.delta.valence !== undefined) emotion.valence = clamp(emotion.valence + event.delta.valence, -1, 1);
      if (event.delta.arousal !== undefined) emotion.arousal = clamp(emotion.arousal + event.delta.arousal, 0, 1);
      if (event.delta.openness !== undefined) emotion.openness = clamp(emotion.openness + event.delta.openness, 0, 1);
      if (sameEmotion(emotion, current.emotion)) return current;
      next = { ...current, emotion };
      break;
    }
    case 'expressive-emotion-updated': {
      const expressiveEmotion = normalizeShannonExpressiveEmotion(event.emotion);
      if (current.expressiveEmotion && sameShannonExpressiveEmotion(expressiveEmotion, current.expressiveEmotion)) return current;
      next = { ...current, expressiveEmotion };
      break;
    }
    case 'interest-observed': {
      const interest = cleanText(event.interest, 120);
      if (!interest) return current;
      const interests = [interest, ...current.interests.filter(item => item !== interest)].slice(0, MAX_INTERESTS);
      if (sameStrings(interests, current.interests)) return current;
      next = { ...current, interests };
      break;
    }
    case 'user-fact-upserted': {
      const fact = cleanFact(event.fact);
      if (!fact.id || !fact.statement) return current;
      const previous = current.userFacts.find(item => item.id === fact.id);
      if (previous
        && previous.statement === fact.statement
        && previous.confidence === fact.confidence
        && previous.observedAt === fact.observedAt
        && previous.evidence === fact.evidence
        && previous.sourceExperienceId === fact.sourceExperienceId) return current;
      const userFacts = [fact, ...current.userFacts.filter(item => item.id !== fact.id)].slice(0, MAX_USER_FACTS);
      next = { ...current, userFacts };
      break;
    }
    case 'relationship-upserted': {
      const relationship = cleanRelationship(event.relationship);
      if (!relationship.id || !relationship.statement) return current;
      const previous = current.relationships.find(item => item.id === relationship.id);
      if (previous
        && previous.statement === relationship.statement
        && previous.confidence === relationship.confidence
        && previous.observedAt === relationship.observedAt
        && previous.evidence === relationship.evidence
        && previous.sourceExperienceId === relationship.sourceExperienceId) return current;
      const relationships = [relationship, ...current.relationships.filter(item => item.id !== relationship.id)]
        .slice(0, MAX_RELATIONSHIPS);
      next = { ...current, relationships };
      break;
    }
    case 'prospective-memory-upserted': {
      const memory = cleanProspectiveMemory(event.memory);
      if (!memory.id || !memory.summary) return current;
      const previous = current.prospectiveMemories.find(item => item.id === memory.id);
      // A background-job retry must not resurrect a completed/cancelled promise
      // or overwrite a later explicit correction.
      if (previous && !event.replace) return current;
      if (previous
        && previous.summary === memory.summary
        && previous.status === memory.status
        && previous.createdAt === memory.createdAt
        && previous.updatedAt === memory.updatedAt
        && previous.dueHint === memory.dueHint
        && previous.evidence === memory.evidence) return current;
      const prospectiveMemories = [memory, ...current.prospectiveMemories.filter(item => item.id !== memory.id)]
        .slice(0, MAX_PROSPECTIVE_MEMORIES);
      next = { ...current, prospectiveMemories };
      break;
    }
    case 'prospective-memory-status-changed': {
      const index = current.prospectiveMemories.findIndex(item => item.id === event.memoryId);
      if (index < 0 || current.prospectiveMemories[index]?.status === event.status) return current;
      const prospectiveMemories = current.prospectiveMemories.map((memory, memoryIndex) => memoryIndex === index
        ? cleanProspectiveMemory({ ...memory, status: event.status, updatedAt: nowIso })
        : memory);
      next = { ...current, prospectiveMemories };
      break;
    }
    case 'memory-control-upserted': {
      const control = cleanControl(event.control);
      if (!control.memoryId || !control.changeReason) return current;
      const previous = current.memoryControls.find(item => item.memoryId === control.memoryId);
      if (previous
        && previous.kind === control.kind
        && previous.status === control.status
        && previous.pinned === control.pinned
        && previous.updatedAt === control.updatedAt
        && previous.changeReason === control.changeReason
        && previous.overrideText === control.overrideText
        && previous.sourceEvidence === control.sourceEvidence
        && previous.contextInvalidatedAt === control.contextInvalidatedAt
        && previous.withheldText === control.withheldText
        && previous.causedBy === control.causedBy
        && previous.commitmentStatusBefore === control.commitmentStatusBefore) return current;
      const memoryControls = [control, ...current.memoryControls.filter(item => item.memoryId !== control.memoryId)]
        .slice(0, MAX_MEMORY_CONTROLS);
      next = { ...current, memoryControls };
      break;
    }
    case 'memory-activated': {
      const memory = cleanMemory(event.memory);
      if (!memory.id || !memory.summary) return current;
      const activeMemories = normalizeMemories([memory, ...current.activeMemories.filter(item => item.id !== memory.id)]);
      if (sameMemories(activeMemories, current.activeMemories)) return current;
      next = { ...current, activeMemories };
      break;
    }
    case 'active-memories-replaced': {
      const activeMemories = normalizeMemories(event.memories);
      if (sameMemories(activeMemories, current.activeMemories)) return current;
      next = { ...current, activeMemories };
      break;
    }
    case 'memory-deactivated': {
      const activeMemories = current.activeMemories.filter(item => item.id !== event.memoryId);
      if (activeMemories.length === current.activeMemories.length) return current;
      next = { ...current, activeMemories };
      break;
    }
  }
  return freezeSnapshot({ ...next, version: current.version + 1, updatedAt: nowIso });
}

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
      ...(restoredText(value.withheldText, 320) ? { withheldText: restoredText(value.withheldText, 320) } : {}),
      ...(restoredText(value.causedBy, 120) ? { causedBy: restoredText(value.causedBy, 120) } : {}),
      ...(isCommitmentStatus(value.commitmentStatusBefore) ? { commitmentStatusBefore: value.commitmentStatusBefore } : {}),
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
  });
}

export function freezeSnapshot(snapshot: CompanionStateSnapshot): CompanionStateSnapshot {
  const temperament = Object.freeze({ ...snapshot.temperament });
  const emotion = Object.freeze({ ...snapshot.emotion });
  const expressiveEmotion = snapshot.expressiveEmotion
    ? normalizeShannonExpressiveEmotion(snapshot.expressiveEmotion)
    : undefined;
  const interests = Object.freeze([...snapshot.interests]);
  const userFacts = Object.freeze(snapshot.userFacts.map(item => Object.freeze({ ...item })));
  const activeMemories = Object.freeze(snapshot.activeMemories.map(item => Object.freeze({ ...item })));
  const relationships = Object.freeze(snapshot.relationships.map(item => Object.freeze({ ...item })));
  const prospectiveMemories = Object.freeze(snapshot.prospectiveMemories.map(item => Object.freeze({ ...item })));
  const memoryControls = Object.freeze(snapshot.memoryControls.map(item => Object.freeze({ ...item })));
  return Object.freeze({
    ...snapshot, temperament, emotion, ...(expressiveEmotion ? { expressiveEmotion } : {}),
    interests, userFacts, activeMemories, relationships, prospectiveMemories, memoryControls,
  });
}
