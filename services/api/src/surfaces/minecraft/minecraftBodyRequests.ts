import { type ClaimedMinecraftRequest, type MinecraftRequestView } from '../../contracts/minecraftBodyRequestContract.js';
export { MinecraftBodyRequests } from './store/minecraftRequestsStore.js';
export { requestLine, requestExperienceSummary, requestExperience } from './minecraftRequestLines.js';

/**
 * Requests to her Minecraft body (phase 4, `docs/minecraft-body-contract.md`): one queue on the server, filled by her
 * `minecraft.request` tool (a conversation with the owner alone) and by the intent of the owner's own game-chat turn,
 * and emptied by the one configured body device, which holds a long-poll claim open, reports progress, and a result.
 * Modelled on her folder's operations (`hostFolderOperations.ts`): presence is a recent claim, a claimed request is
 * leased and the lease is renewed while the body says it still holds it, and nothing is ever handed out twice.
 *
 * Only the owner's scope has a queue, and only the configured device may claim. What the body sends is closed (a
 * phase and a short step label, an outcome, a code, counts of items gained). When a request the body took finishes,
 * it becomes one experience in the server's own words (`body.game`, like her death), and for a while it is a block in
 * her turns with the owner (`promptBlock`), so that 「木材集まった？」 is answered from what the body reported.
 */
export interface MinecraftRequestsConfiguration { deviceId: string; ownerScopeKey: string }

export type EnqueueOutcome =
  | { kind: 'queued'; request: MinecraftRequestView; duplicate: boolean }
  | { kind: 'not_configured' | 'absent' | 'limit' | 'invalid' | 'model_unavailable' };

export interface ClaimResponse { request: ClaimedMinecraftRequest | null; cancel: string[]; blocked?: { id: string; reason: 'model_unavailable' } }
