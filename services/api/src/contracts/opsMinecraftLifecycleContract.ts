import type { MinecraftLifecycleAction } from './minecraftLifecycleContract.js';
import type { OpsCommandRequest } from './opsCommandContract.js';

export interface OpsLifecycleMapping { serverId: 'shannon-home'; action: MinecraftLifecycleAction }
/** Exact fixed aliases only. Manager controls and other registered servers keep their existing meaning. */
export function opsLifecycleMapping(request: Pick<OpsCommandRequest, 'type' | 'target'>): OpsLifecycleMapping | null {
  if (request.type === 'service.stop' && request.target === 'minebot:bot') return { serverId: 'shannon-home', action: 'logout' };
  if (request.target !== 'minecraft:shannon-home') return null;
  if (request.type === 'minecraft.start') return { serverId: 'shannon-home', action: 'start' };
  if (request.type === 'minecraft.stop') return { serverId: 'shannon-home', action: 'stop' };
  if (request.type === 'minebot.start') return { serverId: 'shannon-home', action: 'login' };
  return null;
}
export interface OpsMinecraftLifecyclePort {
  mapping(scopeKey: string, request: OpsCommandRequest): OpsLifecycleMapping | null;
  wake(): void;
}
