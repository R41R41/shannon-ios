import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { switchOn } from '@shannon/switches';
import { actionResource, type ActionLease } from '../contracts/actionThreadContract.js';
import { configuredMinecraftBody } from '../contracts/minecraftBodyContract.js';
import { configuredOwnerScope } from '../infra/config/ownerScope.js';
import { retainedResource, type RetainedResourcePolicy } from '../mind/action/threads/store/retainedResources.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { leaseOperations, type LeaseOperation } from '../surfaces/minecraft/store/minecraftControlStore.js';

/** Called synchronously inside the action writer's transaction, so cleanup cannot race physical-resource release. */
export function configuredActionResourceProof(values: Readonly<Record<string, string | undefined>>, db: DatabaseSync) {
  const configuration = switchOn(values, 'SHANNON_MINECRAFT_LIFECYCLE') ? configuredMinecraftBody(values) : null;
  return (lease: ActionLease, resource: string, acknowledgementId: string): boolean => {
    if (!configuration || resource !== actionResource(configuration.deviceId, 'minecraft-body')) return false;
    return minecraftLifecycleResourceProof(db, lease, acknowledgementId, configuration.ownerScopeKey)
      || minecraftFcaReleaseProof(db, lease, acknowledgementId, configuration.ownerScopeKey);
  };
}
/** How long the known Agent Host ids are reused before the registry is read again. */
const HOST_IDS_REFRESH_MS = 60_000;

/**
 * The resources only a release proof may free, also after the unknown deadline (ADR-0009 §9): every registered Agent Host's
 * lock with the owner's folder locks it takes along, and the configured Minecraft body (with its lifecycle), base or added.
 * The keys are built by hashing the configured names the same way the actions hashed them.
 */
export function configuredRetainedResources(values: Readonly<Record<string, string | undefined>>,
  hostIds: () => readonly string[] = () => []) {
  const configuration = switchOn(values, 'SHANNON_MINECRAFT_LIFECYCLE') ? configuredMinecraftBody(values) : null;
  const body = configuration ? actionResource(configuration.deviceId, 'minecraft-body') : null;
  const owner = configuredOwnerScope(values);
  const companions = new Set([actionResource(owner, 'folder:mac'), actionResource(owner, 'folder:vm')]);
  let policy: RetainedResourcePolicy | null = null;
  let readAt = 0;
  const current = (): RetainedResourcePolicy => {
    if (policy && Date.now() - readAt < HOST_IDS_REFRESH_MS) return policy;
    const hosts = hostIds().map(id => actionResource(id, 'agent-host'));
    policy = { anchors: new Set([...hosts, ...(body ? [body] : [])]), companions };
    readAt = Date.now();
    return policy;
  };
  return (resource: string, resources: readonly string[], action?: { kind: string; sourceId: string }): boolean =>
    !(resource === body && action && lifecycleHolder(action)) && retainedResource(current(), resource, resources);
}

/**
 * An action that holds the Minecraft body only for a lifecycle operation (a conversation turn of before 2026-10-13, a
 * conversation's or an Ops request's own Minecraft action): at the unknown exit it releases the body with its slot, the one
 * standard exit (owner decision of 2026-10-13 through the Minebot lane); the operator's journal settles its own side. A body
 * held for play (an FCA step, the legacy request) still waits for its release proof.
 */
