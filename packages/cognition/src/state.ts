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
  sameShannonExpressiveEmotion,
} from './emotionState.js';
import { calibrateTemperament, mergeSharedDays, sameTemperament } from './temperament.js';

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

export const MAX_INTERESTS = 12;
export const MAX_USER_FACTS = 24;
export const MAX_ACTIVE_MEMORIES = 8;
export const MAX_RELATIONSHIPS = 24;
// These are authoritative records, not working-memory projections. Never evict
// unresolved commitments or explicit forget boundaries when another is added.
export const MAX_MEMORY_CONTROLS = Number.POSITIVE_INFINITY;
export const MAX_PROSPECTIVE_MEMORIES = Number.POSITIVE_INFINITY;

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function cleanText(value: string, maximumLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximumLength);
}

export function cleanFact(fact: UserFact): UserFact {
  return Object.freeze({
    id: cleanText(fact.id, 120),
    statement: cleanText(fact.statement, 320),
    confidence: clamp(fact.confidence, 0, 1),
    observedAt: fact.observedAt,
    ...(fact.evidence ? { evidence: cleanText(fact.evidence, 320) } : {}),
    ...(fact.sourceExperienceId ? { sourceExperienceId: cleanText(fact.sourceExperienceId, 120) } : {}),
  });
}

export function cleanMemory(memory: ActiveMemory): ActiveMemory {
  return Object.freeze({
    id: cleanText(memory.id, 120),
    summary: cleanText(memory.summary, 320),
    relevance: clamp(memory.relevance, 0, 1),
    observedAt: memory.observedAt,
  });
}

export function cleanRelationship(relationship: RelationshipInsight): RelationshipInsight {
  return Object.freeze({
    id: cleanText(relationship.id, 120),
    statement: cleanText(relationship.statement, 320),
    confidence: clamp(relationship.confidence, 0, 1),
    observedAt: relationship.observedAt,
    ...(relationship.evidence ? { evidence: cleanText(relationship.evidence, 320) } : {}),
    ...(relationship.sourceExperienceId ? { sourceExperienceId: cleanText(relationship.sourceExperienceId, 120) } : {}),
  });
}

export function cleanControl(control: MemoryControl): MemoryControl {
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
  });
}

export function cleanProspectiveMemory(memory: ProspectiveMemory): ProspectiveMemory {
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

export function normalizeMemories(memories: readonly ActiveMemory[]): readonly ActiveMemory[] {
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
    case 'shared-time-observed': {
      // Evidence first, then the slow traits that are a pure function of it.
      const sharedDays = mergeSharedDays(current.sharedDays ?? [], event.days, event.today);
      const temperament = calibrateTemperament({ ...current, sharedDays }, event.today);
      if (sameStrings(sharedDays, current.sharedDays ?? []) && sameTemperament(temperament, current.temperament)) return current;
      next = { ...current, sharedDays, temperament };
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
        && previous.contextInvalidatedAt === control.contextInvalidatedAt) return current;
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
    ...(snapshot.sharedDays ? { sharedDays: Object.freeze([...snapshot.sharedDays]) } : {}),
    interests, userFacts, activeMemories, relationships, prospectiveMemories, memoryControls,
  });
}
