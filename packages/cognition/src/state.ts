import type {
  ActiveMemory,
  CompanionStateEvent,
  CompanionStateSnapshot,
  ShannonEmotion,
  ShannonExpressiveEmotion,
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
import {
  easeLingering, easeShannonFeeling, noteShannonFeeling, presentShannonFeeling, sameLingering, settleEmotionTime,
} from './emotionContinuity.js';
import { continuedShannonEmotion, holdsShannonFeeling } from './emotionState.js';
import { SHANNON_EMOTION_TIME, type ShannonEmotionTiming } from './emotionTime.js';
import { calibrateTemperament, mergeSharedDays, sameTemperament } from './temperament.js';
import { feelTouch, isTouchFeeling } from './touchEmotion.js';
import { normalizeDisclosure, sameDisclosure, widenAudience } from './disclosure.js';
import type { MemoryDisclosure } from './types.js';

function cleanDisclosure(value: MemoryDisclosure | undefined): { disclosure?: MemoryDisclosure } {
  const disclosure = normalizeDisclosure(value);
  return disclosure ? { disclosure } : {};
}

/**
 * A re-observed item keeps its label when the new observation carries none, and its
 * audience grows to everyone who has now heard it.
 */
function mergedDisclosure(previous: MemoryDisclosure | undefined, next: MemoryDisclosure | undefined): MemoryDisclosure | undefined {
  if (!next) return previous;
  if (!previous) return next;
  // Once protected, restating it in plainer words does not unprotect it; only the owner can.
  const kept = previous.sensitivity === 'sensitive' && next.sensitivity !== 'sensitive' ? previous : next;
  return Object.freeze({ ...kept, audience: widenAudience(previous.audience, next.audience) });
}

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
    ...cleanDisclosure(fact.disclosure),
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
    ...cleanDisclosure(relationship.disclosure),
  });
}

