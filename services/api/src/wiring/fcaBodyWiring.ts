import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftBodyConfiguration } from '../contracts/minecraftBodyContract.js';
import { actionResource, type ActionLease, type ActionThreads } from '../contracts/actionThreadContract.js';
import { createMinecraftBodyRecheck } from './minecraftBodyRecheckWiring.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import type { JevChooser } from '../infra/models/jev/jevChoice.js';
import { createReflexProviders } from '../infra/models/reflexProviders.js';
import { createReflexGovernor } from '../mind/action/reflex/reflexGovernor.js';
import { MinecraftControlStore } from '../surfaces/minecraft/store/minecraftControlStore.js';
import { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { ActionLeaseReader } from '../mind/action/threads/store/actionLeaseReader.js';
import { bodyLeaseAttempt, bodyLeaseKnown, bodyLeaseValid } from './actionLeaseRules.js';

/** Separate body wire contract: pixels and coordinates never enter the historical game-chat DTO. */
export function configuredFcaMinecraft(values: Readonly<Record<string, string | undefined>>, parts: {
  db: DatabaseSync; configuration?: MinecraftBodyConfiguration | null; ownerScope: string; ownerAlone(): boolean;
  taskAudienceAllowed?(taskId: string): boolean;
  jev: JevChooser | null; usage: LlmUsageStore;
  /** For the body re-check's domain proof (`minecraftBodyRecheckWiring.ts`). */
  actions: Pick<ActionThreads, 'reconcileResource'>;
}) {
  // Since Syzygy ADR-0009 S9 a configured body always takes the common path (the phase-4 request queue is retired).
  if (!parts.configuration) return null;
  if (!parts.jev || !values.OPENAI_API_KEY?.trim()) throw new Error('FCA_MINECRAFT_REQUIRES_BODY_JEV_DECISIONS');
  const leases = new ActionLeaseReader(parts.db);
  const body = actionResource(parts.configuration.deviceId, 'minecraft-body');
  const known = (lease: ActionLease, taskId: string) => bodyLeaseAttempt(leases.get(lease.id), parts.ownerScope, lease, taskId);
  const control = new MinecraftControl(new MinecraftControlStore(parts.db), parts.configuration, { now: Date.now, ownerAlone: parts.ownerAlone,
    taskAudienceAllowed: parts.taskAudienceAllowed,
    leaseKnown: (lease, taskId) => bodyLeaseKnown(known(lease, taskId), body),
    // Run 44, resume 1: a release naming a hold goes with the held act's lease, whose step the hold stopped.
    leaseAttempted: (lease, taskId) => known(lease, taskId) !== null,
    leaseValid: (lease, taskId) => bodyLeaseValid(known(lease, taskId), lease, body, new Date().toISOString()) });
  const providers = createReflexProviders({ enabled: true, jev: parts.jev, decisions: { apiKey: values.OPENAI_API_KEY,
    unknownCostUpperBoundUsd: 0.02, loadImage: async reference => control.image(reference.ref), recordUsage: receipt => {
      parts.usage.recordLlmUsage({ scopeKey: receipt.scopeKey, lane: 'chat', model: 'gpt-6-luna-decisions', inputTokens: receipt.inputTokens,
        cachedInputTokens: receipt.cachedInputTokens, outputTokens: receipt.outputTokens, totalTokens: receipt.totalTokens,
        estimatedCostUsd: receipt.estimatedCostUsd, occurredAt: receipt.occurredAt });
    } } })!;
  // A body retained by an unknown step is re-checked with the body itself, at start and when the operator asks (run 6).
  const recheck = createMinecraftBodyRecheck({ db: parts.db, control, actions: parts.actions, ownerScope: parts.ownerScope,
    deviceId: parts.configuration.deviceId, log: line => console.log(line) });
  // One per process: a task's automatic reflex entries are governed across its steps (Minecraft run 10).
  return { control, entry: providers.entry!, selector: providers.image!, recheck, governor: createReflexGovernor() };
}
