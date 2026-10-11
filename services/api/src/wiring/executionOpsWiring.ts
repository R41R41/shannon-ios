import type { DatabaseSync } from 'node:sqlite';
import type { ActionSchedulerMetrics, ActionThreads } from '../contracts/actionThreadContract.js';
import type { LivenessView } from '../infra/ops/liveness.js';
import { cacheDayLine, cacheReceiptsView } from '../infra/models/anthropic/cacheReceipts.js';
import { rejectionCounts } from '../infra/models/anthropic/anthropicRejection.js';
import { readActionExecutionCounts, type ActionExecutionCounts } from '../mind/action/threads/store/actionMetrics.js';
import { countTasksUnknownSince } from '../mind/action/taskRuntime/store/taskUnknownMetrics.js';

/** An unknown older than this counts as a backlog (ADR-0009 stage 1, acceptance §4). */
export const EXECUTION_UNKNOWN_BACKLOG_MS = 10 * 60_000;
const CHECK_INTERVAL_MS = 10 * 60_000;

/** What `GET /v1/ops` shows of the execution (`server.execution`). Closed counts and timestamps only. */
export interface ExecutionView {
  checkedAt: string;
  unknownBacklog: { actions: number; tasks: number };
  liveActionsByKind: Readonly<Record<string, number>>;
  claimRefusals: { since: string | null; byReason: Readonly<Record<string, number>> };
  sharedResources: number;
  multiSegmentTasks: number;
  /** Keys still retained after an unknown release (ADR-0009 §9), and the age of the oldest in minutes. */
  retained: { held: number; oldestAt: string | null; oldestAgeMinutes: number | null };
  sleepLastCompletedAt: string | null;
  ownTimeLastSessionAt: string | null;
  modelRequestRejections: Readonly<Record<string, number>>;
}

export interface ExecutionMonitorOptions {
  /** A read connection the caller owns (the liveness check's); the monitor never closes it. */
  database: DatabaseSync;
  /** The mind worker's scheduler, through which its in-process claim refusals are read. */
  scheduler(): Pick<ActionThreads, 'metrics'> | null;
  /** The latest liveness view, for the last completed sleep and the last own-time session. */
  liveness(): LivenessView | null;
  now?(): string;
  log?(line: string): void;
  /** Absent: the default; null: no timer (tests call `check`). */
  intervalMs?: number | null;
}

const EMPTY_COUNTS: ActionExecutionCounts = {
  unknownSentOverdue: 0,
  liveByKind: {},
  sharedResources: 0,
  multiSegmentTasks: 0,
  retained: { held: 0, oldestAt: null },
};

function ageMinutes(since: string | null, at: string): number | null {
  return since ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(since)) / 60_000)) : null;
}

function pairs(record: Readonly<Record<string, number>>): string {
  const entries = Object.entries(record);
  return entries.length ? entries.map(([key, value]) => `${key}:${value}`).join(',') : 'none';
}

/** The compact daily log line: counts and closed codes only. */
export function executionDailyLine(view: ExecutionView, cacheDay: string): string {
  return [
    'Shannon execution daily:',
    `unknownActions=${view.unknownBacklog.actions}`,
    `unknownTasks=${view.unknownBacklog.tasks}`,
    `live=${pairs(view.liveActionsByKind)}`,
    `refusals=${pairs(view.claimRefusals.byReason)}`,
    `sharedResources=${view.sharedResources}`,
    `multiSegmentTasks=${view.multiSegmentTasks}`,
    `retained=${view.retained.held}`,
    `sleepCompleted=${view.sleepLastCompletedAt ?? 'none'}`,
    `ownTimeSession=${view.ownTimeLastSessionAt ?? 'none'}`,
    `cacheReadTurns=${cacheDayLine(cacheDay)}`,
    `rejections=${pairs(view.modelRequestRejections)}`,
  ].join(' ');
}

/**
 * The execution metrics of ADR-0009 stage 1 for the owner's `GET /v1/ops`, read through the stores that own each table, and
 * one compact line in the log each day. It writes nothing and starts nothing.
 */
export function startExecutionMonitor(options: ExecutionMonitorOptions) {
  const db = options.database;
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (line => console.log(line));
  let scheduler: ActionSchedulerMetrics | null = null;
  let refreshing = false;
  let loggedDay: string | null = null;
  let closed = false;

  function refreshScheduler(): void {
    const source = options.scheduler();
    if (!source?.metrics || refreshing) return;
    refreshing = true;
    source.metrics()
      .then(metrics => { scheduler = metrics; })
      .catch(() => { /* The scheduler is away; the last reading stays. */ })
      .finally(() => { refreshing = false; });
  }

  function counts(cutoff: string): { actions: ActionExecutionCounts; tasks: number } {
    try {
      return { actions: readActionExecutionCounts(db, cutoff), tasks: countTasksUnknownSince(db, cutoff) };
    } catch {
      return { actions: EMPTY_COUNTS, tasks: 0 };
    }
  }

  function view(): ExecutionView {
    refreshScheduler();
    const at = now();
    const read = counts(new Date(Date.parse(at) - EXECUTION_UNKNOWN_BACKLOG_MS).toISOString());
    const liveness = options.liveness();
    return {
      checkedAt: at,
      unknownBacklog: { actions: read.actions.unknownSentOverdue, tasks: read.tasks },
      liveActionsByKind: read.actions.liveByKind,
      claimRefusals: { since: scheduler?.since ?? null, byReason: scheduler?.claimRefusals ?? {} },
      sharedResources: read.actions.sharedResources,
      multiSegmentTasks: read.actions.multiSegmentTasks,
      retained: { ...read.actions.retained, oldestAgeMinutes: ageMinutes(read.actions.retained.oldestAt, at) },
      sleepLastCompletedAt: liveness?.sleep.lastCompletedAt ?? null,
      ownTimeLastSessionAt: liveness?.ownTime.lastSessionAt ?? null,
      modelRequestRejections: rejectionCounts(),
    };
  }

  /** Logs the line once a (UTC) day: at the first check, and when the day changes, for the day that ended. */
  function check(): void {
    if (closed) return;
    const current = view();
    const today = current.checkedAt.slice(0, 10);
    if (loggedDay === today) return;
    log(executionDailyLine(current, loggedDay ?? today));
    loggedDay = today;
  }

  const interval = options.intervalMs === undefined ? CHECK_INTERVAL_MS : options.intervalMs;
  const timer = interval ? setInterval(check, interval) : null;
  timer?.unref();
  if (timer) setImmediate(check).unref();
  function close(): void {
    closed = true;
    if (timer) clearInterval(timer);
  }
  return { view, check, modelCache: () => cacheReceiptsView(), close };
}

/** Adds `execution` and `modelCache` to the owner's `server` object of `GET /v1/ops`; anything else passes through. */
export function withExecution(server: object | null, execution: ExecutionView, modelCache: object): object | null {
  return server ? { ...server, execution, modelCache } : server;
}
