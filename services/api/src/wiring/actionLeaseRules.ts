import { LEASE_RULES, leaseAttemptKnown, leaseLive, unsentLeaseExpiry, type ActionLease } from '@shannon/mind';
import { actionResource } from '../contracts/actionThreadContract.js';
import type { MinecraftLifecycleAuthority } from '../contracts/minecraftLifecycleContract.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { fcaSourceOf, type ActionLeaseRecord, type CheckpointedLease } from '../mind/action/threads/store/actionLeaseReader.js';

// The lease questions the wiring asks of an action it read through ActionLeaseReader (Syzygy ADR-0009 stage 1, S1).
// Each is exactly the predicate its wiring computed on the raw row before S1; the judgement of the lease itself is the one
// pure `leaseLive` of @shannon/mind under the rule that reader used.

const LIVE_OR_UNKNOWN = ['running', 'waiting', 'stopping', 'unknown'];

/** An FCA task step's own lease: an agentTask of the scope, from the task's source, admitted with the task's resource. */
export function fcaTaskLeaseValid(action: ActionLeaseRecord | null, scope: string, taskId: string, lease: ActionLease, at: string): boolean {
  if (!action || action.scopeKey !== scope || action.kind !== 'agentTask') return false;
  if (!leaseLive(action, lease, at, LEASE_RULES.step)) return false;
  if (!fcaSourceOf(action.sourceId, taskId)) return false;
  return action.baseResources.includes(actionResource(scope, `fca:${taskId}`));
}

/** A conversation turn's own lease: the owner's respond action of the scope. */
export function conversationLeaseValid(action: ActionLeaseRecord | null, scope: string, lease: ActionLease, at: string): boolean {
  if (!action || action.scopeKey !== scope) return false;
  if (action.origin !== 'owner_request' || action.kind !== 'respond') return false;
  return leaseLive(action, lease, at, LEASE_RULES.step);
}

/** A claim of the task's revision whose reply was lost and which the sweep expired unsent: another admission is safe. */
export function lostAdmissionExpired(action: ActionLeaseRecord | null, origin: string, scope: string, taskId: string): boolean {
  if (!action || action.origin !== origin) return false;
  if (!['owner_request', 'maintenance'].includes(action.origin)) return false;
  if (!unsentLeaseExpiry(action) || action.parentId !== null) return false;
  return JSON.stringify(action.baseResources) === JSON.stringify([actionResource(scope, `fca:${taskId}`)]);
}

function checkpointLeaseMatches(json: unknown, lease: ActionLease): boolean {
  try {
    const saved = JSON.parse(String(json));
    return saved.id === lease.id && saved.holder === lease.holder && saved.generation === lease.generation;
  } catch {
    return false;
  }
}

/** The exact native step of the checkpoint and its original owner-request lease (read in one row). */
export function fcaStepLeaseLive(read: CheckpointedLease | null, step: Pick<TaskStep, 'id' | 'scopeKey' | 'taskId' | 'lease'>, at: string): boolean {
  if (!read || read.stepId !== step.id || read.stopRequested !== 0) return false;
  const { action } = read;
  if (action.scopeKey !== step.scopeKey || action.kind !== 'agentTask' || action.origin !== 'owner_request') return false;
  if (!leaseLive(action, step.lease, at, LEASE_RULES.step)) return false;
  if (!fcaSourceOf(action.sourceId, step.taskId)) return false;
  return checkpointLeaseMatches(read.leaseJson, step.lease);
}

/** The owner's FCA step of the task, under this attempt or the one just before it. */
export function bodyLeaseAttempt(action: ActionLeaseRecord | null, scope: string, lease: ActionLease, taskId: string): ActionLeaseRecord | null {
  if (!action || action.scopeKey !== scope || action.kind !== 'agentTask' || action.origin !== 'owner_request') return null;
  if (!fcaSourceOf(action.sourceId, taskId)) return null;
  return leaseAttemptKnown(action, lease) ? action : null;
}

/** The Minecraft body is (or may still be) held by that attempt: live or unknown, with the body among its resources. */
export function bodyLeaseKnown(action: ActionLeaseRecord | null, body: string): boolean {
  return Boolean(action && LIVE_OR_UNKNOWN.includes(action.state) && action.resources.includes(body));
}

/** The Minecraft body is held by this running attempt now. */
export function bodyLeaseValid(action: ActionLeaseRecord | null, lease: ActionLease, body: string, at: string): boolean {
  return Boolean(action && leaseLive(action, lease, at, LEASE_RULES.step) && action.resources.includes(body));
}

/** The lifecycle command's authority holds its original running lease, of the owner's scope, before the deadline. */
export function lifecycleLeaseHeld(action: ActionLeaseRecord | null, authority: MinecraftLifecycleAuthority, ownerScope: string,
  at: string): boolean {
  if (!action || authority.executionId !== authority.lease.id) return false;
  if (action.scopeKey !== authority.scopeKey || authority.scopeKey !== ownerScope) return false;
  if (action.origin !== authority.origin) return false;
  return leaseLive(action, authority.lease, at, LEASE_RULES.step);
}
