import type { DatabaseSync } from 'node:sqlite';
import type { ActionLease, ActionState, ActionView } from '@shannon/mind';
import { actionResource } from '../../src/contracts/actionThreadContract.js';
import type { MinecraftLifecycleAuthority } from '../../src/contracts/minecraftLifecycleContract.js';

// The lease predicates as they were before Syzygy ADR-0009 stage 1, S1 (66a08cd3), copied verbatim apart from being lifted
// out of their closures (the closure's variables became parameters). actionLeaseEquivalence.test.ts holds the new readers to them.
// Do not "fix" anything here: these are the behaviour the new code must reproduce.

type Row = Record<string, unknown>;

/** actionStore.ts `view`. */
export function storeView(input: object): ActionView {
  const r=input as Record<string,unknown>;
  return {id:String(r.id),scopeKey:String(r.scope_key),kind:r.kind as ActionView['kind'],origin:r.origin as ActionView['origin'],sourceId:String(r.source_id),parentId:r.parent_id as string|null,
    state:r.state as ActionState,generation:Number(r.generation),holder:r.holder as string|null,lastHolder:r.last_holder as string|null,leaseUntil:r.lease_until as string|null,resources:JSON.parse(String(r.resources_json)),ownerInformed:r.owner_informed===1,
    deadline:r.deadline as string|null,progress:r.progress as string|null,result:r.result as string|null,sent:r.sent===1,failures:Number(r.failures),lastFailure:r.last_failure as string|null,createdAt:String(r.created_at),updatedAt:String(r.updated_at)};
}

/** actionStore.ts `check`, after `this.get`. */
export function storeCheck(action: ActionView | null, lease: ActionLease, at: string): boolean {
  return !!(action && action.generation === lease.generation && action.holder === lease.holder
    && action.leaseUntil !== null && Date.parse(action.leaseUntil) > Date.parse(at)
    && ['running','waiting'].includes(action.state) && (!action.deadline || Date.parse(action.deadline)>Date.parse(at)));
}

/** actionStore.ts `settle`, its `live`. */
export function settleLive(action: ActionView, lease: ActionLease, at: string): boolean {
  return action.generation===lease.generation && action.holder===lease.holder && action.leaseUntil!==null
    && action.leaseUntil>at && ['running','waiting','stopping'].includes(action.state);
}

/** taskRuntimeWiring.ts `leaseValid`, without the task's origin (unchanged in the wiring). */
export function taskLeaseValid(row: Row | undefined, scope: string, taskId: string, lease: ActionLease, at: string): boolean {
  return !!row && row.scope_key === scope && row.kind === 'agentTask'
    && row.holder === lease.holder && row.generation === lease.generation && row.state === 'running'
    && typeof row.source_id === 'string' && row.source_id.startsWith(`fca:${taskId}:`)
    && typeof row.lease_until === 'string' && row.lease_until > at
    && JSON.parse(String(row.base_resources_json)).includes(actionResource(scope, `fca:${taskId}`));
}

/** taskRuntimeWiring.ts `conversationLeaseValid`. */
export function conversationLeaseValid(row: Row | undefined, scope: string, lease: ActionLease, at: string): boolean {
  return !!row && row.scope_key === scope && row.origin === 'owner_request' && row.kind === 'respond'
    && row.holder === lease.holder && row.generation === lease.generation && row.state === 'running'
    && typeof row.lease_until === 'string' && row.lease_until > at;
}

/** taskRuntimeWiring.ts `classify` (`now()` became `at`). */
export function classify(row: Row | undefined, scopeKey: string, lease: ActionLease, at: string): 'live' | 'safe' | 'unknown' {
  if (!row || row.scope_key !== scopeKey) return 'unknown';
  if (row.generation === lease.generation + 1 && row.last_holder === lease.holder && row.sent === 0
    && row.state === 'cancelled' && row.result === 'lease_expired') return 'safe';
  if (row.generation === lease.generation && row.last_holder === lease.holder
    && row.state === 'cancelled' && row.result === 'fca_stop_acknowledged') return 'safe';
  if (row.generation !== lease.generation) return 'unknown';
  if (['running', 'waiting', 'stopping'].includes(String(row.state)) && row.holder === lease.holder
    && typeof row.lease_until === 'string' && row.lease_until > at) return 'live';
  return row.sent === 0 && ['cancelled', 'failed', 'completed'].includes(String(row.state)) ? 'safe' : 'unknown';
}

/** taskRuntimeWiring.ts `recoverAdmission`, its condition (`task.origin` became `origin`). */
export function recoverAdmission(action: Row | undefined, origin: string, scopeKey: string, taskId: string): boolean {
  return !!(action && action.origin === origin && ['owner_request', 'maintenance'].includes(String(action.origin)) && action.state === 'cancelled'
    && action.sent === 0 && action.result === 'lease_expired' && Number(action.generation) >= 2
    && typeof action.last_holder === 'string' && action.last_holder.length > 0
    && action.holder === null && action.lease_until === null && action.parent_id === null
    && action.base_resources_json === JSON.stringify([actionResource(scopeKey, `fca:${taskId}`)]));
}

