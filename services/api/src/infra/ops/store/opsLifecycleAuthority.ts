import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftLifecycleAuthority, MinecraftLifecycleCommand } from '../../../contracts/minecraftLifecycleContract.js';
import type { OpsCommandRequest } from '../../../contracts/opsCommandContract.js';
import { opsActionKindMatches, opsLifecycleMapping } from '../../../contracts/opsMinecraftLifecycleContract.js';
import { ActionLeaseReader } from '../../../mind/action/threads/store/actionLeaseReader.js';

interface DispatchRow {
  command_id: string; type: OpsCommandRequest['type']; target: string; requested_by_device_id: string; status: string; server_id: string;
  action: string; lifecycle_id: string; lease_generation: number; lease_holder: string; execution_kind: string;
}

/** No model-controlled source prefix grants authority: verify the immutable paired-device request and mapping. */
export function opsLifecycleAuthorityAllowed(db: DatabaseSync, authority: MinecraftLifecycleAuthority,
  command?: Pick<MinecraftLifecycleCommand, 'id' | 'serverId' | 'action'>): boolean {
  if (!command || authority.origin !== 'owner_request') return false;
  try {
    const row = db.prepare(`SELECT o.command_id,o.type,o.target,o.requested_by_device_id,o.status,m.server_id,m.action,m.lifecycle_id,
      m.lease_generation,m.lease_holder,m.execution_kind FROM ops_commands o JOIN ops_lifecycle_dispatches m ON m.command_id=o.command_id
      WHERE m.action_id=? AND o.scope_key=?`).get(authority.executionId, authority.scopeKey) as DispatchRow | undefined;
    // The action's kind, origin and source never change after it is enqueued, so reading it apart from the join answers the same.
    const action = row ? new ActionLeaseReader(db).get(authority.executionId) : null;
    const mapping = row && opsLifecycleMapping(row);
    return !!row && !!action && !!mapping && row.status === 'claimed' && !!row.requested_by_device_id
      && opsActionKindMatches(row.execution_kind, action.kind) && action.origin === 'owner_request'
      && action.sourceId === `ops:${row.command_id}` && row.lifecycle_id === command.id && row.server_id === mapping.serverId
      && row.action === mapping.action && command.serverId === row.server_id && command.action === row.action
      && row.lease_generation === authority.lease.generation && row.lease_holder === authority.lease.holder
      && authority.sourceIds.length === 1 && authority.sourceIds[0] === `ops-command:${row.command_id}`;
  } catch { return false; }
}
