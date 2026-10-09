import type { OpsMinecraftLifecyclePort } from '../../contracts/opsMinecraftLifecycleContract.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerAuthorized } from '../auth/apiAuth.js';
import { validScopeKey } from '../http/apiValidation.js';
import { OPS_LIMITS, OPS_SCHEMA_VERSION, validatedOpsSnapshot, type OpsSnapshot } from '../../contracts/opsContract.js';
import type { OpsCommandAllowed } from '../../contracts/opsCommandContract.js';
import type { OpsCommand } from './store/opsCommandStore.js';
import type { SQLiteOpsStore } from './store/opsStore.js';
import { createOpsCommandRoute, isOpsCommandPath, opsCommandsView } from './serverOpsCommandRoutes.js';
import { consumeDeviceAllowance, readJson, sendJson } from '../http/serverHttp.js';

export const OPS_SNAPSHOT_PATH = '/v1/platform/ops/snapshot';
export const OPS_READ_PATH = '/v1/ops';

export interface OpsRouteDependencies {
  store: SQLiteOpsStore;
  /** The platform bridge credential and the owner scope it is bound to; null when the bridge is not configured. */
  bridge: { token: string; scopeKey: string } | null;
  ingestEnabled: () => boolean;
  /** Stage 2 kill switch (`SHANNON_PLATFORM_OPS_COMMANDS`). Absent: commands are off. */
  commandsEnabled?: () => boolean;
  minecraftLifecycle?: () => OpsMinecraftLifecyclePort | null;
  now: () => string;
  /**
   * Who a device credential is. Null: not a paired device (or not the local token).
   * `scopeKey: null`: a fixed local token, which names the scope in the query.
   */
  device: (authorization: string | undefined) => { scopeKey: string | null; deviceId?: string } | null;
  /**
   * The server's description of itself (`serverSelfDiagnosis.ts`) for a scope: names, counts, a hash and booleans.
   * Null for any scope but the owner's; the field is then absent. Absent: never shown.
   */
  server?: (scopeKey: string) => object | null;
}

export interface OpsReadResponse {
  schemaVersion: number;
  snapshot: OpsSnapshot | null;
  receivedAt: string | null;
  stale: boolean;
  staleAfterSeconds: number;
  /** Stage 2: the recent commands, newest first. Empty while commands are switched off. */
  commands: OpsCommand[];
  commandsSupported: boolean;
  /** Stage 2: what a command would be accepted for right now. A client shows only these controls. */
  allowed: OpsCommandAllowed;
  /** This API's own models, persona hash, tools, revision and integrations. Only for the owner's scope; absent otherwise. */
  server?: object;
}

export function isOpsPath(path: string): boolean {
  return path === OPS_SNAPSHOT_PATH || path === OPS_READ_PATH || isOpsCommandPath(path);
}

/**
 * The operations console (`docs/ops-contract.md`): the legacy runtime pushes a snapshot
 * with the platform bridge credential, and a paired device reads the latest one. Commands
 * (stage 2) are in `serverOpsCommandRoutes.ts`. Nothing here calls a model, starts
 * anything, or passes the snapshot to another module.
 */
export function createOpsRoute(dependencies: OpsRouteDependencies) {
  const snapshotUsage = new Map<string, { startedAt: number; count: number }>();
  const readUsage = new Map<string, { startedAt: number; count: number }>();
  const commandRoute = createOpsCommandRoute(dependencies);

  async function report(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    const bridge = dependencies.bridge;
    if (!bridge) return sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' });
    if (!bearerAuthorized(request.headers.authorization, bridge.token)) {
      return sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' });
    }
    if (!dependencies.ingestEnabled()) {
      return sendJson(response, 403, { error: 'OPS_INGEST_DISABLED', message: 'Operational snapshots are switched off on the server.' });
    }
    if (!consumeDeviceAllowance(snapshotUsage, bridge.scopeKey, OPS_LIMITS.snapshotsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many snapshots; report once a minute.' });
    }
    let body: unknown;
    try {
      body = await readJson(request, OPS_LIMITS.bodyBytes);
    } catch (error) {
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: 'OPS_SNAPSHOT_INVALID', message: 'The body must be JSON.' });
      if (error instanceof Error && error.message === 'request body too large') {
        return sendJson(response, 413, { error: 'REQUEST_TOO_LARGE', message: 'A snapshot is at most 64 KiB.' });
      }
      throw error;
    }
    const snapshot = validatedOpsSnapshot(body);
    if (typeof snapshot === 'string') return sendJson(response, 400, { error: 'OPS_SNAPSHOT_INVALID', message: snapshot });
    const receivedAt = dependencies.now();
    // The scope is the one the bridge credential is bound to, never the one the caller names.
    dependencies.store.replace(bridge.scopeKey, OPS_SCHEMA_VERSION, snapshot, receivedAt);
    sendJson(response, 200, {
      schemaVersion: OPS_SCHEMA_VERSION, receivedAt,
      reportAfterSeconds: OPS_LIMITS.reportAfterSeconds, staleAfterSeconds: OPS_LIMITS.staleAfterSeconds,
    });
  }

  function read(request: IncomingMessage, response: ServerResponse, query: URLSearchParams): void {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    const device = dependencies.device(request.headers.authorization);
    if (!device) return sendJson(response, 401, { error: 'PAIRING_REQUIRED', message: '接続コードでシャノンと接続してください。' });
    const scopeKey = device.scopeKey ?? query.get('scopeKey');
    if (!validScopeKey(scopeKey)) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'scopeKey is required' });
    if (!consumeDeviceAllowance(readUsage, scopeKey, OPS_LIMITS.readsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many requests; retry after a minute.' });
    }
    sendJson(response, 200, opsReadResponse(dependencies, scopeKey));
  }

  return async (path: string, request: IncomingMessage, response: ServerResponse, query: URLSearchParams): Promise<void> => {
    if (path === OPS_SNAPSHOT_PATH) await report(request, response);
    else if (isOpsCommandPath(path)) await commandRoute(path, request, response);
    else read(request, response, query);
  };
}

/** What a device reads. With ingest off, or before any report, the snapshot and its time are null. */
export function opsReadResponse(
  dependencies: Pick<OpsRouteDependencies, 'store' | 'ingestEnabled' | 'commandsEnabled' | 'now' | 'server'>, scopeKey: string,
): OpsReadResponse {
  const server = dependencies.server?.(scopeKey) ?? null;
  const stored = dependencies.ingestEnabled() ? dependencies.store.latest(scopeKey) : null;
  const ageMs = stored ? Date.parse(dependencies.now()) - Date.parse(stored.receivedAt) : Number.POSITIVE_INFINITY;
  return {
    schemaVersion: OPS_SCHEMA_VERSION,
    snapshot: stored?.snapshot ?? null,
    receivedAt: stored?.receivedAt ?? null,
    stale: !(ageMs <= OPS_LIMITS.staleAfterSeconds * 1000),
    staleAfterSeconds: OPS_LIMITS.staleAfterSeconds,
    ...opsCommandsView(dependencies, scopeKey),
    ...(server ? { server } : {}),
  };
}
