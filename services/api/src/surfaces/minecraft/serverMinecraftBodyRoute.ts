import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionClock, CompanionStateStore } from '@shannon/cognition';
import type { TurnBackgroundService } from '../../mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { MinecraftBody, type MinecraftBodyDependencies, type MinecraftConversation } from './minecraftBody.js';
import { MINECRAFT_BODY_LIMITS, MINECRAFT_BODY_TURN_PATH, MinecraftBodyError, configuredMinecraftBody, type MinecraftBodyConfiguration } from '../../contracts/minecraftBodyContract.js';
import type { PeopleMemoryStore } from '../../mind/memory/memoryPorts.js';
import { platformPeopleEnabled } from '../../mind/memory/platformPeople.js';
import type { MemoryProposals } from '../../mind/memory/memoryPorts.js';
import { consumeDeviceAllowance, sendJson } from '../../infra/http/serverHttp.js';

export interface MinecraftBodyRoute {
  configuration: MinecraftBodyConfiguration | null;
  /** Answers `POST /v1/body/minecraft/turns` and returns true; any other path returns false untouched. */
  handle(request: IncomingMessage, response: ServerResponse, path: string, body: unknown, principal: ShannonDevicePrincipal | null): Promise<boolean>;
  close(): void;
}

/**
 * The route of her Minecraft body's game chat. The caller is a paired device (its token), never the platform
 * bridge's service token; the service checks it is the one configured device in the owner's scope.
 * `SHANNON_MINECRAFT_BODY_JSON` unset: 503, and nothing is opened.
 */
/** The route around a service, also for tests. */
export function minecraftBodyRoute(service: MinecraftBody | null, configuration: MinecraftBodyConfiguration | null, close: () => void = () => {}): MinecraftBodyRoute {
  const usage = new Map<string, { startedAt: number; count: number }>();
  return {
    configuration,
    close,
    async handle(request, response, path, body, principal) {
      if (isRequestPath(path)) {
        sendJson(response, 503, { error: 'MINECRAFT_BODY_NOT_CONFIGURED', message: 'Her Minecraft body takes requests through the common task tree.' });
        return true;
      }
      if (path !== MINECRAFT_BODY_TURN_PATH) return false;
      if (request.method !== 'POST') { sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
      if (!service) { sendJson(response, 503, { error: 'MINECRAFT_BODY_NOT_CONFIGURED', message: 'Her Minecraft body is not configured.' }); return true; }
      if (!principal) {
        sendJson(response, 403, { error: 'MINECRAFT_BODY_DEVICE_DENIED', message: 'A paired device token is required.' });
        return true;
      }
      // A cheap guard against a flood before any validation; model calls are counted by the service after the device, the
      // turn and a repeat were checked (`minecraftTurnAllowance.ts`).
      if (!consumeDeviceAllowance(usage, principal.deviceId, MINECRAFT_BODY_LIMITS.deviceRequestsPerMinute)) {
        sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many requests from this device; retry after a minute.' });
        return true;
      }
      try {
        const result = await service.turn(principal.scopeKey, principal.deviceId, body);
        sendJson(response, result.duplicate ? 200 : 201, result);
      } catch (error) {
        if (!(error instanceof MinecraftBodyError)) throw error;
        sendJson(response, error.status, { error: error.code, message: error.message });
      }
      return true;
    },
  };
}

/**
 * The request queue of phase 4 (claim, list, progress, report, cancel) is retired (Syzygy ADR-0009 S9): her body takes the
 * owner's requests through the common task tree (`/v1/body/minecraft/control`). Its paths keep the closed answer they gave
 * since the common path was switched on, never a silent 404.
 */
const RETIRED_REQUEST_PATH = /^\/v1\/body\/minecraft\/(?:claim|requests(?:\/[^/]+\/(?:progress|report|cancel))?)$/u;
function isRequestPath(path: string): boolean {
  return RETIRED_REQUEST_PATH.test(path);
}
