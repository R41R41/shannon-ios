import { appraiseChoice, type CompanionStateSnapshot, type ShannonEmotion } from '@shannon/cognition';
import type { TaskSource } from '../action/taskRuntime/taskRuntimePorts.js';

export interface FcaAffectEvidence {
  eventId: string; taskId: string; revision: number; observedAt: string;
  /** The task that authored this meaning may have read more sources than the original event. */
  appraisalTaskId?: string;
  value: number; expectedValue: number | null; unexpected: number | null;
  cause: string; target: string; sources: readonly TaskSource[];
}
export interface FcaAffectReceipt extends FcaAffectEvidence { stateRevision: number }
export interface FcaAffectSnapshot {
  version: 'fca_affect.v1'; revision: number; updatedAt: string;
  emotion: Readonly<ShannonEmotion>;
  feeling: { primary: string; intensity: number; secondary: readonly string[] } | null;
  causes: readonly Pick<FcaAffectReceipt, 'eventId' | 'revision' | 'cause' | 'target'>[];
}
export interface FcaAffectWriter {
  snapshot(scopeKey: string): CompanionStateSnapshot;
  applyFcaAffectEvidence(scopeKey: string, evidence: FcaAffectEvidence, visible: () => boolean): 'applied' | 'revised' | 'duplicate' | 'stale' | 'withheld';
  fcaAffectReceipts(scopeKey: string, eventIds?: readonly string[]): readonly FcaAffectReceipt[];
}
export function validFcaAffectEvidence(evidence: FcaAffectEvidence): boolean {
  return !!evidence && typeof evidence.eventId === 'string' && evidence.eventId.length > 0 && evidence.eventId.length <= 400
    && typeof evidence.taskId === 'string' && evidence.taskId.length > 0 && evidence.taskId.length <= 200
    && (evidence.appraisalTaskId === undefined || typeof evidence.appraisalTaskId === 'string' && evidence.appraisalTaskId.length > 0 && evidence.appraisalTaskId.length <= 200)
    && Number.isSafeInteger(evidence.revision) && evidence.revision > 0 && Number.isFinite(Date.parse(evidence.observedAt))
    && Number.isFinite(evidence.value) && Math.abs(evidence.value) <= 1
    && (evidence.expectedValue === null || Number.isFinite(evidence.expectedValue) && Math.abs(evidence.expectedValue) <= 1)
    && (evidence.unexpected === null || Number.isFinite(evidence.unexpected) && evidence.unexpected >= 0 && evidence.unexpected <= 1)
    && typeof evidence.cause === 'string' && evidence.cause.trim().length > 0 && evidence.cause.length <= 240
    && typeof evidence.target === 'string' && evidence.target.length <= 120 && Array.isArray(evidence.sources);
}
/** Revisions change this event's meaning, instead of applying its whole appraisal for a second time. */
export function fcaAppraisalDelta(emotion: ShannonEmotion, next: FcaAffectEvidence, previous: FcaAffectEvidence | null): Partial<ShannonEmotion> {
  const appraised = (value: FcaAffectEvidence) => appraiseChoice(emotion, {
    error: value.value - (value.expectedValue ?? 0), expectation: value.expectedValue ?? 0, unexpected: value.unexpected ?? 0,
  });
  const after = appraised(next), before = previous ? appraised(previous) : emotion;
  return { valence: after.valence - before.valence, arousal: after.arousal - before.arousal };
}
/** One API-owned coordinator; commits are delegated to the existing companion writer and its transaction. */
export class AffectCoordinator {
  constructor(private readonly writer: FcaAffectWriter,
    private readonly visible: (scopeKey: string, taskId: string, sources: readonly TaskSource[]) => boolean) {}
  snapshot(scopeKey: string): FcaAffectSnapshot {
    const state = this.writer.snapshot(scopeKey), feeling = state.expressiveEmotion;
    return { version: 'fca_affect.v1', revision: state.version, updatedAt: state.updatedAt, emotion: { ...state.emotion },
      feeling: feeling ? { primary: feeling.primary, intensity: feeling.intensity, secondary: [...feeling.secondary] } : null,
      causes: this.writer.fcaAffectReceipts(scopeKey).filter(item => item.stateRevision <= state.version && this.evidenceVisible(scopeKey, item))
        .slice(0, 8).map(({ eventId, revision, cause, target }) => ({ eventId, revision, cause, target })) };
  }
  submit(scopeKey: string, evidence: FcaAffectEvidence) {
    if (!validFcaAffectEvidence(evidence)) throw new Error('FCA_AFFECT_EVIDENCE_INVALID');
    return this.writer.applyFcaAffectEvidence(scopeKey, evidence, () => this.evidenceVisible(scopeKey, evidence));
  }
  private evidenceVisible(scope: string, evidence: FcaAffectEvidence) {
    return this.visible(scope, evidence.taskId, evidence.sources)
      && (!evidence.appraisalTaskId || this.visible(scope, evidence.appraisalTaskId, evidence.sources));
  }
}
