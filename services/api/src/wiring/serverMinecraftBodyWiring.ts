import { MINECRAFT_LIFECYCLE_PATH } from '../contracts/minecraftLifecycleContract.js';
import type { MinecraftLifecycle } from '../surfaces/minecraft/minecraftLifecycle.js';
import { MINECRAFT_CONTROL_PATH } from '../contracts/minecraftControlContract.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type { MinecraftBodyDependencies } from '../surfaces/minecraft/minecraftBody.js';
import type { MinecraftPrimaryModelReader } from '../contracts/minecraftPrimaryModelContract.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from '../infra/auth/deviceAuth.js';
import { namesDesktopBody } from '../mind/inhibition/desktopBodyIdentity.js';
import { SQLiteGameExperiences } from '../mind/memory/store/gameExperiences.js';
import { configuredMinecraftBody } from '../contracts/minecraftBodyContract.js';
import { MinecraftBodyRequests } from '../surfaces/minecraft/minecraftBodyRequests.js';
import { readJson, sendJson } from '../infra/http/serverHttp.js';
import type { MinecraftBodyRoute } from '../surfaces/minecraft/serverMinecraftBodyRoute.js';
import { createMinecraftBodyRoute } from './minecraftBodyRouteWiring.js';

/** Every route of her Minecraft body (`docs/minecraft-body-contract.md`). */
export const MINECRAFT_BODY_ROUTE_PREFIX = '/v1/body/minecraft/';

/**
 * What the device of `SHANNON_MINECRAFT_BODY_JSON` may call (review S1, 2026-10-06): its own routes, game events, and the
 * presence read. Its token is a paired device's, so without this it could do what the owner's apps do (his chat, her
 * study and folder, his memory); everything else answers `403 GAME_BODY_DEVICE_DENIED`.
 */
export function gameBodyMayCall(method: string | undefined, path: string): boolean {
  return path.startsWith(MINECRAFT_BODY_ROUTE_PREFIX)
    || (method === 'POST' && path === '/v1/body/events') || (method === 'GET' && path === '/v1/body/presence');
}

type RouteDependencies = Omit<Parameters<typeof createMinecraftBodyRoute>[2], 'requests'>;

/**
 * Her Minecraft body as the server wires it: its game experiences, the request queue her tools and the owner's game chat
 * fill (phase 4), the game-chat route, and the gate on its device token. `SHANNON_MINECRAFT_BODY_JSON` unset: none of it
 * exists, its routes answer 503, and no device is held back.
 */
