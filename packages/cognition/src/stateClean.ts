import type { ActiveMemory, MemoryControl, MemoryDisclosure, ProspectiveMemory, RelationshipInsight, UserFact } from './types.js';
import { normalizeDisclosure } from './disclosure.js';

// Moved out of state.ts unchanged (the 500-line ceiling): the cleaning of the records the state keeps.

export function cleanDisclosure(value: MemoryDisclosure | undefined): { disclosure?: MemoryDisclosure } {
  const disclosure = normalizeDisclosure(value);
  return disclosure ? { disclosure } : {};
}

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
    ...(control.contextInvalidatedAt && Number.isFinite(Date.parse(control.contextInvalidatedAt))
      ? { contextInvalidatedAt: control.contextInvalidatedAt } : {}),
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
