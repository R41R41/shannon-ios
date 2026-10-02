import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonDevicePrincipal } from './deviceAuth.js';
import { PRIVATE_LISTENING_LIMITS, PRIVATE_LISTENING_PATH, privateListeningEnabled } from './privateListeningContract.js';
import { dispatchPrivateListeningRequest, type PrivateListeningDependencies } from './privateListeningRoutes.js';
import { SQLitePrivateListeningStore } from './privateListeningStore.js';
import { bindScope, consumeDeviceAllowance, sendJson } from './serverHttp.js';

/**
 * The HTTP side of private listening. The scope is the device token's own, as on every paired route;
 * a fixed-token caller has no device and is refused by the dispatcher.
 */
export interface PrivateListeningRoute {
  /** Answers the request when its path is this route's; otherwise returns false and leaves it alone. */
  handle(request: IncomingMessage, response: ServerResponse, url: URL, body: unknown, principal: ShannonDevicePrincipal | null): boolean;
  close(): void;
}

export function createPrivateListeningRoute(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string, now: () => string,
): PrivateListeningRoute {
  const store = new SQLitePrivateListeningStore(databasePath);
  const dependencies: PrivateListeningDependencies = {
    store, enabled: privateListeningEnabled(environment), ownerScopeKey: environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner', now,
  };
  const usage = new Map<string, { startedAt: number; count: number }>();
  return {
    handle(request, response, url, body, principal) {
      if (url.pathname !== PRIVATE_LISTENING_PATH && !url.pathname.startsWith(`${PRIVATE_LISTENING_PATH}/`)) return false;
      if (principal && !consumeDeviceAllowance(usage, principal.deviceId, PRIVATE_LISTENING_LIMITS.requestsPerMinute)) {
        sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many private-listening requests; retry after a minute.' });
        return true;
      }
      const query = new URLSearchParams(url.searchParams);
      if (principal) query.set('scopeKey', principal.scopeKey);
      const result = dispatchPrivateListeningRequest({
        method: request.method as 'GET' | 'POST' | 'PUT' | 'DELETE', path: url.pathname, query,
        body: principal ? bindScope(body, principal.scopeKey) : body,
        ...(principal ? { deviceId: principal.deviceId } : {}),
      }, dependencies);
      sendJson(response, result.status, result.body);
      return true;
    },
    close: () => store.close(),
  };
}