/** taskRuntimeWiring.ts `execute`, its `unsent`. */
export function unsent(row: Row | undefined, scopeKey: string, lease: ActionLease): boolean {
  return row?.scope_key === scopeKey && row.holder === lease.holder && row.generation === lease.generation && row.sent === 0;
}

/** fcaSharedWiring.ts `fcaStepIsLive`. */
export function fcaStepIsLive(db: DatabaseSync, step: { id: string; scopeKey: string; taskId: string; lease: ActionLease }, at: string): boolean {
  const row = db.prepare(`SELECT c.step_id,c.lease_json,c.stop_requested,a.scope_key,a.kind,a.origin,a.source_id,a.state,a.holder,a.generation,a.lease_until
    FROM fca_task_checkpoints c JOIN mind_actions a ON a.id=? WHERE c.task_id=?`).get(step.lease.id, step.taskId);
  if (!row || row.step_id !== step.id || row.stop_requested !== 0 || row.scope_key !== step.scopeKey
    || row.kind !== 'agentTask' || row.origin !== 'owner_request' || row.state !== 'running' || row.holder !== step.lease.holder
    || row.generation !== step.lease.generation || typeof row.lease_until !== 'string' || row.lease_until <= at
    || typeof row.source_id !== 'string' || !row.source_id.startsWith(`fca:${step.taskId}:`)) return false;
  try { const lease = JSON.parse(String(row.lease_json)); return lease.id === step.lease.id && lease.holder === step.lease.holder && lease.generation === step.lease.generation; }
  catch { return false; }
}

/** fcaBodyWiring.ts `known` (`parts.ownerScope` became `ownerScope`). */
function bodyKnown(row: Row | undefined, ownerScope: string, lease: ActionLease, taskId: string): Row | null {
  return row && row.scope_key === ownerScope && row.kind === 'agentTask' && row.origin === 'owner_request'
    && typeof row.source_id === 'string' && row.source_id.startsWith(`fca:${taskId}:`)
    && (row.generation === lease.generation && (row.holder === lease.holder || row.last_holder === lease.holder)
      || row.generation === lease.generation + 1 && row.last_holder === lease.holder) ? row : null;
}

/** fcaBodyWiring.ts `leaseKnown`. */
export function bodyLeaseKnown(input: Row | undefined, ownerScope: string, lease: ActionLease, taskId: string, body: string): boolean {
  const row = bodyKnown(input, ownerScope, lease, taskId);
  return Boolean(row && ['running', 'waiting', 'stopping', 'unknown'].includes(String(row.state)) && JSON.parse(String(row.resources_json)).includes(body));
}

/** fcaBodyWiring.ts `leaseValid` (`new Date().toISOString()` became `at`). */
export function bodyLeaseValid(input: Row | undefined, ownerScope: string, lease: ActionLease, taskId: string, body: string, at: string): boolean {
  const row = bodyKnown(input, ownerScope, lease, taskId);
  return Boolean(row && row.generation === lease.generation && row.holder === lease.holder
    && row.state === 'running' && JSON.parse(String(row.resources_json)).includes(body) && typeof row.lease_until === 'string' && row.lease_until > at);
}

/** minecraftLifecycleWiring.ts `allowed`, its first test (the lease), negated to answer "held". */
export function lifecycleLease(row: Row | undefined, authority: MinecraftLifecycleAuthority, ownerScopeKey: string, at: string): boolean {
  if (!row || authority.executionId !== authority.lease.id || row.scope_key !== authority.scopeKey
    || authority.scopeKey !== ownerScopeKey || row.origin !== authority.origin || row.state !== 'running'
    || row.holder !== authority.lease.holder || row.generation !== authority.lease.generation
    || typeof row.lease_until !== 'string' || row.lease_until <= at
    || row.deadline && String(row.deadline) <= at) return false;
  return true;
}

/** serverFcaWiring.ts `lifecycleTask`, its task id. */
export function lifecycleTask(db: DatabaseSync, executionId: string, ownerScope: string): string | undefined {
  const row = db.prepare('SELECT source_id FROM mind_actions WHERE id=? AND scope_key=? AND kind=?').get(executionId, ownerScope, 'agentTask');
  return typeof row?.source_id === 'string' ? /^fca:([^:]+):[0-9]+$/.exec(row.source_id)?.[1] : undefined;
}

/** serverFcaWiring.ts `stopActions`, its task id. */
export function fcaTaskIdOf(sourceId: string): string | undefined {
  return /^fca:([^:]+):[0-9]+$/.exec(sourceId)?.[1];
}

/** minecraftLifecycleRecoveryWiring.ts `recover`, its query. */
export function unknownLifecycleCommands(db: DatabaseSync, resource: string): string[] {
  const rows = db.prepare(`SELECT o.command_json FROM minecraft_lifecycle_operations o JOIN mind_actions a ON a.id=o.execution_id
        WHERE a.state='unknown' AND json_extract(o.command_json,'$.authority.lease.generation')=a.generation-1
        AND json_extract(o.command_json,'$.authority.lease.holder')=a.last_holder AND EXISTS(SELECT 1 FROM json_each(a.resources_json) WHERE value=?)
        GROUP BY o.execution_id ORDER BY a.updated_at,a.id LIMIT 128`).all(resource);
  return rows.map(row => String(row.command_json));
}