function lifecycleHolder(action: { kind: string; sourceId: string }): boolean {
  // `operator:<uuid>`: the operator's lifecycle operation (`operatorLifecycleWiring.ts`), held for that operation only.
  return action.kind === 'respond' || action.kind === 'minecraft' && /^(lifecycle|ops|operator):/u.test(action.sourceId);
}
export function lifecycleResourceAcknowledgement(evidence: readonly unknown[]): string {
  return `lifecycle-release:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
}
/** Only an accepted original native terminal receipt proves release, never a current matching snapshot. */
export function minecraftLifecycleResourceProof(db: DatabaseSync, lease: ActionLease, acknowledgementId: string, scopeKey: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='minecraft_lifecycle_operations'").get()) return false;
  if (new ActionLeaseReader(db).get(lease.id)?.scopeKey !== scopeKey) return false;
  const evidence = db.prepare(`SELECT id,receipt_json FROM minecraft_lifecycle_operations WHERE execution_id=?
    AND json_extract(command_json,'$.authority.scopeKey')=? AND json_extract(command_json,'$.authority.lease.id')=?
    AND json_extract(command_json,'$.authority.lease.generation')=? AND json_extract(command_json,'$.authority.lease.holder')=? ORDER BY id`)
    .all(lease.id, scopeKey, lease.id, lease.generation, lease.holder);
  if (!evidence.length || evidence.some(row => {
    const receipt = row.receipt_json ? JSON.parse(String(row.receipt_json)) as { outcome?: unknown; inputsReleased?: unknown } : null;
    return !receipt || !['completed', 'cancelled', 'refused'].includes(String(receipt.outcome)) || receipt.inputsReleased !== true;
  }) || acknowledgementId !== lifecycleResourceAcknowledgement(evidence)) return false;
  if (db.prepare(`SELECT 1 FROM minecraft_lifecycle_operations WHERE execution_id=? AND
    (receipt_json IS NULL OR json_extract(receipt_json,'$.outcome')='unknown'
    OR COALESCE(json_extract(receipt_json,'$.inputsReleased'),0)!=1) LIMIT 1`).get(lease.id)) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_body_operations'").get()) return true;
  return !db.prepare(`SELECT 1 FROM fca_body_operations WHERE
    json_extract(command_json,'$.lease.id')=? AND json_extract(command_json,'$.lease.holder')=?
    AND json_extract(command_json,'$.lease.generation')=? AND
    (phase!='settled' OR receipt_json IS NULL OR json_extract(receipt_json,'$.outcome')='unknown'
    OR COALESCE(json_extract(receipt_json,'$.inputsReleased'),0)!=1) LIMIT 1`).get(lease.id, lease.holder, lease.generation);
}

/** The id of a body re-check's release command (`minecraftBodyRecheckWiring.ts`): asked by the API, never by a task step. */
export const FCA_RECHECK_PREFIX = 'recheck:';
/** The acknowledgement a body re-check's release proof is reconciled under: its command id and the receipt as accepted. */
export function fcaReleaseAcknowledgement(evidence: { id: string; receipt: string }): string {
  return `fca-release:${createHash('sha256').update(JSON.stringify([evidence.id, evidence.receipt])).digest('hex')}`;
}
/**
 * An FCA step's body, proven released by the body itself (Minecraft run 6, owner decision 2026-10-14 「直しを入れてから自動で解放」):
 * after the step's last body operation, a re-check `release` of the same lease and session was taken by the body, which answered
 * `stopped` with every input released (its actuator confirmed every physical controller idle). Anything of the lease sent after
 * that re-check must itself be settled released. Only this original receipt proves it, never a current matching snapshot.
 */
export function minecraftFcaReleaseProof(db: DatabaseSync, lease: ActionLease, acknowledgementId: string, scopeKey: string): boolean {
  const evidence = fcaReleaseEvidence(db, lease, scopeKey);
  return !!evidence && acknowledgementId === fcaReleaseAcknowledgement(evidence);
}
/** The re-check receipt that proves the lease's body released (above), or null. */
export function fcaReleaseEvidence(db: DatabaseSync, lease: ActionLease, scopeKey: string): { id: string; receipt: string } | null {
  const action = new ActionLeaseReader(db).get(lease.id);
  if (!action || action.scopeKey !== scopeKey || action.kind !== 'agentTask') return null;
  const rows = leaseOperations(db, lease, scopeKey);
  const receiptOf = (row: LeaseOperation) => row.receipt ? JSON.parse(row.receipt) as {
    outcome?: unknown; inputsReleased?: unknown; stop?: { state?: unknown; inputsReleased?: unknown } } : null;
  const proof = [...rows].reverse().find(row => {
    const receipt = receiptOf(row);
    return row.id.startsWith(FCA_RECHECK_PREFIX) && row.kind === 'release' && row.phase === 'settled' && receipt?.outcome === 'completed'
      && receipt.inputsReleased === true && receipt.stop?.state === 'stopped' && receipt.stop.inputsReleased === true;
  });
  if (!proof?.receipt) return null;
  // Anything of the lease sent after the re-check must itself be settled with its inputs released.
  if (rows.some(row => row.position > proof.position && (row.phase !== 'settled' || receiptOf(row)?.outcome === 'unknown'
    || receiptOf(row)?.inputsReleased !== true))) return null;
  return { id: proof.id, receipt: proof.receipt };
}
