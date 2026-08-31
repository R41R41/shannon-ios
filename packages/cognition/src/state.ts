import type {
  ActiveMemory,
  CompanionStateEvent,
  CompanionStateSnapshot,
  ShannonEmotion,
  ShannonTemperament,
  MemoryControl,
  RelationshipInsight,
  UserFact,
} from './types.js';

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
const MAX_MEMORY_CONTROLS = 160;

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
  });
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
  });
}

export function createInitialCompanionState(scopeKey: string, nowIso: string): CompanionStateSnapshot {
  if (!scopeKey.trim()) throw new Error('scopeKey is required');
  return freezeSnapshot({
    scopeKey,
    version: 0,
    updatedAt: nowIso,
    temperament: { ...INITIAL_SHANNON_TEMPERAMENT },
    emotion: { ...INITIAL_SHANNON_EMOTION },
    interests: [],
    userFacts: [],
    activeMemories: [],
    relationships: [],
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
    case 'emotion-adjusted': {
      const emotion = { ...current.emotion };
      if (event.delta.valence !== undefined) emotion.valence = clamp(emotion.valence + event.delta.valence, -1, 1);
      if (event.delta.arousal !== undefined) emotion.arousal = clamp(emotion.arousal + event.delta.arousal, 0, 1);
      if (event.delta.openness !== undefined) emotion.openness = clamp(emotion.openness + event.delta.openness, 0, 1);
      next = { ...current, emotion };
      break;
    }
    case 'interest-observed': {
      const interest = cleanText(event.interest, 120);
      if (!interest) return current;
      const interests = [interest, ...current.interests.filter(item => item !== interest)].slice(0, MAX_INTERESTS);
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
        && previous.evidence === fact.evidence) return current;
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
        && previous.evidence === relationship.evidence) return current;
      const relationships = [relationship, ...current.relationships.filter(item => item.id !== relationship.id)]
        .slice(0, MAX_RELATIONSHIPS);
      next = { ...current, relationships };
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
        && previous.overrideText === control.overrideText) return current;
      const memoryControls = [control, ...current.memoryControls.filter(item => item.memoryId !== control.memoryId)]
        .slice(0, MAX_MEMORY_CONTROLS);
      next = { ...current, memoryControls };
      break;
    }
    case 'memory-activated': {
      const memory = cleanMemory(event.memory);
      if (!memory.id || !memory.summary) return current;
      const activeMemories = [memory, ...current.activeMemories.filter(item => item.id !== memory.id)]
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, MAX_ACTIVE_MEMORIES);
      next = { ...current, activeMemories };
      break;
    }
    case 'memory-deactivated':
      next = { ...current, activeMemories: current.activeMemories.filter(item => item.id !== event.memoryId) };
      break;
  }
  return freezeSnapshot({ ...next, version: current.version + 1, updatedAt: nowIso });
}

export function freezeSnapshot(snapshot: CompanionStateSnapshot): CompanionStateSnapshot {
  const temperament = Object.freeze({ ...snapshot.temperament });
  const emotion = Object.freeze({ ...snapshot.emotion });
  const interests = Object.freeze([...snapshot.interests]);
  const userFacts = Object.freeze(snapshot.userFacts.map(item => Object.freeze({ ...item })));
  const activeMemories = Object.freeze(snapshot.activeMemories.map(item => Object.freeze({ ...item })));
  const relationships = Object.freeze(snapshot.relationships.map(item => Object.freeze({ ...item })));
  const memoryControls = Object.freeze(snapshot.memoryControls.map(item => Object.freeze({ ...item })));
  return Object.freeze({ ...snapshot, temperament, emotion, interests, userFacts, activeMemories, relationships, memoryControls });
}
