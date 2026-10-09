import type { OpsMinecraftLifecyclePort } from '../../contracts/opsMinecraftLifecycleContract.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerAuthorized } from '../auth/apiAuth.js';
import { validScopeKey } from '../http/apiValidation.js';
import {
  isOpsCommandReportCode, OPS_COMMAND_LIMITS, OPS_COMMAND_OUTCOMES, opsCommandsAllowed, opsCommandTargetKnown, validatedOpsCommandRequest,
  type OpsCommandAllowed, type OpsCommandOutcome,
} from '../../contracts/opsCommandContract.js';
import type { OpsCommand } from './store/opsCommandStore.js';
import { OPS_LIMITS, type OpsSnapshot } from '../../contracts/opsContract.js';
import type { SQLiteOpsStore } from './store/opsStore.js';
import { consumeDeviceAllowance, readJson, sendJson } from '../http/serverHttp.js';

export const OPS_COMMANDS_PATH = '/v1/ops/commands';
export const OPS_COMMAND_CLAIM_PATH = '/v1/platform/ops/commands/claim';
const REPORT_PATH = /^\/v1\/platform\/ops\/commands\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/report$/u;

export interface OpsCommandRouteDependencies {
  store: SQLiteOpsStore;
  bridge: { token: string; scopeKey: string } | null;
  ingestEnabled: () => boolean;
  /** `SHANNON_PLATFORM_OPS_COMMANDS`. Absent: off. */
  commandsEnabled?: () => boolean;
  minecraftLifecycle?: () => OpsMinecraftLifecyclePort | null;
  now: () => string;
  device: (authorization: string | undefined) => { scopeKey: string | null; deviceId?: string } | null;
}

export function isOpsCommandPath(path: string): boolean {
  return path === OPS_COMMANDS_PATH || path === OPS_COMMAND_CLAIM_PATH || REPORT_PATH.test(path);
}

const instant = (dependencies: Pick<OpsCommandRouteDependencies, 'now'>): string => new Date(Date.parse(dependencies.now())).toISOString();

/** The snapshot a command may be checked against: the latest one, only while ingest is on and it is not stale. */
function currentSnapshot(dependencies: Pick<OpsCommandRouteDependencies, 'store' | 'ingestEnabled' | 'now'>, scopeKey: string): OpsSnapshot | null {
  const stored = dependencies.ingestEnabled() ? dependencies.store.latest(scopeKey) : null;
  if (!stored) return null;
  return Date.parse(dependencies.now()) - Date.parse(stored.receivedAt) <= OPS_LIMITS.staleAfterSeconds * 1000 ? stored.snapshot : null;
}

/** The command part of `GET /v1/ops`. With the switch off the desktop is told to show no control, and nothing is listed. */
export function opsCommandsView(
  dependencies: Pick<OpsCommandRouteDependencies, 'store' | 'ingestEnabled' | 'commandsEnabled' | 'now'>, scopeKey: string,
): { commands: OpsCommand[]; commandsSupported: boolean; allowed: OpsCommandAllowed } {
  const enabled = dependencies.commandsEnabled?.() === true;
  return {
    commands: enabled ? dependencies.store.commands.recent(scopeKey, instant(dependencies)) : [],
    commandsSupported: enabled,
    allowed: opsCommandsAllowed(enabled ? currentSnapshot(dependencies, scopeKey) : null),
  };
}

async function body(request: IncomingMessage, response: ServerResponse): Promise<{ value: unknown } | null> {
  try {
    return { value: await readJson(request, OPS_COMMAND_LIMITS.bodyBytes) };
  } catch (error) {
    if (error instanceof SyntaxError) sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'The body must be JSON.' });
    else if (error instanceof Error && error.message === 'request body too large') sendJson(response, 413, { error: 'REQUEST_TOO_LARGE' });
    else throw error;
    return null;
  }
}

/** A bridge body: an object with `scopeKey` and only the named fields. Returns the refusal message, or null. */
function bridgeBodyRefusal(value: unknown, allowed: readonly string[]): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'JSON object body is required';
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) return `${unknown.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?')} is not allowed`;
  return validScopeKey((value as { scopeKey?: unknown }).scopeKey) ? null : 'scopeKey is required';
}

/**
 * The operations console, stage 2 (`docs/ops-contract.md`). A paired device writes a
 * command; the legacy runtime claims it with the platform bridge credential, performs it,
 * and reports a code. This server starts nothing and calls nothing, and no model is involved.
 */
