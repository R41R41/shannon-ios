import { createHash } from 'node:crypto';
import type { BodyActionCandidate, BodyCandidateDraft, BodyObservation, BodyTaskContext, ReflexLimits } from './reflexPorts.js';

function stable(value: unknown, depth = 0): string {
  if (depth > 12) throw new Error('REFLEX_VALUE_DEPTH');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  throw new Error('REFLEX_VALUE_INVALID');
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
export function reflexSnapshot<T>(value: T): T { return frozen(JSON.parse(stable(value)) as T); }

export function validReflexLimits(limits: ReflexLimits): boolean {
  return Object.values(limits).every(value => Number.isInteger(value) && value > 0)
    && limits.maxDurationMs <= 120_000 && limits.maxDecisions <= 64 && limits.maxActions <= 64
    && limits.maxActionMs <= 10_000 && limits.maxStateAgeMs <= 30_000 && limits.maxImageAgeMs <= 30_000;
}
export function freshBodyObservation(observation: BodyObservation | null, context: BodyTaskContext,
  now: number, limits: ReflexLimits, requiresImage = false): observation is BodyObservation {
  if (!observation || observation.schemaVersion !== 1 || observation.bodyId !== context.bodyId || !observation.connected
    || !Number.isInteger(observation.sequence) || observation.sequence < 0) return false;
  const age = now - Date.parse(observation.stateAt), receivedAge = now - Date.parse(observation.receivedAt);
  if (!(age >= 0 && age <= limits.maxStateAgeMs && receivedAge >= 0 && receivedAge <= limits.maxStateAgeMs)) return false;
  if (!requiresImage) return true;
  const image = observation.image, imageAge = image ? now - Date.parse(image.capturedAt) : NaN;
  return Boolean(image?.ref && imageAge >= 0 && imageAge <= limits.maxImageAgeMs && Date.parse(image.expiresAt) > now);
}

/** Bind concrete adapter arguments to this task/session/observation. Model output is only an ID lookup. */
export function bindReflexCandidates(context: BodyTaskContext, observation: BodyObservation, drafts: readonly BodyCandidateDraft[],
  now: number, limits: ReflexLimits): readonly BodyActionCandidate[] {
  const controls: BodyCandidateDraft[] = (['observe', 'return', 'stop'] as const)
    .filter(kind => !drafts.some(candidate => candidate.kind === kind)).map(kind => ({ kind, label: kind, arguments: {}, preconditions: [],
      maxDurationMs: 0, expiresAt: new Date(now + limits.maxDurationMs).toISOString() }));
  if (drafts.length + controls.length > 64) throw new Error('REFLEX_CANDIDATE_LIMIT');
  const ids = new Set<string>();
  return Object.freeze([...drafts, ...controls].map(draft => {
    if (!['action', 'observe', 'return', 'stop'].includes(draft.kind) || !draft.label || draft.label.length > 600
      || !Number.isInteger(draft.maxDurationMs) || draft.maxDurationMs < 0 || draft.maxDurationMs > limits.maxActionMs
      || !(Date.parse(draft.expiresAt) > now) || draft.preconditions.length > 64
      || (draft.kind === 'action' && (!draft.operation || draft.operation.length > 120 || draft.maxDurationMs === 0))
      || draft.preconditions.some(condition => !condition.key || !Object.hasOwn(observation.facts, condition.key)
        || observation.facts[condition.key] !== condition.value)) throw new Error('REFLEX_CANDIDATE_INVALID');
    const bound = { ...draft, sessionId: context.sessionId, generation: context.generation,
      taskRevision: context.taskRevision, observationSequence: observation.sequence };
    const serialized = stable([context.scopeKey, context.taskId, context.bodyId, bound]);
    if (serialized.length > 32_000) throw new Error('REFLEX_CANDIDATE_SIZE');
    const id = `candidate:${createHash('sha256').update(serialized).digest('hex').slice(0, 40)}`;
    if (ids.has(id)) throw new Error('REFLEX_CANDIDATE_DUPLICATE');
    ids.add(id); return reflexSnapshot({ ...bound, id });
  }));
}
export function reflexCandidateCurrent(candidate: BodyActionCandidate, context: BodyTaskContext, observation: BodyObservation,
  now: number, limits: ReflexLimits): boolean {
  return candidate.sessionId === context.sessionId && candidate.generation === context.generation && candidate.taskRevision === context.taskRevision
    && observation.sequence >= candidate.observationSequence && Date.parse(candidate.expiresAt) > now
    && freshBodyObservation(observation, context, now, limits, candidate.requiresImage)
    && candidate.preconditions.every(condition => Object.hasOwn(observation.facts, condition.key) && observation.facts[condition.key] === condition.value);
}
