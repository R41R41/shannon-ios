import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { evaluateLiveness, LIVENESS_LIMITS, livenessTransitions, type LivenessIncident, type LivenessView } from '../infra/ops/liveness.js';
import { readLivenessFacts, syncLivenessEpisodes } from '../infra/ops/store/livenessStore.js';
import { configuredAutonomyLoop } from '../mind/action/ownTime/autonomyLoopConfig.js';
import { autonomyDayKey } from '../mind/inhibition/autonomyBudget.js';

export interface LivenessMonitorOptions {
  databasePath?: string;
  /** Tests: an open connection instead of a path. */
  database?: DatabaseSync;
  ownerScope: string;
  ownTimeEnabled: boolean;
  /** The own-time time zone (its owner-local day) and the environment its session cap is read from. */
  timeZone?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => string;
  log?: (line: string) => void;
  /** Absent: no timer; `check()` runs only when called. */
  intervalMs?: number | null;
}

/**
 * The periodic "is she still alive" check: a stalled nightly sleep, own time that stopped, and a mind worker that keeps
 * restarting. It logs `Shannon liveness:` once when an incident begins and once when it ends, and the owner reads the
 * latest view in `GET /v1/ops` (`server.liveness`). Its one write is the episode of each incident, from which the existing push
 * path sends the owner one notice per episode (ADR-0009 §9). It starts nothing.
 */
export function startLivenessMonitor(options: LivenessMonitorOptions) {
  if (!options.database && !options.databasePath) throw new Error('LIVENESS_DATABASE_REQUIRED');
  const owned = options.database ? null : openDatabase(options.databasePath!, 'liveness');
  const db = options.database ?? owned!;
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (line => console.log(line));
  const sessionsPerDay = configuredAutonomyLoop(options.environment ?? {}).sessionsPerDay;
  let active = new Set<LivenessIncident>();
  let latest: LivenessView | null = null;
  let closed = false;
  // One owner notice per episode goes out through the push path (ADR-0009 §9); a failed write is retried at the next check.
  function recordEpisodes(incidents: readonly string[], at: string): void {
    try {
      syncLivenessEpisodes(db, options.ownerScope, incidents, at);
    } catch (error) {
      log(`Shannon liveness: episode not recorded ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
  function check(): LivenessView | null {
    if (closed) return latest;
    try {
      const at = now();
      const dayKey = autonomyDayKey(at, { timeZone: options.timeZone ?? 'Asia/Tokyo' });
      const view = evaluateLiveness(readLivenessFacts(db, options.ownerScope, at, dayKey), at, { enabled: options.ownTimeEnabled, sessionsPerDay, dayKey });
      for (const line of livenessTransitions(active, view)) log(line);
      active = new Set(view.incidents);
      latest = view;
      recordEpisodes(view.incidents, at);
    } catch (error) {
      log(`Shannon liveness: check failed ${error instanceof Error ? error.name : 'unknown'}`);
    }
    return latest;
  }
  const interval = options.intervalMs === undefined ? LIVENESS_LIMITS.checkIntervalMs : options.intervalMs;
  const timer = interval ? setInterval(check, interval) : null;
  timer?.unref();
  if (timer) setImmediate(check).unref();
  return {
    check,
    /** Its read connection, lent to the execution metrics of the same ops view (ADR-0009 stage 1). */
    database: db,
    /** The owner's view; refreshed when the last check is older than a minute. */
    view(scopeKey: string): LivenessView | null {
      if (scopeKey !== options.ownerScope) return null;
      if (!latest || Date.parse(now()) - Date.parse(latest.checkedAt) > 60_000) return check();
      return latest;
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      owned?.close();
    },
  };
}

/** Adds `liveness` to the owner's `server` object of `GET /v1/ops`; anything else passes through unchanged. */
export function withLiveness(server: object | null, liveness: LivenessView | null): object | null {
  return server && liveness ? { ...server, liveness } : server;
}
