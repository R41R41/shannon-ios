import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionClock, CompanionStateStore } from '@shannon/cognition';
import { bearerAuthorized } from './apiAuth.js';
import type { TurnBackgroundService } from './backgroundUpdates.js';
import type { ConversationStore } from './conversationStore.js';
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
}

export function isPlatformBridgePath(path: string): boolean {
  return path === SHANNON_PLATFORM_TURN_PATH || path === SHANNON_PLATFORM_CONTEXT_PATH;
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
  await handlePlatformBridgeTurn(request, response, dependencies);
}

export function createConfiguredPlatformBridgeRoute(
  environment: Readonly<Record<string, string | undefined>>,
  stateStore: CompanionStateStore,
  conversationStore: ConversationStore,
  background: TurnBackgroundService,
  now: CompanionClock,
): PlatformBridgeRouteDependencies | null {
  const configuration = configuredPlatformBridge(environment);
  return configuration
    ? { configuration, service: new PlatformBridgeService(configuration, stateStore, conversationStore, background, now) }
    : null;
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
