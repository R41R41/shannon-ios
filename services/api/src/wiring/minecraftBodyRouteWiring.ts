import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionClock, CompanionStateStore } from '@shannon/cognition';
import type { TurnBackgroundService } from '../mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { ShannonDevicePrincipal } from '../infra/auth/deviceAuth.js';
import { MinecraftBody, type MinecraftBodyDependencies, type MinecraftConversation } from '../surfaces/minecraft/minecraftBody.js';
import { MINECRAFT_BODY_LIMITS, MINECRAFT_BODY_TURN_PATH, MinecraftBodyError, configuredMinecraftBody, type MinecraftBodyConfiguration } from '../contracts/minecraftBodyContract.js';
import { SQLiteMinecraftTurnLog } from '../mind/action/respond/store/surfaceTurnStore.js';
import type { PeopleMemoryStore } from '../mind/memory/memoryPorts.js';
import { platformPeopleEnabled } from '../mind/memory/platformPeople.js';
import type { MemoryProposals } from '../mind/memory/memoryPorts.js';
import { consumeDeviceAllowance, sendJson } from '../infra/http/serverHttp.js';
import { closedSignal } from '../infra/http/apiAutonomyHostStepRoutes.js';
import type { MinecraftBodyRequests } from '../surfaces/minecraft/minecraftBodyRequests.js';
import { MINECRAFT_REQUEST_LIMITS, MINECRAFT_REQUEST_PATHS, validClaim, validProgress, validReport } from '../contracts/minecraftBodyRequestContract.js';

import { minecraftBodyRoute, type MinecraftBodyRoute } from '../surfaces/minecraft/serverMinecraftBodyRoute.js';

export function createMinecraftBodyRoute(
  environment: Readonly<Record<string, string | undefined>>,
  databasePath: string,
  dependencies: {
    stateStore: CompanionStateStore; conversationStore: ConversationStore; background: TurnBackgroundService; now: CompanionClock;
    chatModel: ShannonChatModel; peopleStore: PeopleMemoryStore | null;
    /** The app's conversation kernel; read at call time, so it may be created after this route. */
    conversation: MinecraftConversation;
    /** Phase 4: the request queue, made by the server so her tools share it. Absent, the request routes answer 503. */
    requests?: MinecraftBodyRequests | null;
    /** Syzygy ADR-0008 stage 3 (F5): the memory outbox (absent: switched off); F6: the people facts' readers. */
    memory?: MemoryProposals | null;
    peopleFacts?: MinecraftBodyDependencies['peopleFacts'];
    fcaIntent?: MinecraftBodyDependencies['fcaIntent'];
  },
): MinecraftBodyRoute {
  const configuration = configuredMinecraftBody(environment);
  const turns = configuration ? new SQLiteMinecraftTurnLog(databasePath) : null;
  const requests = configuration ? dependencies.requests ?? null : null;
  const service = configuration && turns
    ? new MinecraftBody({ ...dependencies, configuration, turns, requests, peopleEnabled: () => platformPeopleEnabled(environment) }) : null;
  return minecraftBodyRoute(service, configuration, () => turns?.close(), requests);
}
