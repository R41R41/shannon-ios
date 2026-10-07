import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionClock, CompanionStateStore } from '@shannon/cognition';
import type { TurnBackgroundService } from '../../mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel } from '../../infra/models/chatModel.js';
import type { ConversationStore } from '../../mind/memory/store/conversationStore.js';
import type { ShannonDevicePrincipal } from '../../infra/auth/deviceAuth.js';
import { MinecraftBody, type MinecraftConversation } from './minecraftBody.js';
import { MINECRAFT_BODY_LIMITS, MINECRAFT_BODY_TURN_PATH, MinecraftBodyError, configuredMinecraftBody, type MinecraftBodyConfiguration } from '../../contracts/minecraftBodyContract.js';
import { SQLiteMinecraftTurnLog } from './store/minecraftTurnStore.js';
import type { PeopleMemoryStore } from '../../mind/memory/store/peopleMemoryStore.js';
import { platformPeopleEnabled } from '../platform/platformPeople.js';
import type { MemoryProposals } from '../../mind/memory/memoryPorts.js';
import { consumeDeviceAllowance, sendJson } from '../../infra/http/serverHttp.js';
import { closedSignal } from '../../infra/http/apiAutonomyHostStepRoutes.js';
import type { MinecraftBodyRequests } from './minecraftBodyRequests.js';
import { MINECRAFT_REQUEST_LIMITS, MINECRAFT_REQUEST_PATHS, validClaim, validProgress, validReport } from '../../contracts/minecraftBodyRequestContract.js';

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
    /** Syzygy ADR-0008 stage 3 (F5): the memory outbox (absent: switched off). */
    memory?: MemoryProposals | null;
  },
): MinecraftBodyRoute {
  const configuration = configuredMinecraftBody(environment);
  const turns = configuration ? new SQLiteMinecraftTurnLog(databasePath) : null;
  const requests = configuration ? dependencies.requests ?? null : null;
  const service = configuration && turns
    ? new MinecraftBody({ ...dependencies, configuration, turns, requests, peopleEnabled: () => platformPeopleEnabled(environment) }) : null;
  return minecraftBodyRoute(service, configuration, () => turns?.close(), requests);
}

