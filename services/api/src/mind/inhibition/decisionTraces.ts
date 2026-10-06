import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cognitionLedgerSwitches } from '@shannon/learning';
import { ownerDay } from '../emotion/companionPresence.js';
import { LockWaitMeter, loggedFailure, tableExists, underWriteLock } from '../../infra/sqlite/lockWaits.js';
import { TRACE_SYMBOL, type DecisionTraceDraft, type DecisionTraceWriter } from './decisionTraceContract.js';
import { DECISION_TRACES_TABLE, SQLiteDecisionTraces } from './store/sqliteDecisionTraces.js';

export type { DecisionTraceDraft, DecisionTraceWriter, TraceAnswer } from './decisionTraceContract.js';
export type { StoredDecisionTrace } from './store/sqliteDecisionTraces.js';

/**
 * Decision traces (Syzygy ADR-0008 §3 抑制系, stage 1: 「判断ごとの記録」). Core: approval and budget (the inhibition part).
 *
 * One content-free row per decision: which decider answered, with which model, how many questions and characters of context
 * it was given, how long it took, whether it fell back and to whom, what it decided as closed enums, and its cost when known.
 * It is kept apart from the activity record (which nothing she can edit may rewrite) and serves finding which part of a
 * decision failed. Nothing reads it back into a prompt, a state or a reply.
 *
 * Writes are deferred (after the caller and its transaction), take the write lock only for the insert, and are measured
 * (`LockWaitMeter`). A failure is logged by name and swallowed. Kept 30 days (owner override 5), pruned at every open of an
 * API store and once a day. `SHANNON_DECISION_TRACES=off` (or `SHANNON_ADR8_STAGE1=off`) creates and records nothing.
 */
export const DECISION_TRACE_RETENTION_DAYS = 30;
const DAY_MILLISECONDS = 24 * 60 * 60_000;

export function decisionTracesEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return cognitionLedgerSwitches(environment).decisionTraces;
}

export interface DecisionTracesOptions {
  database: DatabaseSync;
  /** Only the API's stores create the table and prune; the activity loop's process writes nothing until the table exists. */
  createsSchema: boolean;
  /** When the write runs. Default: `setImmediate` (after the caller). Tests may pass one that runs at once. */
  defer?: (task: () => void) => void;
  now?: () => string;
  log?: (line: string) => void;
}

/** A model name as a closed symbol: anything else is written as `_` so the trace is never lost for it. */
export function traceSymbol(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 96);
  return TRACE_SYMBOL.test(cleaned) ? cleaned : `m_${cleaned}`.slice(0, 96);
}

export class DecisionTraces {
  readonly store: SQLiteDecisionTraces;
  private readonly meter: LockWaitMeter;
  private readonly defer: (task: () => void) => void;
  private readonly now: () => string;
  private present = false;
  private prunedDay: string | null = null;

  constructor(private readonly options: DecisionTracesOptions) {
    this.store = new SQLiteDecisionTraces(options.database, { createSchema: options.createsSchema });
    this.meter = new LockWaitMeter('decision traces', options.log);
    this.defer = options.defer ?? (task => { setImmediate(task); });
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.createsSchema) this.prune(this.now());
  }

  /** The writer a part is handed. */
  get writer(): DecisionTraceWriter { return (scopeKey, draft) => this.record(scopeKey, draft); }

  record(scopeKey: string, draft: DecisionTraceDraft): void {
    const traceId = randomUUID();
    const row = { ...draft, model: traceSymbol(draft.model) };
    this.defer(() => {
      if (!this.options.database.isOpen) return;
      try {
        if (!this.ready()) return;
        const day = ownerDay(row.at);
        underWriteLock(this.options.database, this.meter, day, () => this.store.insert(traceId, scopeKey, row), 'shannon_decision_trace');
        if (this.options.createsSchema && this.prunedDay !== day) this.prune(row.at);
      } catch (error) { loggedFailure('decision trace', error); }
    });
  }

  /** Jev's calls of a month, for the usage summary; null while the table does not exist. */
  jevMonth(scopeKey: string, monthKey: string): ReturnType<SQLiteDecisionTraces['jevMonth']> | null {
    try { return this.ready() ? this.store.jevMonth(scopeKey, monthKey) : null; } catch { return null; }
  }

  /** Logs the lock waits of the day so far (at shutdown, and in tests). */
  flushLockWaits(): void { this.meter.flush(); }

  lockWaits() { return this.meter.summary(); }

  private ready(): boolean {
    if (!this.present) this.present = tableExists(this.options.database, DECISION_TRACES_TABLE);
    return this.present;
  }

  private prune(at: string): void {
    try {
      if (!this.ready()) return;
      const before = new Date(Date.parse(at) - DECISION_TRACE_RETENTION_DAYS * DAY_MILLISECONDS).toISOString();
      underWriteLock(this.options.database, null, ownerDay(at), () => this.store.prune(before), 'shannon_decision_trace');
      this.prunedDay = ownerDay(at);
    } catch (error) { loggedFailure('decision trace prune', error); }
  }
}

/** For a process that holds no store of the API (the activity loop): its own connection, or null under the switches. */
export function configuredDecisionTraces(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string,
): { traces: DecisionTraces; close(): void } | null {
  if (!decisionTracesEnabled(environment)) return null;
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const traces = new DecisionTraces({ database, createsSchema: false });
  return { traces, close: () => { traces.flushLockWaits(); if (database.isOpen) database.close(); } };
}
