import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftBodyConfiguration } from '../contracts/minecraftBodyContract.js';
import { actionResource, type ActionLease } from '../contracts/actionThreadContract.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import type { JevChooser } from '../infra/models/jev/jevChoice.js';
import { createReflexProviders } from '../infra/models/reflexProviders.js';
import { MinecraftControlStore } from '../surfaces/minecraft/store/minecraftControlStore.js';
import { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { bodyLeaseAttempt, bodyLeaseKnown, bodyLeaseValid } from './actionLeaseRules.js';

/** Separate body wire contract: pixels and coordinates never enter the historical game-chat DTO. */
export function configuredFcaMinecraft(values: Readonly<Record<string, string | undefined>>, parts: {
  db: DatabaseSync; configuration?: MinecraftBodyConfiguration | null; ownerScope: string; ownerAlone(): boolean;
  jev: JevChooser | null; usage: LlmUsageStore;
}) {
  // Since Syzygy ADR-0009 S9 a configured body always takes the common path (the phase-4 request queue is retired).
  if (!parts.configuration) return null;
  if (!parts.jev || !values.OPENAI_API_KEY?.trim()) throw new Error('FCA_MINECRAFT_REQUIRES_BODY_JEV_DECISIONS');
  const leases = new ActionLeaseReader(parts.db);
  const body = actionResource(parts.configuration.deviceId, 'minecraft-body');
  const known = (lease: ActionLease, taskId: string) => bodyLeaseAttempt(leases.get(lease.id), parts.ownerScope, lease, taskId);
  const control = new MinecraftControl(new MinecraftControlStore(parts.db), parts.configuration, { now: Date.now, ownerAlone: parts.ownerAlone,
    leaseKnown: (lease, taskId) => bodyLeaseKnown(known(lease, taskId), body),
    leaseValid: (lease, taskId) => bodyLeaseValid(known(lease, taskId), lease, body, new Date().toISOString()) });
  const providers = createReflexProviders({ enabled: true, jev: parts.jev, decisions: { apiKey: values.OPENAI_API_KEY,
    unknownCostUpperBoundUsd: 0.02, loadImage: async reference => control.image(reference.ref), recordUsage: receipt => {
      parts.usage.recordLlmUsage({ scopeKey: receipt.scopeKey, lane: 'chat', model: 'gpt-6-luna-decisions', inputTokens: receipt.inputTokens,
        cachedInputTokens: receipt.cachedInputTokens, outputTokens: receipt.outputTokens, totalTokens: receipt.totalTokens,
        estimatedCostUsd: receipt.estimatedCostUsd, occurredAt: receipt.occurredAt });
    } } })!;
  return { control, entry: providers.entry!, selector: providers.image! };
}
