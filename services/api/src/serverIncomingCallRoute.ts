import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from './deviceAuth.js';
import { INCOMING_CALL_LIMITS, INCOMING_CALL_PATH, incomingCallsEnabled } from './incomingCallContract.js';
import { dispatchIncomingCallRequest, type IncomingCallRouteDependencies } from './incomingCallRoutes.js';
import { IncomingCalls } from './incomingCalls.js';
import { SQLiteIncomingCallStore } from './incomingCallStore.js';
import { privateReachOutsEnabled } from './privateListeningContract.js';
import { SQLiteReachOutClaims } from './reachOutClaims.js';
import { bindScope, consumeDeviceAllowance, sendJson } from './serverHttp.js';
import { createConfiguredVoipPushSender, type VoipPushSender } from './voipPushSender.js';

/**
 * The HTTP side of a call from Shannon, and the timer that places one (`incomingCalls.ts`).
 *
 * The API process rings: it holds the claim store and answers the device that picks up. Credentials for APNs
 * come from the environment only (`voipPushSender.ts`); without them, or with `SHANNON_INCOMING_CALLS=off`,
 * nothing is rung and the app's settings are told the server is not ready.
 */
export interface IncomingCallRoute {
  /** Answers the request when its path is this route's; otherwise returns false and leaves it alone. */
  handle(request: IncomingMessage, response: ServerResponse, url: URL, body: unknown, principal: ShannonDevicePrincipal | null): boolean;
  calls: IncomingCalls;
  /** A device was unpaired: its call token goes with it. */
  invalidateDevice(deviceId: string): void;
  /** Starts looking for a call she asked for, every two seconds. */
  start(): void;
  close(): void;
}

export interface IncomingCallRouteOptions {
  /** Whether the device still holds a pairing that is neither revoked nor expired: only such a device is rung. */
  isPaired: (scopeKey: string, deviceId: string) => boolean;
  /** Tests hand in a sender that reaches no network. */
  sender?: VoipPushSender;
}

export function createIncomingCallRoute(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string, now: () => string, options: IncomingCallRouteOptions,
): IncomingCallRoute {
  const store = new SQLiteIncomingCallStore(databasePath);
  const claims = new SQLiteReachOutClaims(databasePath);
  const ownerScopeKey = environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner';
  const calls = new IncomingCalls({
    store, claims, sender: options.sender ?? createConfiguredVoipPushSender(environment), ownerScopeKey, now,
    // The claim is what keeps two surfaces from saying one message: with it switched off, nothing is rung either.
    enabled: incomingCallsEnabled(environment) && privateReachOutsEnabled(environment),
    isPaired: options.isPaired,
    log: (event, detail) => console.log(`Shannon incoming call ${event}`, { status: detail.status, ...(detail.reason ? { reason: detail.reason } : {}) }),
  });
  // Her loop, another process, offers the call only while this one can ring: it is told here, once, what this process found.
  try { store.setServerAvailable(calls.available, now()); } catch { /* she is then told by the environment alone */ }
  const dependencies: IncomingCallRouteDependencies = { calls, ownerScopeKey, bundleId: environment.SHANNON_APNS_BUNDLE_ID?.trim() || null };
  const usage = new Map<string, { startedAt: number; count: number }>();
  let timer: NodeJS.Timeout | null = null;
  return {
    calls,
    invalidateDevice: deviceId => store.invalidateDevice(deviceId, now()),
    handle(request, response, url, body, principal) {
      if (!url.pathname.startsWith(`${INCOMING_CALL_PATH}/`)) return false;
      if (principal && !consumeDeviceAllowance(usage, principal.deviceId, INCOMING_CALL_LIMITS.requestsPerMinute)) {
        sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many call requests; retry after a minute.' });
        return true;
      }
      const result = dispatchIncomingCallRequest({
        method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE', path: url.pathname,
        body: principal ? bindScope(body, principal.scopeKey) : body,
        ...(principal ? { deviceId: principal.deviceId } : {}),
      }, dependencies);
      sendJson(response, result.status, result.body);
      return true;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { void calls.tick(); }, INCOMING_CALL_LIMITS.tickMilliseconds);
      timer.unref();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      store.close();
      claims.close();
    },
  };
}
