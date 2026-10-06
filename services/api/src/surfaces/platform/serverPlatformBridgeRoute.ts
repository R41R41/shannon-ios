import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionClock, CompanionStateStore } from '@shannon/cognition';
import { bearerAuthorized } from '../../apiAuth.js';
import type { TurnBackgroundService } from '../../mind/sleep/backgroundUpdates.js';
import type { ConversationStore } from '../../mind/memory/store/conversationStore.js';
import type { ShannonChatModel } from '../../chatModel.js';
import { placeReply } from '../../integrations/places/placeDiscovery.js';
import {
  configuredPlatformBridge,
  PlatformBridgeError,
  SHANNON_PLATFORM_CONTEXT_PATH,
  SHANNON_PLATFORM_TURN_PATH,
  type PlatformBridgeConfiguration,
  PlatformBridgeService,
} from './platformBridge.js';
import { readJson, sendJson } from '../../serverHttp.js';
import type { PeopleMemoryStore } from '../../mind/memory/store/peopleMemoryStore.js';
import { PlatformPeople, platformPeopleEnabled } from './platformPeople.js';
import { SQLiteSurfaceTurnLog } from '../minecraft/store/minecraftTurnStore.js';
import { PlatformReplyService, SHANNON_PLATFORM_REPLY_PATH, platformReplyEnabled, type PlatformReplyConversation } from './platformReply.js';

export interface PlatformBridgeRouteDependencies {
  configuration: PlatformBridgeConfiguration;
  service: PlatformBridgeService;
  chatModel: ShannonChatModel;
  /** `POST /v1/platform/reply`: null while `SHANNON_PLATFORM_REPLY` is not on (503). */
  reply?: PlatformReplyService | null;
  close?: () => void;
}

export const SHANNON_PLATFORM_PLACES_PATH = '/v1/platform/places';

export function isPlatformBridgePath(path: string): boolean {
  return path === SHANNON_PLATFORM_TURN_PATH || path === SHANNON_PLATFORM_CONTEXT_PATH
    || path === SHANNON_PLATFORM_PLACES_PATH || path === SHANNON_PLATFORM_REPLY_PATH;
}

export async function handlePlatformBridgeRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: PlatformBridgeRouteDependencies | null,
): Promise<void> {
  if (path === SHANNON_PLATFORM_CONTEXT_PATH) {
    await handlePlatformBridgeContext(request, response, dependencies);
    return;
  }
  if (path === SHANNON_PLATFORM_PLACES_PATH) {
    await handlePlatformBridgePlaces(request, response, dependencies);
    return;
  }
  if (path === SHANNON_PLATFORM_REPLY_PATH) {
    await handlePlatformBridgeReply(request, response, dependencies);
    return;
  }
  await handlePlatformBridgeTurn(request, response, dependencies);
}

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
): PlatformBridgeRouteDependencies | null {
  const configuration = configuredPlatformBridge(environment);
  if (!configuration) return null;
  const service = new PlatformBridgeService(configuration, stateStore, conversationStore, background, now,
    peopleStore ? new PlatformPeople(peopleStore, stateStore) : null, () => platformPeopleEnabled(environment));
  const turns = replies && platformReplyEnabled(environment) ? new SQLiteSurfaceTurnLog(replies.databasePath, 'platform_reply_turns') : null;
  const reply = replies && turns ? new PlatformReplyService({
    scopeKey: configuration.scopeKey, bridge: service, conversationStore, conversation: replies.conversation, turns, now,
  }) : null;
  return { configuration, chatModel, service, reply, close: () => turns?.close() };
}

/**
 * `POST /v1/platform/reply`: her reply to a message in a bound conversation, through the conversation kernel
 * (`platformReply.ts`). The bridge's service token only; refused exactly as `/v1/platform/context` refuses.
 */
export async function handlePlatformBridgeReply(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: PlatformBridgeRouteDependencies | null,
): Promise<void> {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!dependencies) return sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
  if (!bearerAuthorized(request.headers.authorization, dependencies.configuration.token)) {
    return sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
  }
  if (!dependencies.reply) return sendJson(response, 503, { error: 'PLATFORM_REPLY_DISABLED', message: 'Platform replies are switched off on the server.' });
  try {
    const result = await dependencies.reply.reply(await readJson(request, 64 * 1024));
    sendJson(response, result.duplicate ? 200 : 201, result);
  } catch (error) {
    if (error instanceof PlatformBridgeError) {
      sendJson(response, error.status, { error: error.code, message: error.message });
      return;
    }
    throw error;
  }
}

export async function handlePlatformBridgePlaces(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: PlatformBridgeRouteDependencies | null,
): Promise<void> {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!dependencies) return sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
  if (!bearerAuthorized(request.headers.authorization, dependencies.configuration.token)) {
    return sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
  }
  const body = await readJson(request, 4 * 1024);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof (body as { query?: unknown }).query !== 'string'
    || !(body as { query: string }).query.trim()
    || (body as { query: string }).query.length > 300) {
    return sendJson(response, 400, { error: 'PLACE_QUERY_INVALID' });
  }
  const query = (body as { query: string }).query.trim();
  const result = await dependencies.chatModel.generate({
    scopeKey: 'public-discord-places',
    systemPrompt: 'この検索はDiscordの公開会話用。個人情報や個人記憶を参照せず、指定された場所の実在する候補だけを答える。',
    history: [], message: query, useWebSearch: true, placeSearch: {},
  });
  sendJson(response, 200, {
    reply: placeReply(result.reply, result.places ?? []),
    places: result.places ?? [],
    sources: result.webSources ?? [],
  });
}

export async function handlePlatformBridgeTurn(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: PlatformBridgeRouteDependencies | null,
): Promise<void> {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!dependencies) {
    sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
    return;
  }
  if (!bearerAuthorized(request.headers.authorization, dependencies.configuration.token)) {
    sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
    return;
  }
  try {
    const result = dependencies.service.ingest(await readJson(request, 64 * 1024));
    sendJson(response, result.duplicate ? 200 : 201, result);
  } catch (error) {
    if (error instanceof PlatformBridgeError) {
      sendJson(response, error.status, { error: error.code, message: error.message });
      return;
    }
    throw error;
  }
}

export async function handlePlatformBridgeContext(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: PlatformBridgeRouteDependencies | null,
): Promise<void> {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!dependencies) {
    sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
    return;
  }
  if (!bearerAuthorized(request.headers.authorization, dependencies.configuration.token)) {
    sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
    return;
  }
  try {
    sendJson(response, 200, dependencies.service.context(await readJson(request, 16 * 1024)));
  } catch (error) {
    if (error instanceof PlatformBridgeError) {
      sendJson(response, error.status, { error: error.code, message: error.message });
      return;
    }
    throw error;
  }
}
