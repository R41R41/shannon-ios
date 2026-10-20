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
import { PlatformVoiceService, platformVoiceEnabled } from '../surfaces/platform/platformVoice.js';
import type { PlatformVoiceRoutes } from '../surfaces/platform/platformVoiceRoute.js';
import { voiceMouth } from '../surfaces/platform/voiceMouth.js';
import type { VoiceMinecraftPort } from '../surfaces/platform/voiceMinecraftPort.js';
import { createConfiguredElevenSpeechGateway } from '../infra/models/elevenSpeech.js';
import { splitChatSentences } from '../surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../surfaces/text/chatSentenceStream.js';

export function createConfiguredPlatformBridgeRoute(
  environment: Readonly<Record<string, string | undefined>>,
  stateStore: CompanionStateStore,
  conversationStore: ConversationStore,
  background: TurnBackgroundService,
  now: CompanionClock,
  chatModel: ShannonChatModel,
  peopleStore: PeopleMemoryStore | null = null,
  /** The app's conversation kernel and the database, for `POST /v1/platform/reply`. Without them the route answers 503. */
  replies: {
    conversation: PlatformReplyConversation; databasePath: string;
    /** `SHANNON_DC_VOICE`: her Minecraft body's side of an owner's spoken request, read at each turn (the part may connect later). */
    voiceMinecraft?: () => VoiceMinecraftPort | null;
  } | null = null,
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
  // A Discord voice channel (`SHANNON_DC_VOICE`, dc-voice): its own turn log, the one mouth queue, her ElevenLabs voice.
  const voiceTurns = replies && platformVoiceEnabled(environment) ? new SQLiteSurfaceTurnLog(replies.databasePath, 'platform_voice_turns') : null;
  const voice: PlatformVoiceRoutes | null = replies && voiceTurns ? {
    service: new PlatformVoiceService({
      scopeKey: configuration.scopeKey, bridge: service, conversationStore, conversation: replies.conversation, turns: voiceTurns, now,
      chatModel, sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), environment: () => environment,
      ...(replies.voiceMinecraft ? { minecraft: replies.voiceMinecraft } : {}),
    }),
    mouth: voiceMouth, speech: configuredVoiceSpeech(environment), scopeKey: configuration.scopeKey, environment: () => environment,
  } : null;
  return { configuration, chatModel, service, reply, voice, close: () => {
    turns?.close();
    voiceTurns?.close();
  } };
}

/** Her ElevenLabs voice for the voice channel, or null when it is not configured (the route then answers 503 and the bot says the line in its own voice). */
function configuredVoiceSpeech(environment: Readonly<Record<string, string | undefined>>) {
  try {
    return createConfiguredElevenSpeechGateway(environment);
  } catch {
    return null;
  }
}