export function createOpsCommandRoute(dependencies: OpsCommandRouteDependencies) {
  const requestUsage = new Map<string, { startedAt: number; count: number }>();
  const claimUsage = new Map<string, { startedAt: number; count: number }>();
  const reportUsage = new Map<string, { startedAt: number; count: number }>();
  const enabled = () => dependencies.commandsEnabled?.() === true;

  async function create(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    const device = dependencies.device(request.headers.authorization);
    if (!device) return sendJson(response, 401, { error: 'PAIRING_REQUIRED', message: '接続コードでシャノンと接続してください。' });
    if (!enabled()) return sendJson(response, 403, { error: 'OPS_COMMANDS_DISABLED', message: 'Commands are switched off on the server.' });
    const read = await body(request, response);
    if (!read) return;
    const scopeKey = device.scopeKey ?? (read.value as { scopeKey?: unknown } | undefined)?.scopeKey;
    if (!validScopeKey(scopeKey)) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'scopeKey is required' });
    if (!consumeDeviceAllowance(requestUsage, scopeKey, OPS_COMMAND_LIMITS.requestsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many requests; retry after a minute.' });
    }
    const command = validatedOpsCommandRequest(read.value);
    if ('error' in command) return sendJson(response, command.status, { error: command.error, message: command.message });

    if (!enabled()) return sendJson(response, 403, { error: 'OPS_COMMANDS_DISABLED', message: 'Commands are switched off on the server.' });
    const at = instant(dependencies);
    const replayed = dependencies.store.commands.replay(scopeKey, command, at);
    if (replayed && replayed !== 'IDEMPOTENCY_KEY_REUSED') return sendJson(response, 200, replayed);
    if (replayed) return sendJson(response, 409, { error: replayed, message: 'This idempotencyKey already made a different command.' });

    const snapshot = currentSnapshot(dependencies, scopeKey);
    if (!snapshot) {
      return sendJson(response, 409, { error: 'OPS_STALE', message: 'The runtime is not reporting, so it is not there to act.' });
    }
    if (!opsCommandTargetKnown(command, snapshot)) {
      return sendJson(response, 422, { error: 'TARGET_UNKNOWN', message: 'The latest snapshot does not name this target.' });
    }
    const lifecycle = dependencies.minecraftLifecycle?.();
    const created = dependencies.store.commands.create(scopeKey, command, device.deviceId ?? 'local', at, lifecycle?.mapping(scopeKey, command));
    if (created === 'IDEMPOTENCY_KEY_REUSED') return sendJson(response, 409, { error: created, message: 'This idempotencyKey already made a different command.' });
    if (created === 'TOO_MANY_OPEN_COMMANDS') {
      return sendJson(response, 429, { error: created, message: `At most ${OPS_COMMAND_LIMITS.open} commands may be waiting at once.` });
    }
    if (created === 'RATE_LIMITED') {
      return sendJson(response, 429, { error: created, message: `At most ${OPS_COMMAND_LIMITS.perHour} commands an hour are accepted.` });
    }
    sendJson(response, created.created ? 201 : 200, created);
    lifecycle?.wake();
  }

  /** The bridge credential, or the refusal already sent. The scope is the one the credential is bound to. */
  function bridgeScope(request: IncomingMessage, response: ServerResponse): string | null {
    if (request.method !== 'POST') { sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' }); return null; }
    const bridge = dependencies.bridge;
    if (!bridge) { sendJson(response, 503, { error: 'PLATFORM_BRIDGE_NOT_CONFIGURED' }); return null; }
    if (!bearerAuthorized(request.headers.authorization, bridge.token)) { sendJson(response, 401, { error: 'PLATFORM_BRIDGE_UNAUTHORIZED' }); return null; }
    return bridge.scopeKey;
  }

  async function claim(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const scopeKey = bridgeScope(request, response);
    if (scopeKey === null) return;
    if (!consumeDeviceAllowance(claimUsage, scopeKey, OPS_COMMAND_LIMITS.claimsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many claims; poll every ten seconds.' });
    }
    const read = await body(request, response);
    if (!read) return;
    const refusal = bridgeBodyRefusal(read.value, ['scopeKey']);
    if (refusal) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: refusal });
    // Switched off, nothing is handed out; what is waiting expires on its own.
    if (!enabled()) return sendJson(response, 200, { command: null, pollAfterSeconds: OPS_COMMAND_LIMITS.pollAfterSecondsWhenOff });
    sendJson(response, 200, {
      command: dependencies.store.commands.claim(scopeKey, instant(dependencies)),
      pollAfterSeconds: OPS_COMMAND_LIMITS.pollAfterSeconds,
    });
  }

  async function report(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const scopeKey = bridgeScope(request, response);
    if (scopeKey === null) return;
    if (!consumeDeviceAllowance(reportUsage, scopeKey, OPS_COMMAND_LIMITS.reportsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many reports.' });
    }
    const read = await body(request, response);
    if (!read) return;
    const refusal = bridgeBodyRefusal(read.value, ['scopeKey', 'outcome', 'code']);
    if (refusal) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: refusal });
    const { outcome, code } = read.value as { outcome?: unknown; code?: unknown };
    if (!(OPS_COMMAND_OUTCOMES as readonly unknown[]).includes(outcome)) {
      return sendJson(response, 400, { error: 'INVALID_REQUEST', message: `outcome must be one of ${OPS_COMMAND_OUTCOMES.join(', ')}` });
    }
    if (code !== undefined && !isOpsCommandReportCode(code)) return sendJson(response, 400, { error: 'INVALID_REQUEST', message: 'code is invalid' });
    // A report is accepted with the switch off too: a command already claimed still ends truthfully.
    const receipt = dependencies.store.commands.report(scopeKey, id, outcome as OpsCommandOutcome, code, instant(dependencies));
    if (receipt === 'OPS_COMMAND_NOT_FOUND') return sendJson(response, 404, { error: receipt });
    if (typeof receipt === 'string') return sendJson(response, 409, { error: receipt });
    sendJson(response, 200, receipt);
  }

  return async (path: string, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (path === OPS_COMMANDS_PATH) return create(request, response);
    if (path === OPS_COMMAND_CLAIM_PATH) return claim(request, response);
    const id = REPORT_PATH.exec(path)?.[1];
    if (id) return report(request, response, id);
    sendJson(response, 404, { error: 'NOT_FOUND' });
  };
}
