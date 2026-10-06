import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BodyReachOutDeliveryOutcome } from '../../contracts/bodyContract.js';
import type { ShannonDevicePrincipal } from '../../deviceAuth.js';
import {
  PRIVATE_LISTENING_LIMITS, PRIVATE_LISTENING_PATH, privateListeningEnabled, privateReachOutListenSeconds, privateReachOutsEnabled,
} from '../../contracts/privateListeningContract.js';
import { dispatchPrivateListeningRequest, type PrivateListeningDependencies } from './privateListeningRoutes.js';
import { SQLitePrivateListeningStore } from './store/privateListeningStore.js';
import { PrivateReachOuts } from '../outreach/privateReachOuts.js';
import { SQLiteReachOutClaims } from '../outreach/store/reachOutClaims.js';
import type { ReachOutReportResult, SQLiteReachOutReports } from '../outreach/store/reachOutReports.js';
import { bindScope, consumeDeviceAllowance, sendJson } from '../../serverHttp.js';

/**
 * The HTTP side of private listening. The scope is the device token's own, as on every paired route;
 * a fixed-token caller has no device and is refused by the dispatcher.
 */
export interface PrivateListeningRoute {
  /** Answers the request when its path is this route's; otherwise returns false and leaves it alone. */
  handle(request: IncomingMessage, response: ServerResponse, url: URL, body: unknown, principal: ShannonDevicePrincipal | null): boolean;
  /** Which surface says a message she started on her own: what her body is told, and what it reported (`privateReachOuts.ts`). */
  reachOuts: PrivateReachOuts;
  /** Her body's report store, with a body that did not show a message giving it back to the apps. */
  bodyReports: Pick<SQLiteReachOutReports, 'report' | 'markPresence'>;
  close(): void;
}

export interface PrivateListeningRouteOptions {
  reports: SQLiteReachOutReports;
  /** `SHANNON_AUTONOMY_MAX_FOLLOW_UPS` above zero: whether deliveries are kept for her to observe. */
  reportsEnabled: boolean;
  isBody: (scopeKey: string, deviceId: string) => boolean;
  /** A call from her that a device answered (`serverIncomingCallRoute.ts`); created after this route, so it is asked for when needed. */
  calls?: PrivateListeningDependencies['calls'];
}

export function createPrivateListeningRoute(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string, now: () => string, options: PrivateListeningRouteOptions,
): PrivateListeningRoute {
  const store = new SQLitePrivateListeningStore(databasePath);
  const claims = new SQLiteReachOutClaims(databasePath);
  const reachOuts = new PrivateReachOuts({
    listening: store, claims, reports: options.reports, isBody: options.isBody, enabled: privateReachOutsEnabled(environment),
    reportsEnabled: options.reportsEnabled, listenSeconds: privateReachOutListenSeconds(environment), now,
  });
  const dependencies: PrivateListeningDependencies = {
    store, enabled: privateListeningEnabled(environment), ownerScopeKey: environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner', reachOuts, now,
    ...(options.calls ? { calls: options.calls } : {}),
  };
  const usage = new Map<string, { startedAt: number; count: number }>();
  return {
    reachOuts,
    bodyReports: {
      report: (scopeKey: string, deviceId: string, initiativeId: string, outcome: BodyReachOutDeliveryOutcome, at: string): ReachOutReportResult =>
        reachOuts.bodyReported(scopeKey, deviceId, initiativeId, outcome, at),
      markPresence: (scopeKey, deviceId, at) => options.reports.markPresence(scopeKey, deviceId, at),
    },
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
    close: () => { store.close(); claims.close(); },
  };
}
