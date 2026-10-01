import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionClock, CompanionStateStore } from '@shannon/cognition';
import { bearerAuthorized } from './apiAuth.js';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';
import type { ShannonChatModel } from './chatModel.js';
import { placeReply } from './placeDiscovery.js';
import {
  configuredPlatformBridge,
  PlatformBridgeError,
  SHANNON_PLATFORM_CONTEXT_PATH,
  SHANNON_PLATFORM_TURN_PATH,
  type PlatformBridgeConfiguration,
  PlatformBridgeService,
} from './platformBridge.js';
import { readJson, sendJson } from './serverHttp.js';

export interface PlatformBridgeRouteDependencies {
  configuration: PlatformBridgeConfiguration;
  service: PlatformBridgeService;
  chatModel: ShannonChatModel;
}

export const SHANNON_PLATFORM_PLACES_PATH = '/v1/platform/places';

export function isPlatformBridgePath(path: string): boolean {
  return path === SHANNON_PLATFORM_TURN_PATH || path === SHANNON_PLATFORM_CONTEXT_PATH
    || path === SHANNON_PLATFORM_PLACES_PATH;
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
  await handlePlatformBridgeTurn(request, response, dependencies);
}

export function createConfiguredPlatformBridgeRoute(
  environment: Readonly<Record<string, string | undefined>>,
  stateStore: CompanionStateStore,
  conversationStore: ConversationStore,
  background: TurnBackgroundService,
  now: CompanionClock,
  chatModel: ShannonChatModel,
): PlatformBridgeRouteDependencies | null {
  const configuration = configuredPlatformBridge(environment);
  return configuration
    ? { configuration, chatModel, service: new PlatformBridgeService(configuration, stateStore, conversationStore, background, now) }
    : null;
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
