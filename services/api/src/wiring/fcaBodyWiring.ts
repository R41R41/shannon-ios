import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftBodyConfiguration } from '../contracts/minecraftBodyContract.js';
import { actionResource, type ActionLease } from '../contracts/actionThreadContract.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import type { JevChooser } from '../infra/models/jev/jevChoice.js';
import { createReflexProviders } from '../infra/models/reflexProviders.js';
import { MinecraftControlStore } from '../surfaces/minecraft/store/minecraftControlStore.js';
import { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';

/** Separate body wire contract: pixels and coordinates never enter the historical game-chat DTO. */
export function configuredFcaMinecraft(values: Readonly<Record<string, string | undefined>>, parts: {
  db: DatabaseSync; configuration?: MinecraftBodyConfiguration | null; ownerScope: string; ownerAlone(): boolean;
  jev: JevChooser | null; usage: LlmUsageStore;
}) {
  if (values.SHANNON_FCA_MINECRAFT !== 'on') return null;
  if (!parts.configuration || !parts.jev || !values.OPENAI_API_KEY?.trim()) throw new Error('FCA_MINECRAFT_REQUIRES_BODY_JEV_DECISIONS');
  const known = (lease: ActionLease, taskId: string) => {
    const row = parts.db.prepare('SELECT * FROM mind_actions WHERE id=?').get(lease.id);
    return row && row.scope_key === parts.ownerScope && row.kind === 'agentTask' && row.origin === 'owner_request'
      && typeof row.source_id === 'string' && row.source_id.startsWith(`fca:${taskId}:`)
      && (row.generation === lease.generation && (row.holder === lease.holder || row.last_holder === lease.holder)
        || row.generation === lease.generation + 1 && row.last_holder === lease.holder) ? row : null;
  };
  const control = new MinecraftControl(new MinecraftControlStore(parts.db), parts.configuration, { now: Date.now, ownerAlone: parts.ownerAlone,
    leaseKnown: (lease, taskId) => { const row = known(lease, taskId); return Boolean(row && ['running', 'waiting', 'stopping', 'unknown'].includes(String(row.state)) && JSON.parse(String(row.resources_json)).includes(actionResource(parts.configuration!.deviceId, 'minecraft-body'))); },
    leaseValid: (lease, taskId) => { const row = known(lease, taskId); return Boolean(row && row.generation === lease.generation && row.holder === lease.holder
      && row.state === 'running' && JSON.parse(String(row.resources_json)).includes(actionResource(parts.configuration!.deviceId, 'minecraft-body')) && typeof row.lease_until === 'string' && row.lease_until > new Date().toISOString()); } });
  const providers = createReflexProviders({ enabled: true, jev: parts.jev, decisions: { apiKey: values.OPENAI_API_KEY,
    unknownCostUpperBoundUsd: 0.02, loadImage: async reference => control.image(reference.ref), recordUsage: receipt => {
      parts.usage.recordLlmUsage({ scopeKey: receipt.scopeKey, lane: 'chat', model: 'gpt-6-luna-decisions', inputTokens: receipt.inputTokens,
        cachedInputTokens: receipt.cachedInputTokens, outputTokens: receipt.outputTokens, totalTokens: receipt.totalTokens,
        estimatedCostUsd: receipt.estimatedCostUsd, occurredAt: receipt.occurredAt });
    } } })!;
  return { control, entry: providers.entry!, selector: providers.image! };
}
