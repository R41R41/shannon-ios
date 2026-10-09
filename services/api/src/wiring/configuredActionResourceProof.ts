import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { actionResource, type ActionLease } from '../contracts/actionThreadContract.js';
import { configuredMinecraftBody } from '../contracts/minecraftBodyContract.js';

/** Called synchronously inside the action writer's transaction, so cleanup cannot race physical-resource release. */
export function configuredActionResourceProof(values: Readonly<Record<string, string | undefined>>, db: DatabaseSync) {
  const configuration = values.SHANNON_MINECRAFT_LIFECYCLE === 'on' ? configuredMinecraftBody(values) : null;
  return (lease: ActionLease, resource: string, acknowledgementId: string): boolean => {
    if (!configuration || resource !== actionResource(configuration.deviceId, 'minecraft-body')) return false;
    return minecraftLifecycleResourceProof(db, lease, acknowledgementId, configuration.ownerScopeKey);
  };
}
export function lifecycleResourceAcknowledgement(evidence: readonly unknown[]): string {
  return `lifecycle-release:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
}
/** Only an accepted original native terminal receipt proves release, never a current matching snapshot. */
export function minecraftLifecycleResourceProof(db: DatabaseSync, lease: ActionLease, acknowledgementId: string, scopeKey: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='minecraft_lifecycle_operations'").get()) return false;
  const action = db.prepare('SELECT scope_key FROM mind_actions WHERE id=?').get(lease.id);
  if (action?.scope_key !== scopeKey) return false;
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