export function createMinecraftBodyWiring(environment: Readonly<Record<string, string | undefined>>, databasePath: string, now: () => string, primaryModel?: MinecraftPrimaryModelReader) {
  const commonMode = environment.SHANNON_FCA_MINECRAFT === 'on';
  const configuration = configuredMinecraftBody(environment);
  const experiences = configuration ? new SQLiteGameExperiences(databasePath) : null;
  const requests = configuration && !commonMode ? new MinecraftBodyRequests(databasePath, configuration, now, experiences, undefined, primaryModel) : null;
  const stopMaintenance = requests?.startMaintenance() ?? (() => {});
  const isGameBody = (principal: ShannonDevicePrincipal | null) => Boolean(configuration && principal?.deviceId === configuration.deviceId);
  let route: MinecraftBodyRoute | null = null;
  let lifecycle: MinecraftLifecycle | null = null;
  let common: { control: MinecraftControl; intent: NonNullable<MinecraftBodyDependencies['fcaIntent']> } | null = null;
  if (commonMode && (!configuration || environment.SHANNON_FCA_RUNTIME !== 'on')) throw new Error('FCA_MINECRAFT_CONFIG_REQUIRED');
  return {
    configuration,
    connectLifecycle(value: MinecraftLifecycle): void { lifecycle = value; },
    connectControl(value: NonNullable<typeof common>): void { common = value; },
    requests,
    /** Her Minecraft body's token: never given a desktop-body identity (`desktopBodyIdentity.ts`). */
    isGameDevice: isGameBody,
    /** `ShannonBodyOptions.game`: the one device whose game events are taken. */
    game: configuration ? { deviceId: configuration.deviceId, ownerScopeKey: configuration.ownerScopeKey, experiences } : null,
    /** The game-chat route, once the conversation kernel it answers through exists. */
    connect(dependencies: RouteDependencies): void {
      route = createMinecraftBodyRoute(environment, databasePath, { ...dependencies, requests: commonMode ? null : requests, ...(commonMode ? { fcaIntent: input => common ? common.intent(input) : Promise.resolve({ kind: 'none' as const, goal: '', rejected: 'queue_unavailable' as const }) } : {}) });
    },
    /** The operations console authenticates on its own: her Minecraft body's token is refused there before it is read. */
    refusesConsole(request: IncomingMessage, response: ServerResponse, devices: { authenticate(authorization: string | undefined): ShannonDevicePrincipal | null } | null): boolean {
      if (!configuration || !devices || !isGameBody(devices.authenticate(request.headers.authorization))) return false;
      sendJson(response, 403, { error: 'GAME_BODY_DEVICE_DENIED', message: 'Her Minecraft body may call its own routes, game events and presence only.' });
      return true;
    },
    /**
     * After authentication: refuses her Minecraft body's token outside its routes, and answers those routes (reading the
     * body itself). True when it answered.
     */
    async serve(request: IncomingMessage, response: ServerResponse, path: string, principal: ShannonDevicePrincipal | null): Promise<boolean> {
      // Never as another body either: the header that gives an app's desktop body a device of its own is refused.
      if (isGameBody(principal) && (!gameBodyMayCall(request.method, path) || namesDesktopBody(request.headers['x-shannon-body']))) {
        sendJson(response, 403, { error: 'GAME_BODY_DEVICE_DENIED', message: 'Her Minecraft body may call its own routes, game events and presence only.' });
        return true;
      }
      if (!path.startsWith(MINECRAFT_BODY_ROUTE_PREFIX)) return false;
      if (path === MINECRAFT_LIFECYCLE_PATH || path === `${MINECRAFT_LIFECYCLE_PATH}/permit`) {
        if (request.method !== 'POST') sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        else if (!principal || !isGameBody(principal)) sendJson(response, 403, { error: 'MINECRAFT_LIFECYCLE_DEVICE_DENIED' });
        else if (!lifecycle) sendJson(response, 503, { error: 'MINECRAFT_LIFECYCLE_NOT_ENABLED' });
        else {
          const input = await readJson(request, 64 * 1024);
          try {
            if (path.endsWith('/permit')) {
              if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join() !== 'id' || typeof (input as {id?:unknown}).id !== 'string') throw new Error('INVALID');
              sendJson(response, 200, { allowed: lifecycle.authorize(principal, (input as {id:string}).id) });
            } else sendJson(response, 200, lifecycle.poll(principal, input));
          } catch { sendJson(response, 400, { error: 'MINECRAFT_LIFECYCLE_INPUT_INVALID' }); }
        }
        return true;
      }
      if (path === MINECRAFT_CONTROL_PATH) {
        if (request.method !== 'POST') sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        else if (!principal || !isGameBody(principal)) sendJson(response, 403, { error: 'FCA_BODY_DEVICE_DENIED' });
        else if (!commonMode || !common) sendJson(response, 503, { error: 'FCA_BODY_NOT_ENABLED' });
        else {
          const input = await readJson(request, 1024 * 1024);
          try { sendJson(response, 200, common.control.poll(principal, input)); }
          catch { sendJson(response, 400, { error: 'FCA_BODY_POLL_INVALID' }); }
        }
        return true;
      }
      const body = request.method === 'POST' ? await readJson(request, 64 * 1024) : undefined;
      if (!route || !(await route.handle(request, response, path, body, principal))) sendJson(response, 404, { error: 'NOT_FOUND' });
      return true;
    },
    close(): void {
      route?.close();
      experiences?.close();
      stopMaintenance();
      requests?.close();
    },
  };
}
