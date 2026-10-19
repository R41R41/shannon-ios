import type { TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { TaskBodyRecoveryStore } from '../mind/action/taskRuntime/store/taskBodyRecoveryStore.js';
import type { LostFcaStep } from '../mind/action/threads/store/actionLeaseReader.js';
import type { BodyOperationState } from '../surfaces/minecraft/store/minecraftOperationReconcile.js';
import { BODY_RECOVERY_NOTICE } from './fcaBodyRecoveryPolicy.js';

/** What the model's notice about a lost step is made of (`fcaBodyRecovery.ts`; split out of it for size only). */
export interface NoticeParts { runtime: TaskRuntime; checkpoints: TaskBodyRecoveryStore; scopeKey: string; instant(): number }

/** The names of what the lost step sent the body, with how each stood: closed values, never arguments. */
export function lostOperations(operations: readonly BodyOperationState[]) {
  return operations.filter(operation => operation.kind === 'skill' || operation.kind === 'reflex').slice(0, 8)
    .map(operation => ({ tool: operation.skill ? `mc.${operation.skill}` : 'minecraft.reflex',
      outcome: operation.closedByApi ? 'no_receipt' : operation.outcome ?? 'no_receipt' }));
}

/**
 * The model's notice about a lost step, stored in the task's inbox and verified there (`recovery:<actionId>`): sending is idempotent,
 * so a later pass finds it. False: it is not in the inbox, and the caller does not go on without it.
 */
export function storeNotice(parts: NoticeParts, taskId: string, step: Pick<LostFcaStep, 'actionId' | 'startedAt' | 'lostAt'>,
  operations: readonly BodyOperationState[]): boolean {
  const { runtime, checkpoints, scopeKey } = parts;
  const id = `recovery:${step.actionId}`;
  if (checkpoints.messageStored(scopeKey, taskId, id)) return true;
  const lostAt = step.lostAt === null ? Number.NaN : Date.parse(step.lostAt);
  const effects = checkpoints.effectsSince(scopeKey, taskId, step.startedAt);
  const text = JSON.stringify({ kind: 'body.recovery', reason: 'step_interrupted',
    ...(Number.isFinite(lostAt) ? { gapSeconds: Math.max(0, Math.round((parts.instant() - lostAt) / 1000)) } : {}),
    lostOperations: lostOperations(operations), existingChildren: effects.children, sentNotes: effects.notes, instruction: BODY_RECOVERY_NOTICE });
  try {
    runtime.send(scopeKey, taskId, taskId, text, id);
  } catch { /* judged below by what the inbox holds, not by what this call said */ }
  try {
    return checkpoints.messageStored(scopeKey, taskId, id);
  } catch {
    return false;
  }
}
