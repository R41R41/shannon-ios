import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SHANNON_AUTONOMY_SYSTEM_DOMAIN } from '@shannon/cognition';
import type { ApiResponse } from '../contracts/contracts.js';
import { dispatchExecutiveRequest, isExecutivePath } from '../infra/http/executiveRoutes.js';
import { readJson, sendJson } from '../infra/http/serverHttp.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { capabilitiesView, choicesView, goalsView, inspectionView, weekEnding } from '../mind/action/executive/executiveViews.js';
import { ExecutiveReadings } from '../mind/action/executive/store/executiveReadings.js';
import { readActionExecutionCounts } from '../mind/action/threads/store/actionMetrics.js';
import type { ShannonAutonomyService, SQLiteAutonomyStore } from '../mind/action/ownTime/ownTimePorts.js';
import { autonomyDayKey, type AutonomyConfig } from '../mind/inhibition/inhibitionPorts.js';

/**
 * The owner's Executive routes composed (Syzygy ADR-0009 stage 2, E1/E2; `docs/executive-ui-contract.md`): goals and the
 * confirmation from her own time's store, the catalog with the value table's cells, and the counts of 点検 from both databases.
 * Reads only, except the owner's confirmation, which is written with its activity-record entry in one transaction.
 */
export interface ExecutiveRouteOptions {
  path: string;
  ownerScope: string;
  now(): string;
  store: SQLiteShannonStore;
  autonomy: ShannonAutonomyService;
  autonomyStore: SQLiteAutonomyStore;
  config: AutonomyConfig;
  /** `SHANNON_EXECUTIVE` is on (E5). */
  executive?: boolean;
}

export function executiveRouteWiring(options: ExecutiveRouteOptions) {
  const readings = new ExecutiveReadings(options.path);
  const dayKey = (at: string) => autonomyDayKey(at, options.config);
  const pursuits = options.autonomyStore.pursuits;
  const goals = (scopeKey: string, at: string) => goalsView({
    pursuits: (scope, when) => pursuits.list(scope, when), columns: scope => pursuits.goals.columns(scope),
    events: (scope, limit) => pursuits.goals.events(scope, { limit }),
  }, scopeKey, at);
  const confirm = (scopeKey: string, pursuitId: string, at: string): string | null => options.autonomyStore.transaction(() => {
    const before = pursuits.get(scopeKey, pursuitId);
    const result = pursuits.goals.confirmByOwner(scopeKey, pursuitId, at);
    if (typeof result === 'string') return result;
    if (before && before.status !== 'done') {
      options.autonomyStore.activity.append(scopeKey, dayKey(at), at, {
        kind: 'pursuit', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id, outcome: 'recorded', approval: 'not_needed',
        summary: `所有者が「${before.title.slice(0, 60)}」をやり終えたと認めました。`,
      });
    }
    return null;
  });
  const capabilities = (scopeKey: string, at: string) => capabilitiesView(
    {
      paused: safe(() => options.autonomyStore.control(scopeKey).paused, true), aether: options.autonomy.studyAether !== null,
      executive: options.executive === true,
    },
    options.store.valueVersions()?.overview(scopeKey).cells ?? [],
    readings.choiceUses(scopeKey, new Date(Date.parse(at) - 7 * 86_400_000).toISOString()), at);
  const inspection = (scopeKey: string, day: string, at: string) => {
    const days = weekEnding(day);
    const since = new Date(Date.parse(`${days[0]}T00:00:00.000Z`) - 86_400_000).toISOString();
    return inspectionView({
      dayKey, events: pursuits.goals.eventsSince(scopeKey, since), predictions: readings.predictions(scopeKey, since),
      notices: readings.notices(scopeKey, since), sleepRuns: readings.sleepRuns(scopeKey, days),
      spentYen: key => safe(() => options.autonomyStore.spentYen(scopeKey, key), 0), unknownNow: unknownNow(readings.connection(), at),
      deliberations: options.autonomyStore.deliberations.since(scopeKey, since, 2000),
    }, day, at);
  };
  const dependencies = { ownerScopeKey: options.ownerScope, now: options.now, dayKey, goals, confirm, capabilities, inspection,
    choices: (scopeKey: string, days: number, at: string) => choicesView(
      options.autonomyStore.deliberations.since(scopeKey, new Date(Date.parse(at) - days * 86_400_000).toISOString(), 50),
      id => pursuits.get(scopeKey, id)?.title ?? null, days, at) };
  return {
    /** Answers an Executive path (true), or leaves the request to the next route (false). */
    async serve(request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null, url: URL): Promise<boolean> {
      if (!isExecutivePath(url.pathname)) return false;
      const body = request.method === 'POST' ? await readJson(request, 4 * 1024) : undefined;
      const asked = { method: request.method ?? 'GET', path: url.pathname, query: url.searchParams, body };
      const result: ApiResponse = dispatchExecutiveRequest(asked, principal, dependencies);
      sendJson(response, result.status, result.body);
      return true;
    },
    dispatch: (request: Parameters<typeof dispatchExecutiveRequest>[0], principal: { scopeKey: string } | null) =>
      dispatchExecutiveRequest(request, principal, dependencies),
    close: () => readings.close(),
  };
}

function safe<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

/** Actions still unknown and holding their slot, now (ADR-0009 stage 1's gauge); null when the table cannot be read. */
function unknownNow(database: DatabaseSync | null, at: string): number | null {
  if (!database) return null;
  return safe(() => readActionExecutionCounts(database, at).unknownSentOverdue, null);
}