export function isCommitmentStatus(value: unknown): value is ProspectiveMemory['status'] {
  return value === 'pending' || value === 'completed' || value === 'dismissed';
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
    ...(control.withheldText ? { withheldText: cleanText(control.withheldText, 320) } : {}),
    ...(control.causedBy ? { causedBy: cleanText(control.causedBy, 120) } : {}),
    ...(isCommitmentStatus(control.commitmentStatusBefore) ? { commitmentStatusBefore: control.commitmentStatusBefore } : {}),
    ...(control.sensitivity === 'sensitive' || control.sensitivity === 'ordinary' ? { sensitivity: control.sensitivity } : {}),
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
    ...cleanDisclosure(memory.disclosure),
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

/**
 * The state brought to `nowIso` on her awake clock before an emotion event is applied: the clock
 * advanced, the mood returned toward its baseline, what has settled underneath dropped. Under
 * `clock: 'wall'` nothing is aged here and the state is returned as it is.
 */
function awakeState(current: CompanionStateSnapshot, nowIso: string, timing: ShannonEmotionTiming): { state: CompanionStateSnapshot; awakeMs: number } {
  if (timing.clock !== 'awake') return { state: current, awakeMs: 0 };
  const settled = settleEmotionTime(current, nowIso, timing);
  if (!settled.changed) return { state: current, awakeMs: settled.awakeMs };
  return {
    state: { ...current, emotion: settled.emotion, lingering: settled.lingering, ...(settled.emotionClock ? { emotionClock: settled.emotionClock } : {}) },
    awakeMs: settled.awakeMs,
  };
}

/**
 * Stores a conversational feeling on the awake clock. Every writer ends here, so the rule that a
 * feeling is not replaced by a weaker stimulus (`holdsShannonFeeling`) holds for all of them, also
 * for one that resolved its feeling from an older snapshot; what was committed is noted underneath.
 */
function committedFeeling(
  state: CompanionStateSnapshot,
  incoming: ShannonExpressiveEmotion,
  awakeMs: number,
  nowIso: string,
  timing: ShannonEmotionTiming,
): Pick<CompanionStateSnapshot, 'expressiveEmotion' | 'lingering'> {
  const present = presentShannonFeeling(state, nowIso, timing);
  const touch = isTouchFeeling(incoming) ? { presentFromTouch: isTouchFeeling(present) } : undefined;
  const kept = incoming.primary !== present.primary && holdsShannonFeeling(present, incoming, touch)
    ? continuedShannonEmotion(present, incoming.primary, nowIso)
    : incoming;
  const expressiveEmotion = normalizeShannonExpressiveEmotion({ ...kept, awakeAt: awakeMs });
  return { expressiveEmotion, lingering: noteShannonFeeling(state.lingering ?? [], expressiveEmotion, awakeMs, nowIso, timing) };
}

export function reduceCompanionState(
  current: CompanionStateSnapshot,
  event: CompanionStateEvent,
  nowIso: string,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): CompanionStateSnapshot {
  let next: CompanionStateSnapshot;
  switch (event.type) {
    case 'memory-transaction': {
      if (!event.events.length) return current;
      if (event.events.some(item => item.type === 'memory-transaction')) throw new Error('Nested memory transaction');
      next = event.events.reduce((state, item) => reduceCompanionState(state, item, nowIso, timing), current);
      if (next === current) return current;
      break;
    }
    case 'awake-observed': {
      // Her clock moves and nothing else happened: no new version, so prompts and indexes keyed by it stay as they are.
      const { state } = awakeState(current, nowIso, timing);
      return state === current ? current : freezeSnapshot(state);
    }
    case 'emotion-adjusted': {
      const { state } = awakeState(current, nowIso, timing);
      const emotion = { ...state.emotion };
      if (event.delta.valence !== undefined) emotion.valence = clamp(emotion.valence + event.delta.valence, -1, 1);
      if (event.delta.arousal !== undefined) emotion.arousal = clamp(emotion.arousal + event.delta.arousal, 0, 1);
      if (event.delta.openness !== undefined) emotion.openness = clamp(emotion.openness + event.delta.openness, 0, 1);
      // An adjustment that moves nothing on a state whose clock has not started leaves it untouched.
      if (sameEmotion(emotion, current.emotion)) return state === current || !current.emotionClock ? current : freezeSnapshot(state);
      next = { ...state, emotion };
      break;
    }
    case 'expressive-emotion-updated': {
      if (timing.clock === 'awake') {
        const { state, awakeMs } = awakeState(current, nowIso, timing);
        const committed = committedFeeling(state, normalizeShannonExpressiveEmotion(event.emotion), awakeMs, nowIso, timing);
        if (state === current && current.expressiveEmotion && sameShannonExpressiveEmotion(committed.expressiveEmotion!, current.expressiveEmotion)
          && sameLingering(committed.lingering ?? [], current.lingering ?? [])) return current;
        next = { ...state, ...committed };
        break;
      }
      const expressiveEmotion = normalizeShannonExpressiveEmotion(event.emotion);
      if (current.expressiveEmotion && sameShannonExpressiveEmotion(expressiveEmotion, current.expressiveEmotion)) return current;
      next = { ...current, expressiveEmotion };
      break;
    }
    case 'body-touched': {
      // One table decides both parts of the one emotion state; nothing else reads a touch as feeling.
      const { state, awakeMs } = awakeState(current, nowIso, timing);
      const felt = feelTouch(state, event.touch, nowIso, timing);
      if (timing.clock === 'awake') {
        // A feeling that was held through the touch is left exactly as stored; only the mood moved.
        const feeling = felt.expressiveEmotion === state.expressiveEmotion ? {}
          : committedFeeling(state, felt.expressiveEmotion, awakeMs, nowIso, timing);
        next = { ...state, emotion: felt.emotion, ...feeling };
        break;
      }
      if (sameEmotion(felt.emotion, current.emotion) && current.expressiveEmotion
        && sameShannonExpressiveEmotion(felt.expressiveEmotion, current.expressiveEmotion)) return current;
      next = { ...current, emotion: felt.emotion, expressiveEmotion: felt.expressiveEmotion };
      break;
    }
    case 'feeling-eased': {
      // Resolution comes from what happens (here: his apology or kind word) and from awake time, never from a new conversation starting.
      if (timing.clock !== 'awake') return current;
      const { state, awakeMs } = awakeState(current, nowIso, timing);
      const lingering = easeLingering(state.lingering ?? [], event.by, awakeMs, timing);
      const eased = easeShannonFeeling(state.expressiveEmotion, event.by, awakeMs, timing);
      if (sameLingering(lingering, state.lingering ?? []) && eased === state.expressiveEmotion) return state === current ? current : freezeSnapshot(state);
      next = { ...state, lingering, ...(eased ? { expressiveEmotion: eased } : {}) };
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
      const candidate = cleanFact(event.fact);
      if (!candidate.id || !candidate.statement) return current;
      const previous = current.userFacts.find(item => item.id === candidate.id);
      const fact = cleanFact({ ...candidate, disclosure: mergedDisclosure(previous?.disclosure, candidate.disclosure) });
      if (previous
        && previous.statement === fact.statement
        && previous.confidence === fact.confidence
        && previous.observedAt === fact.observedAt
        && previous.evidence === fact.evidence
        && previous.sourceExperienceId === fact.sourceExperienceId
        && sameDisclosure(previous.disclosure, fact.disclosure)) return current;
      const userFacts = [fact, ...current.userFacts.filter(item => item.id !== fact.id)].slice(0, MAX_USER_FACTS);
      next = { ...current, userFacts };
      break;
    }
    case 'relationship-upserted': {
      const candidate = cleanRelationship(event.relationship);
      if (!candidate.id || !candidate.statement) return current;
      const previous = current.relationships.find(item => item.id === candidate.id);
      const relationship = cleanRelationship({ ...candidate, disclosure: mergedDisclosure(previous?.disclosure, candidate.disclosure) });
      if (previous
        && previous.statement === relationship.statement
        && previous.confidence === relationship.confidence
        && previous.observedAt === relationship.observedAt
        && previous.evidence === relationship.evidence
        && previous.sourceExperienceId === relationship.sourceExperienceId
        && sameDisclosure(previous.disclosure, relationship.disclosure)) return current;
      const relationships = [relationship, ...current.relationships.filter(item => item.id !== relationship.id)]
        .slice(0, MAX_RELATIONSHIPS);
      next = { ...current, relationships };
      break;
    }
    case 'prospective-memory-upserted': {
      const candidate = cleanProspectiveMemory(event.memory);
      if (!candidate.id || !candidate.summary) return current;
      const previous = current.prospectiveMemories.find(item => item.id === candidate.id);
      // A correction or snooze rewrites the promise; who heard it and its label stay.
      const memory = candidate.disclosure || !previous?.disclosure ? candidate : cleanProspectiveMemory({ ...candidate, disclosure: previous.disclosure });
      // A background-job retry must not resurrect a completed/cancelled promise
      // or overwrite a later explicit correction.
      if (previous && !event.replace) return current;
      if (previous
        && previous.summary === memory.summary
        && previous.status === memory.status
        && previous.createdAt === memory.createdAt
        && previous.updatedAt === memory.updatedAt
        && previous.dueHint === memory.dueHint
        && previous.evidence === memory.evidence
        && sameDisclosure(previous.disclosure, memory.disclosure)) return current;
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
        && previous.commitmentStatusBefore === control.commitmentStatusBefore
        && previous.sensitivity === control.sensitivity) return current;
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
    ...(snapshot.emotionClock ? { emotionClock: Object.freeze({ ...snapshot.emotionClock }) } : {}),
    ...(snapshot.lingering ? { lingering: Object.freeze(snapshot.lingering.map(item => Object.freeze({ ...item }))) } : {}),
    interests, userFacts, activeMemories, relationships, prospectiveMemories, memoryControls,
  });
}