/** The route around a service, also for tests. */
export function minecraftBodyRoute(service: MinecraftBody | null, configuration: MinecraftBodyConfiguration | null, close: () => void = () => {},
  requests: MinecraftBodyRequests | null = null): MinecraftBodyRoute {
  const requestUsage = new Map<string, { startedAt: number; count: number }>();
  const usage = new Map<string, { startedAt: number; count: number }>();
  return {
    configuration,
    close,
    async handle(request, response, path, body, principal) {
      if (isRequestPath(path)) {
        await handleRequests(request, response, path, body, principal, configuration, requests, requestUsage);
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

function isRequestPath(path: string): boolean {
  return path === MINECRAFT_REQUEST_PATHS.claim || path === MINECRAFT_REQUEST_PATHS.list
    || MINECRAFT_REQUEST_PATHS.progress.test(path) || MINECRAFT_REQUEST_PATHS.report.test(path) || MINECRAFT_REQUEST_PATHS.cancel.test(path);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Phase 4 (`docs/minecraft-body-contract.md`, "Requests"). The body's routes (claim, progress, report) take the
 * configured device only; the owner's routes (list, cancel) take any other paired device of the owner's scope. The
 * device is its token, never the body.
 */
async function handleRequests(
  request: IncomingMessage, response: ServerResponse, path: string, body: unknown, principal: ShannonDevicePrincipal | null,
  configuration: MinecraftBodyConfiguration | null, requests: MinecraftBodyRequests | null, usage: Map<string, { startedAt: number; count: number }>,
): Promise<void> {
  const deny = (status: number, error: string, message: string) => sendJson(response, status, { error, message });
  if (!configuration || !requests) return deny(503, 'MINECRAFT_BODY_NOT_CONFIGURED', 'Her Minecraft body is not configured.');
  if (!principal) return deny(403, 'MINECRAFT_BODY_DEVICE_DENIED', 'A paired device token is required.');
  if (principal.scopeKey !== configuration.ownerScopeKey) return deny(403, 'MINECRAFT_BODY_SCOPE_DENIED', 'Her Minecraft body is the owner\'s.');
  if (!consumeDeviceAllowance(usage, principal.deviceId, MINECRAFT_REQUEST_LIMITS.requestsPerMinute)) return deny(429, 'RATE_LIMITED', 'Too many requests; retry after a minute.');
  const isBody = principal.deviceId === configuration.deviceId;
  const scopeKey = principal.scopeKey;

  // The owner's side: his apps read and cancel; the body itself does neither.
  if (path === MINECRAFT_REQUEST_PATHS.list) {
    if (request.method !== 'GET') return deny(405, 'METHOD_NOT_ALLOWED', 'GET only.');
    if (isBody) return deny(403, 'MINECRAFT_OWNER_ONLY', 'The body does not read the owner\'s list.');
    return sendJson(response, 200, { present: requests.present(scopeKey), requests: requests.recent(scopeKey, 20).map(item => ({ ...item, origin: { surface: item.origin.surface } })) });
  }
  if (request.method !== 'POST') return deny(405, 'METHOD_NOT_ALLOWED', 'POST only.');
  if (!isRecord(body)) return deny(400, 'BAD_REQUEST', 'JSON object body is required');
  const cancelMatch = path.match(MINECRAFT_REQUEST_PATHS.cancel);
  if (cancelMatch) {
    if (isBody) return deny(403, 'MINECRAFT_OWNER_ONLY', 'The body reports a stop; it does not cancel.');
    const unknown = Object.keys(body).find(key => key !== 'scopeKey');
    if (unknown) return deny(400, 'BAD_REQUEST', `${unknown.slice(0, 40)} is not allowed`);
    const result = requests.cancel(scopeKey, cancelMatch[1]!);
    if (result === 'NOT_FOUND') return deny(404, 'MINECRAFT_REQUEST_NOT_FOUND', 'No such request.');
    if (result === 'FINISHED') return deny(409, 'MINECRAFT_REQUEST_FINISHED', 'The request has already finished.');
    return sendJson(response, 200, { id: result.id, state: result.state, cancelRequested: result.cancelRequested });
  }

  // The body's side.
  if (!isBody) return deny(403, 'MINECRAFT_BODY_DEVICE_DENIED', 'This device is not her Minecraft body.');
  if (path === MINECRAFT_REQUEST_PATHS.claim) {
    const claim = validClaim(body);
    if (typeof claim === 'string') return deny(400, 'BAD_REQUEST', claim);
    const answer = await requests.claim(scopeKey, principal.deviceId, claim, closedSignal(response));
    if (answer === 'DEVICE_DENIED') return deny(403, 'MINECRAFT_BODY_DEVICE_DENIED', 'This device is not her Minecraft body.');
    if (answer === 'SCOPE_DENIED') return deny(403, 'MINECRAFT_BODY_SCOPE_DENIED', 'Her Minecraft body is the owner\'s.');
    if (!response.writableEnded && !response.destroyed) sendJson(response, 200, answer);
    return;
  }
  const progressMatch = path.match(MINECRAFT_REQUEST_PATHS.progress);
  if (progressMatch) {
    const progress = validProgress(body);
    if (typeof progress === 'string') return deny(400, 'BAD_REQUEST', progress);
    const answer = requests.progress(scopeKey, principal.deviceId, progressMatch[1]!, progress);
    return answer === 'NOT_FOUND' ? deny(404, 'MINECRAFT_REQUEST_NOT_FOUND', 'No such request was handed to this device.') : sendJson(response, 200, answer);
  }
  const reportMatch = path.match(MINECRAFT_REQUEST_PATHS.report)!;
  const report = validReport(body);
  if (typeof report === 'string') return deny(400, 'BAD_REQUEST', report);
  const answer = requests.report(scopeKey, principal.deviceId, reportMatch[1]!, report);
  return answer === 'NOT_FOUND' ? deny(404, 'MINECRAFT_REQUEST_NOT_FOUND', 'No such request was handed to this device.') : sendJson(response, 200, answer);
}
