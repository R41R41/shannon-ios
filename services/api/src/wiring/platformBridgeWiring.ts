import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionClock, CompanionStateStore } from '@shannon/cognition';
import { bearerAuthorized } from '../infra/auth/apiAuth.js';
import type { TurnBackgroundService } from '../mind/sleep/backgroundUpdates.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import { placeReply } from '../integrations/places/placeDiscovery.js';
import {
  configuredPlatformBridge,
  PlatformBridgeError,
  SHANNON_PLATFORM_CONTEXT_PATH,
  SHANNON_PLATFORM_TURN_PATH,
  type PlatformBridgeConfiguration,
  PlatformBridgeService,
} from '../mind/memory/platformMemoryPorts.js';
import { readJson, sendJson } from '../infra/http/serverHttp.js';
import type { PeopleMemoryStore } from '../mind/memory/memoryPorts.js';
import { PlatformPeople, platformPeopleEnabled } from '../mind/memory/platformPeople.js';
import type { MemoryProposals } from '../mind/memory/memoryPorts.js';
import { SQLiteSurfaceTurnLog } from '../mind/action/respond/store/surfaceTurnStore.js';
import { PlatformReplyService, SHANNON_PLATFORM_REPLY_PATH, platformReplyEnabled, type PlatformReplyConversation } from '../surfaces/platform/platformReply.js';

import type { PlatformBridgeRouteDependencies } from '../surfaces/platform/serverPlatformBridgeRoute.js';

export function createConfiguredPlatformBridgeRoute(
  environment: Readonly<Record<string, string | undefined>>,
  stateStore: CompanionStateStore,
  conversationStore: ConversationStore,
  background: TurnBackgroundService,
  now: CompanionClock,
  chatModel: ShannonChatModel,
  peopleStore: PeopleMemoryStore | null = null,
  /** The app's conversation kernel and the database, for `POST /v1/platform/reply`. Without them the route answers 503. */
  replies: { conversation: PlatformReplyConversation; databasePath: string } | null = null,
  /** Syzygy ADR-0008 stage 3 (F5): the memory outbox (null: switched off); F6: the people facts' readers (null: off). */
  memory: MemoryProposals | null = null,
  facts: ConstructorParameters<typeof PlatformPeople>[4] = null,
): PlatformBridgeRouteDependencies | null {
  const configuration = configuredPlatformBridge(environment);
  if (!configuration) return null;
  const service = new PlatformBridgeService(configuration, stateStore, conversationStore, background, now,
    peopleStore ? new PlatformPeople(peopleStore, stateStore, undefined, memory, facts) : null, () => platformPeopleEnabled(environment));
  const turns = replies && platformReplyEnabled(environment) ? new SQLiteSurfaceTurnLog(replies.databasePath, 'platform_reply_turns') : null;
  const reply = replies && turns ? new PlatformReplyService({
    scopeKey: configuration.scopeKey, bridge: service, conversationStore, conversation: replies.conversation, turns, now,
  }) : null;
  return { configuration, chatModel, service, reply, close: () => turns?.close() };
}
