import { lifecycleResourceAcknowledgement, minecraftLifecycleResourceProof } from './configuredActionResourceProof.js';
import type { DatabaseSync } from 'node:sqlite';
import { actionResource, type ActionThreads } from '../contracts/actionThreadContract.js';
import type { MinecraftLifecycleCommand } from '../contracts/minecraftLifecycleContract.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';

/** A late physical receipt releases only its original body resource, never task/model/budget authority. */
export function createMinecraftLifecycleRecovery(parts: {
  db: DatabaseSync; service: MinecraftLifecycle; actions: Pick<ActionThreads, 'reconcileResource'>; deviceId: string;
}) {
  const resource = actionResource(parts.deviceId, 'minecraft-body');
  let running: Promise<void> | null = null, closing = false;
  const recover = (): Promise<void> => {
    if (closing) return Promise.resolve();
    if (running) return running;
    const job = (async () => {
      const rows = parts.db.prepare(`SELECT o.command_json FROM minecraft_lifecycle_operations o JOIN mind_actions a ON a.id=o.execution_id
        WHERE a.state='unknown' AND json_extract(o.command_json,'$.authority.lease.generation')=a.generation-1
        AND json_extract(o.command_json,'$.authority.lease.holder')=a.last_holder AND EXISTS(SELECT 1 FROM json_each(a.resources_json) WHERE value=?)
        GROUP BY o.execution_id ORDER BY a.updated_at,a.id LIMIT 128`).all(resource);
      for (const row of rows) {
        const command = JSON.parse(String(row.command_json)) as MinecraftLifecycleCommand;
        if (command.authority.scopeKey !== parts.service.configuration.ownerScopeKey
          || !parts.service.safe(command.authority.executionId)) continue;
        // Every original lifecycle receipt is already identity/postcondition validated by the paired controller.
        const evidence = parts.db.prepare(`SELECT id,receipt_json FROM minecraft_lifecycle_operations WHERE execution_id=? AND json_extract(command_json,'$.authority.lease.generation')=? AND json_extract(command_json,'$.authority.lease.holder')=? ORDER BY id`)
          .all(command.authority.executionId, command.authority.lease.generation, command.authority.lease.holder);
        const id = lifecycleResourceAcknowledgement(evidence);
        if (!minecraftLifecycleResourceProof(parts.db, command.authority.lease, id, command.authority.scopeKey)) continue;
        await parts.actions.reconcileResource(command.authority.lease, resource, id);
      }
    })().catch(() => { /* Retry only delivery of original accepted receipts, never physical commands. */ }).finally(() => { if (running === job) running = null; });
    running = job; return job;
  };
  const timer = setInterval(() => { void recover(); }, 1000); timer.unref();
  return { recover, async close() { closing = true; clearInterval(timer); await running; } };
}
