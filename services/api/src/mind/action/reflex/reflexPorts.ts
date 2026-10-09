import type { ActionLease } from '@shannon/mind';
import type {
  BodyActionCandidate, BodyActionReceipt, BodyCandidateDraft, BodyObservation, BodyOperation,
  BodyStopAcknowledgement, BodyStopRequest, BodyTaskContext, ReflexEndReason, ReflexSessionReceipt,
} from '../../../contracts/bodyControlContract.js';
export type * from '../../../contracts/bodyControlContract.js';

export interface ReflexChoiceInput {
  context: BodyTaskContext; observation: BodyObservation; previousObservation?: BodyObservation;
  candidates: readonly BodyActionCandidate[]; recent: readonly BodyActionReceipt[];
}
export interface ReflexChoice { sessionId: string; generation: number; candidateId: string }
export interface ReflexSelector { choose(input: ReflexChoiceInput, signal: AbortSignal): Promise<ReflexChoice | null> }
export interface ReflexEntryInput {
  context: BodyTaskContext; observation: BodyObservation; trigger: 'observation' | 'touch' | 'explicit';
  recent: readonly BodyActionReceipt[];
}
export interface ReflexEntryDecision {
  sessionId: string; generation: number; decision: 'enter' | 'continue' | 'return';
  reason: 'danger' | 'stuck' | 'visual' | 'touch' | 'none';
}
export interface ReflexEntrySelector { evaluate(input: ReflexEntryInput, signal: AbortSignal): Promise<ReflexEntryDecision | null> }
export interface ReflexBodyAdapter {
  observe(context: BodyTaskContext, signal: AbortSignal): Promise<BodyObservation | null>;
  candidates(context: BodyTaskContext, observation: BodyObservation): readonly BodyCandidateDraft[];
  /** Additional body-specific conditions, rechecked after selection against a new observation. */
  validate(context: BodyTaskContext, candidate: BodyActionCandidate, observation: BodyObservation): boolean;
  /** Checks the original ID and preconditions again at actuator dispatch; unknown IDs are never automatically resent. */
  execute(operation: BodyOperation, lease: ActionLease, signal: AbortSignal): Promise<BodyActionReceipt>;
  /** Must release held inputs even when the execution signal has already been aborted. */
  releaseInputs(request: BodyStopRequest, lease: ActionLease): Promise<BodyStopAcknowledgement>;
  /** Completion needs affirmative evidence; losing a target is a separate return reason. */
  termination?(context: BodyTaskContext, observation: BodyObservation, recent: readonly BodyActionReceipt[]):
    { reason: 'completed' | 'hazard_cleared' | 'target_lost' | 'no_progress'; evidenceIds: readonly string[] } | null;
}
/** Adapter over the existing action authority. No new lease or lock table is owned by the controller. */
export interface ReflexHandoffPort {
  inspect(context: BodyTaskContext): Promise<'new' | 'duplicate' | 'unknown'>;
  /** Obtain the existing resource permit before requesting any physical stop. Local cancellation is safe here. */
  prepare?(context: BodyTaskContext, signal: AbortSignal): Promise<boolean>;
  stopNormal(request: BodyStopRequest, signal: AbortSignal): Promise<BodyStopAcknowledgement>;
  acquire(context: BodyTaskContext, stopped: BodyStopAcknowledgement, signal: AbortSignal): Promise<ActionLease | null>;
  /** Stop was acknowledged but acquisition was interrupted. Release with the original authority and persist the result. */
  returnStopped(request: BodyStopRequest, receipt: ReflexSessionReceipt): Promise<ReflexSessionReceipt>;
  valid(context: BodyTaskContext, lease: ActionLease, signal?: AbortSignal): boolean | Promise<boolean>;
  /** Unknown or unacknowledged input release keeps the original authority held for reconciliation. */
  finish(lease: ActionLease, receipt: ReflexSessionReceipt): Promise<void>;
}
export interface ReflexLimits {
  maxDurationMs: number; maxDecisions: number; maxActions: number; maxActionMs: number;
  maxStateAgeMs: number; maxImageAgeMs: number;
}
export interface ReflexSessionRequest { context: BodyTaskContext; limits: ReflexLimits; requiresImage?: boolean }
export interface ReflexEvent {
  id: string; context: BodyTaskContext; kind: 'entered' | 'action' | 'returned'; observedAt: string;
  operationId?: string; evidenceId?: string; outcome?: BodyActionReceipt['outcome']; reason?: ReflexEndReason;
}
export interface ReflexPorts {
  body: ReflexBodyAdapter; handoff: ReflexHandoffPort; selector: ReflexSelector;
  /** Exact task revision/session generation and owner/source/stop checks, including during an ordinary model wait. */
  current(context: BodyTaskContext): boolean | Promise<boolean>;
  /** Durable dedup by event.id; the same ID feeds Task Hub, evidence, affect and Observer. No frame pixels. */
  event(event: ReflexEvent): void | Promise<void>;
  now(): number;
}
export { bindReflexCandidates, freshBodyObservation, reflexCandidateCurrent, reflexSnapshot } from './reflexCandidates.js';
export { acquireReflexControl, actualBodyStop, returnReflexControl, ReflexHandoffNotSent } from './reflexHandoff.js';
export { createReflexController, evaluateReflexEntry, runReflexSession } from './reflexController.js';
